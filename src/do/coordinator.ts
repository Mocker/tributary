import {
  Attestation,
  ChangeProposal,
  Claim,
  InterventionCard,
  LearningRule,
  SymbolIndex,
} from '../types';
import { detectOverlap } from '../core/overlap';

/**
 * CoordinatorDO — Tributary's global coordination point.
 *
 * Cloudflare Workers run on many isolates, and a module-level Map in the
 * Worker is NOT shared between them. Before this DO existed, the claim
 * registry was per-isolate: an overlapping claim could get 201 on one isolate
 * while the conflicting claim lived on another, and GET /v1/claims could
 * return empty right after claims were created. This DO is the single-writer
 * authority for:
 *   - the global claim index (declare = overlap-check + insert, atomically)
 *   - intervention cards, learnings, and the proposal list snapshots
 *
 * Per-proposal Durable Objects remain the durable record for each proposal's
 * own lifecycle (claims, attestations, merge state, SSE bus).
 *
 * Claim expiry is enforced lazily: expired claims never block an overlap
 * check (leaseExpiresAt is compared on every read) and are swept on writes.
 */
export class CoordinatorDO {
  private state: DurableObjectState;

  constructor(state: DurableObjectState) {
    this.state = state;
  }

  private async load<T>(key: string): Promise<Record<string, T>> {
    return (await this.state.storage.get<Record<string, T>>(key)) ?? {};
  }

  private async save<T>(key: string, value: Record<string, T>): Promise<void> {
    await this.state.storage.put(key, value);
  }

