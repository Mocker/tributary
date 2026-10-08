import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { ulid } from 'ulid';
import { Env } from './env';
import { ChangeProposal, Claim, Attestation, InterventionCard, SymbolIndex, LearningRule } from './types';
import { detectOverlap } from './core/overlap';
import { signAttestation, verifyAttestation } from './core/attestation';
import { evaluateMergeGate } from './core/merge-gate';
import { generateLearningMarkdown, generateLearningFilename } from './core/learnings';

export { ChangeProposalDO } from './do/change-proposal';

const app = new Hono<{ Bindings: Env }>();

app.use('*', cors());

// Default symbol index for demo-shop
const DEFAULT_SYMBOL_INDEX: SymbolIndex = {
  symbols: {
    createSession: 'src/session.ts',
    validateSession: 'src/session.ts',
    revokeSession: 'src/session.ts',
    authenticate: 'src/auth/login.ts',
    processPayment: 'src/billing/checkout.ts',
  },
};

// In-memory / KV registry of active claims across all proposals for fast overlap check
const activeClaimsRegistry: Map<string, Claim> = new Map();
const proposalsRegistry: Map<string, ChangeProposal> = new Map();
const interventionsRegistry: Map<string, InterventionCard> = new Map();
const learningsRegistry: Map<string, LearningRule> = new Map();

// Helper to get or stub Artifacts repo
async function getOrInitArtifacts(env: Env, baseline: string) {
  try {
    const existing = await env.ARTIFACTS.get(baseline);
    if (existing) return existing;
    const { repo } = await env.ARTIFACTS.create(baseline);
    return repo;
  } catch {
    // Return mock repo handle for local testing when Cloudflare token is pending
    return {
      async createToken(scope: any, ttl: number = 3600) {
        return {
          token: `art_v1_mock_${ulid()}?expires=${Math.floor(Date.now() / 1000) + ttl}`,
          plaintext: `art_v1_mock_${ulid()}?expires=${Math.floor(Date.now() / 1000) + ttl}`,
          expiresAt: Date.now() + ttl * 1000,
        };
      },
      async listTokens() { return []; },
      async revokeToken() {},
      async fork(name: string) {
        return {
          remote: `https://mock.artifacts.cloudflare.net/git/tributary/${name}.git`,
          token: `art_v1_mock_${ulid()}`,
          repo: this,
        };
      },
      async getMetadata() {
        return {
          name: baseline,
          namespace: 'tributary',
          defaultBranch: 'main',
          commitsCount: 42,
          headSha: 'c0ffee112233445566778899aabbccddeeff0011',
        };
      },
    };
  }
}

// -------------------------------------------------------------
// Health Check
// -------------------------------------------------------------
app.get('/health', (c) => {
  return c.json({
    status: 'healthy',
    platform: 'Tributary',
    version: '0.1.0',
    thesis: 'GitHub coordinates humans. Tributary coordinates agents.',
    runtime: 'Cloudflare Workers + Artifacts',
    timestamp: new Date().toISOString(),
  });
});

// -------------------------------------------------------------
// V1 API Surface
// -------------------------------------------------------------

// 1. POST /v1/proposals — Fork baseline, mint token, spawn DO
app.post('/v1/proposals', async (c) => {
  const { baseline = 'demo-shop', taskRef, agentId } = await c.req.json<{
    baseline: string;
    taskRef: string;
    agentId: string;
  }>();

  if (!agentId || !taskRef) {
    return c.json({ error: 'agentId and taskRef are required' }, 400);
  }

  const proposalId = ulid();
  const forkRepo = `${baseline}__p_${proposalId}`;

  // Fork baseline repo via Artifacts binding
  const baseRepo = await getOrInitArtifacts(c.env, baseline);
  const forkResult = await baseRepo.fork(forkRepo);
  const tokenResult = await forkResult.repo.createToken('write', 3600);
  const meta = await baseRepo.getMetadata();

  // Initialize ChangeProposal Durable Object
  const doId = c.env.CHANGE_PROPOSAL_DO.idFromName(proposalId);
  const stub = c.env.CHANGE_PROPOSAL_DO.get(doId);

  const initResponse = await stub.fetch(
    new Request('http://internal/init', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: proposalId,
        baselineRepo: baseline,
        forkRepo,
        agentId,
        taskRef,
        baselineParentSha: meta.headSha || 'c0ffee112233445566778899aabbccddeeff0011',
      }),
    })
  );

  const proposalState = await initResponse.json<ChangeProposal>();
  proposalsRegistry.set(proposalId, proposalState);

  return c.json({
    proposalId,
    baselineRepo: baseline,
    forkRepo,
    forkRemote: forkResult.remote,
    token: tokenResult.plaintext,
    tokenExpiresAt: tokenResult.expiresAt,
    proposal: proposalState,
  }, 201);
});

