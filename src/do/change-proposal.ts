import { ChangeProposal, Claim, Attestation } from '../types';

export class ChangeProposalDO {
  private state: DurableObjectState;
  private proposal: ChangeProposal | null = null;
  private sseConnections: Set<WritableStreamDefaultWriter<any>> = new Set();

  constructor(state: DurableObjectState) {
    this.state = state;
    // Load persisted state asynchronously
    this.state.blockConcurrencyWhile(async () => {
      this.proposal = (await this.state.storage.get<ChangeProposal>('proposal')) || null;
    });
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    // 1. Initialize proposal
    if (url.pathname === '/init' && request.method === 'POST') {
      const body = await request.json<Partial<ChangeProposal>>();
      this.proposal = {
        id: body.id!,
        baselineRepo: body.baselineRepo!,
        forkRepo: body.forkRepo!,
        agentId: body.agentId!,
        taskRef: body.taskRef!,
        status: 'claiming',
        claims: [],
        attestations: [],
        baselineParentSha: body.baselineParentSha,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      await this.state.storage.put('proposal', this.proposal);
      this.broadcastEvent({ type: 'proposal_created', proposal: this.proposal });
      return Response.json(this.proposal);
    }

    if (!this.proposal) {
      return Response.json({ error: 'Proposal not initialized' }, { status: 404 });
    }

    // 2. Get State
    if (url.pathname === '/state' && request.method === 'GET') {
      return Response.json(this.proposal);
    }

    // 3. Add Claim
    if (url.pathname === '/claim' && request.method === 'POST') {
      const claim = await request.json<Claim>();
      this.proposal.claims.push(claim);
      this.proposal.status = 'working';
      this.proposal.updatedAt = Date.now();
      await this.state.storage.put('proposal', this.proposal);
      this.broadcastEvent({ type: 'claim_added', claim, proposalId: this.proposal.id });
      return Response.json({ success: true, claim });
    }

    // 4. Claim Heartbeat
    if (url.pathname.endsWith('/heartbeat') && request.method === 'POST') {
      const claimId = url.pathname.split('/')[2];
      const claim = this.proposal.claims.find((c) => c.id === claimId);
      if (!claim) {
        return Response.json({ error: 'Claim not found' }, { status: 404 });
      }
      const newExpiry = Date.now() + 30 * 60 * 1000; // +30m lease
      claim.leaseExpiresAt = newExpiry;
      this.proposal.updatedAt = Date.now();
      await this.state.storage.put('proposal', this.proposal);
      this.broadcastEvent({ type: 'claim_heartbeat', claimId, leaseExpiresAt: newExpiry });
      return Response.json({ success: true, leaseExpiresAt: newExpiry });
    }

    // 5. Release Claim
    if (url.pathname.endsWith('/release') && request.method === 'POST') {
      const claimId = url.pathname.split('/')[2];
      const claim = this.proposal.claims.find((c) => c.id === claimId);
      if (claim) {
        claim.status = 'released';
        this.proposal.updatedAt = Date.now();
        await this.state.storage.put('proposal', this.proposal);
        this.broadcastEvent({ type: 'claim_released', claimId });
      }
      return Response.json({ success: true });
    }

    // 6. Record Attestation
    if (url.pathname === '/attest' && request.method === 'POST') {
      const attestation = await request.json<Attestation>();
      // Replace existing attestation for same gate & commit, or append
      const existingIdx = this.proposal.attestations.findIndex(
        (a) => a.gateId === attestation.gateId && a.commitSha === attestation.commitSha
      );
      if (existingIdx >= 0) {
        this.proposal.attestations[existingIdx] = attestation;
      } else {
        this.proposal.attestations.push(attestation);
      }
      this.proposal.status = attestation.verdict === 'pass' ? 'gating' : 'working';
      this.proposal.updatedAt = Date.now();
      await this.state.storage.put('proposal', this.proposal);
      this.broadcastEvent({ type: 'attestation_recorded', attestation, proposalId: this.proposal.id });
      return Response.json({ success: true, attestation });
    }

    // 7. Mark as Merged
    if (url.pathname === '/mark-merged' && request.method === 'POST') {
      this.proposal.status = 'merged';
      this.proposal.updatedAt = Date.now();
      await this.state.storage.put('proposal', this.proposal);
      this.broadcastEvent({ type: 'proposal_merged', proposalId: this.proposal.id });
      return Response.json({ success: true });
    }

    // 8. Server-Sent Events (SSE) stream for real-time Context Bus
    if (url.pathname === '/events' && request.method === 'GET') {
      const { readable, writable } = new TransformStream();
      const writer = writable.getWriter();
      this.sseConnections.add(writer);

      // Send initial snapshot
      const encoder = new TextEncoder();
      writer.write(encoder.encode(`event: snapshot\ndata: ${JSON.stringify(this.proposal)}\n\n`));

      return new Response(readable, {
        headers: {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
        },
      });
    }

    return new Response('Not Found', { status: 404 });
  }

  private broadcastEvent(event: any) {
    const encoder = new TextEncoder();
    const payload = encoder.encode(`data: ${JSON.stringify(event)}\n\n`);
    for (const writer of this.sseConnections) {
      writer.write(payload).catch(() => {
        this.sseConnections.delete(writer);
      });
    }
  }
}