  /** Claims whose lease is still alive. Expired claims never block. */
  private liveClaims(all: Record<string, Claim>): Claim[] {
    const now = Date.now();
    return Object.values(all).filter(
      (c) => c.status === 'active' && c.leaseExpiresAt > now
    );
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;
    const json = <T>(body: T, status = 200) => Response.json(body, { status });

    try {
      // ---------------- claims ----------------
      if (path === '/claims/declare' && method === 'POST') {
        const { claim, symbolIndex } = await request.json<{
          claim: Claim;
          symbolIndex: SymbolIndex;
        }>();
        const all = await this.load<Claim>('claims');
        const overlap = detectOverlap(
          { agentId: claim.agentId, paths: claim.paths, symbols: claim.symbols ?? [] },
          this.liveClaims(all),
          symbolIndex
        );
        if (overlap.hasOverlap) {
          return json(
            {
              hasOverlap: true,
              reason: overlap.reason,
              conflictingClaim: overlap.conflictingClaim,
            },
            409
          );
        }
        all[claim.id] = claim;
        await this.save('claims', all);
        return json({ hasOverlap: false, claim }, 201);
      }

      if (path === '/claims/heartbeat' && method === 'POST') {
        const { claimId } = await request.json<{ claimId: string }>();
        const all = await this.load<Claim>('claims');
        const claim = all[claimId];
        if (!claim) return json({ error: 'Claim not found or expired' }, 404);
        claim.leaseExpiresAt = Date.now() + 30 * 60 * 1000;
        await this.save('claims', all);
        return json({ success: true, claimId, leaseExpiresAt: claim.leaseExpiresAt });
      }

      if (path === '/claims/release' && method === 'POST') {
        const { claimId } = await request.json<{ claimId: string }>();
        const all = await this.load<Claim>('claims');
        delete all[claimId];
        await this.save('claims', all);
        return json({ success: true, claimId });
      }

      if (path === '/claims/supersede' && method === 'POST') {
        const { claimId } = await request.json<{ claimId: string }>();
        const all = await this.load<Claim>('claims');
        if (all[claimId]) {
          all[claimId].status = 'superseded';
          delete all[claimId];
          await this.save('claims', all);
        }
        return json({ success: true, claimId });
      }

      if (path === '/claims/release-by-proposal' && method === 'POST') {
        const { proposalId } = await request.json<{ proposalId: string }>();
        const all = await this.load<Claim>('claims');
        let released = 0;
        for (const [id, c] of Object.entries(all)) {
          if (c.proposalId === proposalId) {
            delete all[id];
            released++;
          }
        }
        await this.save('claims', all);
        return json({ success: true, released });
      }

      if (path === '/claims' && method === 'GET') {
        const all = await this.load<Claim>('claims');
        return json({ claims: this.liveClaims(all) });
      }

      // ---------------- interventions ----------------
      if (path === '/interventions' && method === 'POST') {
        const { card } = await request.json<{ card: InterventionCard }>();
        const all = await this.load<InterventionCard>('interventions');
        all[card.id] = card;
        await this.save('interventions', all);
        return json({ success: true, intervention: card }, 201);
      }

      if (path === '/interventions' && method === 'GET') {
        const status = url.searchParams.get('status') || 'pending';
        const all = await this.load<InterventionCard>('interventions');
        const cards = Object.values(all).filter(
          (c) => status === 'all' || c.decision === status
        );
        return json({ interventions: cards });
      }

      {
        const m = path.match(/^\/interventions\/([^/]+)\/resolve$/);
        if (m && method === 'POST') {
          const { decision } = await request.json<{ decision: 'approve' | 'reject' }>();
          const all = await this.load<InterventionCard>('interventions');
          const card = all[m[1]];
          if (!card) return json({ error: 'Intervention not found' }, 404);
          if (card.decision !== 'pending') {
            return json({ error: `Intervention already ${card.decision}` }, 409);
          }
          card.decision = decision === 'approve' ? 'approved' : 'rejected';
          card.resolvedAt = Date.now();
          await this.save('interventions', all);
          return json({ success: true, intervention: card });
        }
      }

      {
        const m = path.match(/^\/interventions\/([^/]+)$/);
        if (m && method === 'GET') {
          const all = await this.load<InterventionCard>('interventions');
          const card = all[m[1]];
          if (!card) return json({ error: 'Intervention not found' }, 404);
          return json({ intervention: card });
        }
      }

      // ---------------- learnings ----------------
      if (path === '/learnings' && method === 'POST') {
        const { rule } = await request.json<{ rule: LearningRule }>();
        const all = await this.load<LearningRule>('learnings');
        all[rule.slug] = rule;
        await this.save('learnings', all);
        return json({ success: true, learning: rule }, 201);
      }

      if (path === '/learnings' && method === 'GET') {
        const all = await this.load<LearningRule>('learnings');
        return json({ learnings: Object.values(all) });
      }

      // ---------------- proposals (radar list snapshots) ----------------
      if (path === '/proposals' && method === 'POST') {
        const { proposal } = await request.json<{ proposal: ChangeProposal }>();
        const all = await this.load<ChangeProposal>('proposals');
        all[proposal.id] = proposal;
        await this.save('proposals', all);
        return json({ success: true, proposal }, 201);
      }

      if (path === '/proposals' && method === 'GET') {
        const all = await this.load<ChangeProposal>('proposals');
        return json({ proposals: Object.values(all) });
      }

      {
        const m = path.match(/^\/proposals\/([^/]+)\/claim$/);
        if (m && method === 'POST') {
          const { claim } = await request.json<{ claim: Claim }>();
          const all = await this.load<ChangeProposal>('proposals');
          const p = all[m[1]];
          if (p) {
            p.claims.push(claim);
            p.status = 'working';
            p.updatedAt = Date.now();
            await this.save('proposals', all);
          }
          return json({ success: true });
        }
      }

      {
        const m = path.match(/^\/proposals\/([^/]+)\/attestation$/);
        if (m && method === 'POST') {
          const { attestation } = await request.json<{ attestation: Attestation }>();
          const all = await this.load<ChangeProposal>('proposals');
          const p = all[m[1]];
          if (p) {
            p.attestations.push(attestation);
            p.updatedAt = Date.now();
            await this.save('proposals', all);
          }
          return json({ success: true });
        }
      }

      {
        const m = path.match(/^\/proposals\/([^/]+)$/);
        if (m && method === 'PATCH') {
          const patch = await request.json<Partial<ChangeProposal>>();
          const all = await this.load<ChangeProposal>('proposals');
          const p = all[m[1]];
          if (!p) return json({ error: 'Proposal not found' }, 404);
          Object.assign(p, patch, { updatedAt: Date.now() });
          await this.save('proposals', all);
          return json({ success: true, proposal: p });
        }
      }

      return json({ error: 'not found' }, 404);
    } catch (err) {
      return json({ error: err instanceof Error ? err.message : String(err) }, 500);
    }
  }
}