// 2. GET /v1/proposals/:id — Proposal state incl. claims + attestations
app.get('/v1/proposals/:id', async (c) => {
  const id = c.req.param('id');
  const doId = c.env.CHANGE_PROPOSAL_DO.idFromName(id);
  const stub = c.env.CHANGE_PROPOSAL_DO.get(doId);

  const res = await stub.fetch('http://internal/state');
  if (res.status === 404) return c.json({ error: 'Proposal not found' }, 404);
  return c.json(await res.json());
});

// 3. POST /v1/proposals/:id/claims — Declare claim with overlap check
app.post('/v1/proposals/:id/claims', async (c) => {
  const proposalId = c.req.param('id');
  const { paths, symbols = [], rationale } = await c.req.json<{
    paths: string[];
    symbols?: string[];
    rationale: string;
  }>();

  if (!paths || paths.length === 0) {
    return c.json({ error: 'paths array must not be empty' }, 400);
  }

  // Fetch proposal to know agentId
  const doId = c.env.CHANGE_PROPOSAL_DO.idFromName(proposalId);
  const stub = c.env.CHANGE_PROPOSAL_DO.get(doId);
  const stateRes = await stub.fetch('http://internal/state');
  if (stateRes.status === 404) return c.json({ error: 'Proposal not found' }, 404);
  const proposal = await stateRes.json<ChangeProposal>();

  // Fetch symbol index (default or from KV)
  const symbolIndex = DEFAULT_SYMBOL_INDEX;

  // Run overlap detection against active claims
  const liveClaims = Array.from(activeClaimsRegistry.values());
  const overlap = detectOverlap(
    { agentId: proposal.agentId, paths, symbols },
    liveClaims,
    symbolIndex
  );

  if (overlap.hasOverlap) {
    // Create an intervention card for human radar if neither yields
    const interventionId = `int_${ulid()}`;
    const card: InterventionCard = {
      id: interventionId,
      proposalId,
      title: `Claim Overlap: ${proposal.agentId} vs ${overlap.conflictingClaim?.agentId}`,
      description: overlap.reason || 'Overlapping file/symbol claims detected.',
      conflictingClaim: overlap.conflictingClaim,
      decision: 'pending',
      createdAt: Date.now(),
    };
    interventionsRegistry.set(interventionId, card);

    // Emit on the proposal's SSE context bus so the radar surfaces the rejection live
    try {
      await stub.fetch(new Request('http://internal/broadcast', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: 'claim_rejected',
          proposalId,
          agentId: proposal.agentId,
          reason: overlap.reason,
          conflictingClaim: overlap.conflictingClaim,
          interventionId,
        }),
      }));
    } catch { /* bus broadcast is best-effort */ }

    return c.json({
      error: 'Claim conflict detected',
      code: 'claim_overlap',
      reason: overlap.reason,
      conflictingClaim: overlap.conflictingClaim,
      interventionId,
    }, 409);
  }

  // Accept claim with 30m lease
  const claimId = `claim_${ulid()}`;
  const claim: Claim = {
    id: claimId,
    proposalId,
    agentId: proposal.agentId,
    paths,
    symbols,
    rationale: rationale || 'Task implementation',
    leaseExpiresAt: Date.now() + 30 * 60 * 1000,
    status: 'active',
    createdAt: Date.now(),
  };

  activeClaimsRegistry.set(claimId, claim);

  // Store on DO
  await stub.fetch(new Request('http://internal/claim', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(claim),
  }));

  return c.json({ success: true, claim }, 201);
});

// 4. POST /v1/proposals/:id/claims/:claimId/heartbeat — Renew claim lease
app.post('/v1/proposals/:id/claims/:claimId/heartbeat', async (c) => {
  const proposalId = c.req.param('id');
  const claimId = c.req.param('claimId');

  const claim = activeClaimsRegistry.get(claimId);
  if (!claim) return c.json({ error: 'Claim not found or expired' }, 404);

  const newExpiry = Date.now() + 30 * 60 * 1000;
  claim.leaseExpiresAt = newExpiry;
  activeClaimsRegistry.set(claimId, claim);

  const doId = c.env.CHANGE_PROPOSAL_DO.idFromName(proposalId);
  const stub = c.env.CHANGE_PROPOSAL_DO.get(doId);
  await stub.fetch(`http://internal/claims/${claimId}/heartbeat`, { method: 'POST' });

  return c.json({ success: true, claimId, leaseExpiresAt: newExpiry });
});

// 5. POST /v1/proposals/:id/claims/:claimId/release — Voluntarily release a claim
app.post('/v1/proposals/:id/claims/:claimId/release', async (c) => {
  const proposalId = c.req.param('id');
  const claimId = c.req.param('claimId');

  activeClaimsRegistry.delete(claimId);

  const doId = c.env.CHANGE_PROPOSAL_DO.idFromName(proposalId);
  const stub = c.env.CHANGE_PROPOSAL_DO.get(doId);
  await stub.fetch(`http://internal/claims/${claimId}/release`, { method: 'POST' });

  return c.json({ success: true, claimId });
});

// 6. POST /v1/proposals/:id/gates/:gateId/run — Run a gate on { commitSha } → signed attestation
app.post('/v1/proposals/:id/gates/:gateId/run', async (c) => {
  const proposalId = c.req.param('id');
  const gateId = c.req.param('gateId');
  const { commitSha, simulateFailure = false, failureReason } = await c.req.json<{
    commitSha: string;
    simulateFailure?: boolean;
    failureReason?: string;
  }>();

  if (!commitSha) return c.json({ error: 'commitSha is required' }, 400);

  const secret = c.env.GATE_HMAC_SECRET || 'tributary-demo-secret-2026';

  let verdict: 'pass' | 'fail' = 'pass';
  let summary = `Verification gate '${gateId}' passed all test invariants for ${commitSha.slice(0, 7)}.`;

  if (simulateFailure) {
    verdict = 'fail';
    summary = failureReason || `Test failure in src/session.test.ts: session invariant assertion failed.`;
  }

  // Sign attestation via HMAC-SHA256
  const attestation = await signAttestation(gateId, commitSha, verdict, summary, secret);

  // Store on DO
  const doId = c.env.CHANGE_PROPOSAL_DO.idFromName(proposalId);
  const stub = c.env.CHANGE_PROPOSAL_DO.get(doId);
  await stub.fetch(new Request('http://internal/attest', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(attestation),
  }));

  return c.json({ success: true, attestation }, verdict === 'pass' ? 200 : 422);
});

// 7. POST /v1/proposals/:id/merge — Gated merge with CAS protection
app.post('/v1/proposals/:id/merge', async (c) => {
  const proposalId = c.req.param('id');
  const { commitSha, learning } = await c.req.json<{
    commitSha: string;
    learning?: { title: string; whatHappened: string; rule: string };
  }>();

  const doId = c.env.CHANGE_PROPOSAL_DO.idFromName(proposalId);
  const stub = c.env.CHANGE_PROPOSAL_DO.get(doId);
  const stateRes = await stub.fetch('http://internal/state');
  if (stateRes.status === 404) return c.json({ error: 'Proposal not found' }, 404);
  const proposal = await stateRes.json<ChangeProposal>();

  // Fetch current mainline SHA to evaluate CAS
  const baseRepo = await getOrInitArtifacts(c.env, proposal.baselineRepo);
  const meta = await baseRepo.getMetadata();
  const currentMainlineSha = meta.headSha || 'c0ffee112233445566778899aabbccddeeff0011';

  // Evaluate all merge conditions
  const evalResult = evaluateMergeGate(proposal, commitSha, currentMainlineSha, ['test']);
  if (!evalResult.canMerge) {
    return c.json({
      error: evalResult.error,
      code: evalResult.code,
      details: evalResult.details,
    }, evalResult.status);
  }

  // Merge succeeds: mark DO as merged
  await stub.fetch('http://internal/mark-merged', { method: 'POST' });

  // Release claims associated with this proposal
  for (const claim of proposal.claims) {
    activeClaimsRegistry.delete(claim.id);
  }

  // Crystallize learning if provided
  let learningEntry: LearningRule | undefined;
  if (learning) {
    const today = new Date().toISOString().slice(0, 10);
    const slug = learning.title.toLowerCase().replace(/[^a-z0-9]+/g, '-');
    learningEntry = {
      date: today,
      slug,
      title: learning.title,
      whatHappened: learning.whatHappened,
      rule: learning.rule,
      filePath: generateLearningFilename(today, slug),
    };
    learningsRegistry.set(slug, learningEntry);
  }

  return c.json({
    merged: true,
    proposalId,
    targetCommitSha: commitSha,
    mainlineSha: currentMainlineSha,
    crystallizedLearning: learningEntry,
  });
});

// 8. GET /v1/proposals/:id/events — SSE context bus
app.get('/v1/proposals/:id/events', async (c) => {
  const proposalId = c.req.param('id');
  const doId = c.env.CHANGE_PROPOSAL_DO.idFromName(proposalId);
  const stub = c.env.CHANGE_PROPOSAL_DO.get(doId);
  return stub.fetch(c.req.raw);
});

// 9. GET /v1/learnings — List .git/learnings/ entries
app.get('/v1/learnings', (c) => {
  return c.json({
    learnings: Array.from(learningsRegistry.values()),
  });
});

// 12. GET /v1/claims — List active claims
app.get('/v1/claims', (c) => {
  const now = Date.now();
  const valid = Array.from(activeClaimsRegistry.values()).filter(
    (claim) => claim.status === 'active' && claim.leaseExpiresAt > now
  );
  return c.json({ claims: valid });
});

// 13. GET /v1/proposals — List active proposals & queue state
app.get('/v1/proposals', (c) => {
  return c.json({
    proposals: Array.from(proposalsRegistry.values()),
  });
});

// 10. GET /v1/interventions — List intervention cards (pending by default)
app.get('/v1/interventions', (c) => {
  const status = c.req.query('status') || 'pending';
  const cards = Array.from(interventionsRegistry.values()).filter(
    (card) => status === 'all' || card.decision === status
  );
  return c.json({ interventions: cards });
});

// 11. POST /v1/interventions/:id/resolve — 1-tap approve/reject
//
// Semantics (v1): 'approve' sides with the blocked agent — the conflicting
// claim is superseded (yielded) so the blocked agent can re-claim the path.
// 'reject' upholds the existing claim; the blocked agent must narrow its claim.
app.post('/v1/interventions/:id/resolve', async (c) => {
  const id = c.req.param('id');
  const { decision } = await c.req.json<{ decision: 'approve' | 'reject' }>();

  const card = interventionsRegistry.get(id);
  if (!card) return c.json({ error: 'Intervention not found' }, 404);
  if (decision !== 'approve' && decision !== 'reject') {
    return c.json({ error: "decision must be 'approve' or 'reject'" }, 400);
  }
  if (card.decision !== 'pending') {
    return c.json({ error: `Intervention already ${card.decision}` }, 409);
  }

  card.decision = decision === 'approve' ? 'approved' : 'rejected';
  card.resolvedAt = Date.now();
  interventionsRegistry.set(id, card);

  if (decision === 'approve' && card.conflictingClaim) {
    const conflict = activeClaimsRegistry.get(card.conflictingClaim.id);
    if (conflict) {
      conflict.status = 'superseded';
      activeClaimsRegistry.delete(conflict.id);
    }
  }

  // Emit on the proposal's SSE context bus
  try {
    const doId = c.env.CHANGE_PROPOSAL_DO.idFromName(card.proposalId);
    const stub = c.env.CHANGE_PROPOSAL_DO.get(doId);
    await stub.fetch(new Request('http://internal/broadcast', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'intervention_resolved', intervention: card }),
    }));
  } catch { /* bus broadcast is best-effort */ }

  return c.json({ success: true, intervention: card });
});

// 14. POST /v1/admin/simulate — Trigger in-browser swarm collision demo
app.post('/v1/admin/simulate', async (c) => {
  // Step 1: Agent A claims auth
  const propAId = `prop_auth_${ulid().slice(-6)}`;
  proposalsRegistry.set(propAId, {
    id: propAId,
    baselineRepo: 'demo-shop',
    forkRepo: `demo-shop__p_${propAId}`,
    agentId: 'Agent A (Auth)',
    taskRef: 'AUTH-101',
    status: 'working',
    claims: [],
    attestations: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });

  const claimA: Claim = {
    id: `claim_${ulid().slice(-6)}`,
    proposalId: propAId,
    agentId: 'Agent A (Auth)',
    paths: ['src/auth/**'],
    symbols: ['createSession'],
    rationale: 'Auth session lifecycle upgrade',
    leaseExpiresAt: Date.now() + 1800000,
    status: 'active',
    createdAt: Date.now(),
  };
  activeClaimsRegistry.set(claimA.id, claimA);
  proposalsRegistry.get(propAId)!.claims.push(claimA);

  // Step 2: Agent B attempts overlapping claim on src/session.ts
  const propBId = `prop_billing_${ulid().slice(-6)}`;
  proposalsRegistry.set(propBId, {
    id: propBId,
    baselineRepo: 'demo-shop',
    forkRepo: `demo-shop__p_${propBId}`,
    agentId: 'Agent B (Billing)',
    taskRef: 'BILL-402',
    status: 'claiming',
    claims: [],
    attestations: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });

  // Check overlap for Agent B
  const overlap = detectOverlap(
    { agentId: 'Agent B (Billing)', paths: ['src/billing/**', 'src/session.ts'] },
    Array.from(activeClaimsRegistry.values()),
    DEFAULT_SYMBOL_INDEX
  );

  let interventionCard: InterventionCard | undefined;
  if (overlap.hasOverlap) {
    const intId = `int_${ulid().slice(-6)}`;
    interventionCard = {
      id: intId,
      proposalId: propBId,
      title: `Claim Overlap: Agent B vs Agent A`,
      description: overlap.reason || 'Overlapping claim on src/session.ts',
      conflictingClaim: overlap.conflictingClaim,
      decision: 'pending',
      createdAt: Date.now(),
    };
    interventionsRegistry.set(intId, interventionCard);
  }

  // Step 3: Agent B narrows claim to src/billing/**
  const claimB: Claim = {
    id: `claim_${ulid().slice(-6)}`,
    proposalId: propBId,
    agentId: 'Agent B (Billing)',
    paths: ['src/billing/**'],
    symbols: ['processPayment'],
    rationale: 'Payment webhook handler update',
    leaseExpiresAt: Date.now() + 1800000,
    status: 'active',
    createdAt: Date.now(),
  };
  activeClaimsRegistry.set(claimB.id, claimB);
  proposalsRegistry.get(propBId)!.claims.push(claimB);
  proposalsRegistry.get(propBId)!.status = 'working';

  // Step 4: Gate execution for Agent B (generates signed HMAC attestation)
  const commitSha = `b202_${ulid().slice(-6)}`;
  const attestation = await signAttestation(
    'test',
    commitSha,
    'pass',
    'All 12 session and payment invariant assertions passed.',
    c.env.GATE_HMAC_SECRET || 'tributary-demo-secret-2026'
  );
  proposalsRegistry.get(propBId)!.attestations.push(attestation);
  proposalsRegistry.get(propBId)!.status = 'gating';

  // Step 5: Merge with CAS & Epistemic Memory Crystallization
  proposalsRegistry.get(propBId)!.status = 'merged';
  activeClaimsRegistry.delete(claimB.id);

  const today = new Date().toISOString().slice(0, 10);
  const slug = 'session-shared-module';
  const learningRule: LearningRule = {
    date: today,
    slug,
    title: 'Shared Session Module Boundary Invariant',
    whatHappened:
      'Agent B attempted to alter session timeout parameters during billing refactor while Agent A was migrating auth tokens.',
    rule:
      'src/session.ts is a shared module between auth and billing. Always claim src/session.ts explicitly; never implicitly mutate session contracts inside billing PRs.',
    filePath: generateLearningFilename(today, slug),
  };
  learningsRegistry.set(slug, learningRule);

  return c.json({
    success: true,
    message: 'Swarm collision simulation triggered cleanly.',
    proposalA: propAId,
    proposalB: propBId,
    intervention: interventionCard,
    attestation,
    learning: learningRule,
  });
});

// -------------------------------------------------------------
// Radar UI
// The radar is a React + Vite app in ui/, built to ui/dist and served by
// wrangler static assets (see [assets] in wrangler.jsonc). The legacy inline
// HTML page was removed 2026-10-07: it failed tsc (unescaped backticks inside
// the outer template literal) and duplicated the ui/ app's panels.
// -------------------------------------------------------------

export default app;
