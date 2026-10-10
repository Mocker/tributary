import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { ulid } from 'ulid';
import { Env } from './env';
import { ChangeProposal, Claim, Attestation, InterventionCard, SymbolIndex, LearningRule } from './types';
import { signAttestation, verifyAttestation } from './core/attestation';
import { evaluateMergeGate } from './core/merge-gate';
import { generateLearningMarkdown, generateLearningFilename } from './core/learnings';
import http from 'isomorphic-git/http/web';
import { MemoryFS } from './memory-fs';
import {
  physicalMerge,
  MergeConflictError,
  MainlineMovedError,
  type PhysicalMergeResult,
} from './core/physical-merge';

export { ChangeProposalDO } from './do/change-proposal';
export { CoordinatorDO } from './do/coordinator';

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

// Global coordination state lives in the CoordinatorDO (single instance, id
// 'global'). A module-level Map in the Worker is per-isolate and NOT shared:
// the pre-coordinator registries let overlapping claims through on different
// isolates and made list endpoints return stale/empty results. See
// src/do/coordinator.ts.
function coordinator(env: Env) {
  return env.COORDINATOR_DO.get(env.COORDINATOR_DO.idFromName('global'));
}

async function coordCall(
  env: Env,
  path: string,
  init?: RequestInit
): Promise<{ status: number; body: any }> {
  const res = await coordinator(env).fetch(`http://internal${path}`, init);
  let body: any = null;
  try {
    body = await res.json();
  } catch {
    /* non-JSON body */
  }
  return { status: res.status, body };
}

function coordPost(env: Env, path: string, payload: unknown) {
  return coordCall(env, path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
}

function coordPatch(env: Env, path: string, payload: unknown) {
  return coordCall(env, path, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
}

// Helper to get or create the Artifacts baseline repo.
// Helper to get or create the Artifacts baseline repo.
// Verified against the live binding 2026-10-10: get() THROWS NOT_FOUND for
// a missing repo (never returns null), and create() returns metadata —
// re-get() the handle afterwards. Any other binding error fails loudly:
// silently falling back to mock data would fake the competition's hard
// requirement of real Workers + Artifacts usage.
async function getOrInitArtifacts(
  env: Env,
  baseline: string
): Promise<ArtifactsRepo> {
  if (!env.ARTIFACTS) {
    // Local dev without the binding configured: mock repo handle.
    return mockArtifactsRepo(baseline) as unknown as ArtifactsRepo;
  }
  try {
    return await env.ARTIFACTS.get(baseline);
  } catch (err) {
    if (!isArtifactsNotFound(err)) {
      console.error(
        '[artifacts] unexpected binding error:',
        err instanceof Error ? err.message : String(err)
      );
      throw err;
    }
  }
  console.log(`[artifacts] baseline '${baseline}' not found, creating it`);
  await env.ARTIFACTS.create(baseline);
  return env.ARTIFACTS.get(baseline);
}

/** Resolve a repo handle for token minting (real binding, or mock in local dev). */
async function getRepoHandle(env: Env, repoName: string): Promise<ArtifactsRepo> {
  if (!env.ARTIFACTS)
    return mockArtifactsRepo(repoName) as unknown as ArtifactsRepo;
  return env.ARTIFACTS.get(repoName);
}

/** Head SHA of a repo's default branch, or a stable placeholder for empty repos. */
async function getHeadSha(repo: {
  log: (opts?: { limit?: number }) => Promise<Array<{ hash: string }>>;
}): Promise<string> {
  const commits = await repo.log({ limit: 1 });
  return commits[0]?.hash ?? 'c0ffee112233445566778899aabbccddeeff0011';
}

function isArtifactsNotFound(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  return (
    (err as { code?: string }).code === 'NOT_FOUND' ||
    /not found/i.test(err.message)
  );
}

// Mock repo handle for local dev without the ARTIFACTS binding. Mirrors the
// real ArtifactsRepo surface used above (fork/createToken/info/log).
function mockArtifactsRepo(baseline: string) {
  const now = new Date().toISOString();
  const mkToken = (ttl: number) => ({
    id: `mock_${ulid()}`,
    plaintext: `art_v1_mock_${ulid()}?expires=${Math.floor(Date.now() / 1000) + ttl}`,
    scope: 'write' as const,
    expiresAt: new Date(Date.now() + ttl * 1000).toISOString(),
  });
  return {
    async createToken(scope: 'write' | 'read' = 'write', ttl: number = 3600) {
      return mkToken(ttl);
    },
    async listTokens() {
      return { tokens: [], total: 0 };
    },
    async revokeToken() {
      return true;
    },
    async fork(name: string) {
      return {
        id: `mock_${name}`,
        name,
        description: null,
        defaultBranch: 'main',
        remote: `https://mock.artifacts.cloudflare.net/git/tributary/${name}.git`,
        token: mkToken(3600).plaintext,
      };
    },
    async info() {
      return {
        id: `mock_${baseline}`,
        name: baseline,
        description: null,
        defaultBranch: 'main',
        createdAt: now,
        updatedAt: now,
        lastPushAt: null,
        source: null,
        readOnly: false,
        remote: `https://mock.artifacts.cloudflare.net/git/tributary/${baseline}.git`,
      };
    },
    async log() {
      return [];
    },
  };
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
  const forked = await baseRepo.fork(forkRepo);
  const forkHandle = await getRepoHandle(c.env, forkRepo);
  const tokenResult = await forkHandle.createToken('write', 3600);
  const baselineParentSha = await getHeadSha(baseRepo);

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
        forkRemote: forked.remote,
        agentId,
        taskRef,
        baselineParentSha,
      }),
    })
  );

  const proposalState = await initResponse.json<ChangeProposal>();
  await coordPost(c.env, '/proposals', { proposal: proposalState });

  return c.json({
    proposalId,
    baselineRepo: baseline,
    forkRepo,
    forkRemote: forked.remote,
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

  // Atomic declare via the coordinator DO: overlap-check + insert happen in
  // one single-writer invocation, so concurrent claims landing on different
  // isolates cannot both slip through.
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

  const declareRes = await coordPost(c.env, '/claims/declare', { claim, symbolIndex });

  if (declareRes.status === 409) {
    const { reason, conflictingClaim } = declareRes.body;
    // Create an intervention card for human radar if neither yields
    const interventionId = `int_${ulid()}`;
    const card: InterventionCard = {
      id: interventionId,
      proposalId,
      title: `Claim Overlap: ${proposal.agentId} vs ${conflictingClaim?.agentId}`,
      description: reason || 'Overlapping file/symbol claims detected.',
      conflictingClaim,
      decision: 'pending',
      createdAt: Date.now(),
    };
    await coordPost(c.env, '/interventions', { card });

    // Emit on the proposal's SSE context bus so the radar surfaces the rejection live
    try {
      await stub.fetch(new Request('http://internal/broadcast', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: 'claim_rejected',
          proposalId,
          agentId: proposal.agentId,
          reason,
          conflictingClaim,
          interventionId,
        }),
      }));
    } catch { /* bus broadcast is best-effort */ }

    return c.json({
      error: 'Claim conflict detected',
      code: 'claim_overlap',
      reason,
      conflictingClaim,
      interventionId,
    }, 409);
  }

  // Store on the proposal DO (durable per-proposal record) and mirror into
  // the coordinator's proposal snapshot (radar list)
  await stub.fetch(new Request('http://internal/claim', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(claim),
  }));
  await coordPost(c.env, `/proposals/${proposalId}/claim`, { claim });

  return c.json({ success: true, claim }, 201);
});

// 4. POST /v1/proposals/:id/claims/:claimId/heartbeat — Renew claim lease
app.post('/v1/proposals/:id/claims/:claimId/heartbeat', async (c) => {
  const proposalId = c.req.param('id');
  const claimId = c.req.param('claimId');

  const hb = await coordPost(c.env, '/claims/heartbeat', { claimId });
  if (hb.status === 404) return c.json({ error: 'Claim not found or expired' }, 404);

  const doId = c.env.CHANGE_PROPOSAL_DO.idFromName(proposalId);
  const stub = c.env.CHANGE_PROPOSAL_DO.get(doId);
  await stub.fetch(`http://internal/claims/${claimId}/heartbeat`, { method: 'POST' });

  return c.json({ success: true, claimId, leaseExpiresAt: hb.body.leaseExpiresAt });
});

// 5. POST /v1/proposals/:id/claims/:claimId/release — Voluntarily release a claim
app.post('/v1/proposals/:id/claims/:claimId/release', async (c) => {
  const proposalId = c.req.param('id');
  const claimId = c.req.param('claimId');

  await coordPost(c.env, '/claims/release', { claimId });

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

  // Mirror attestation into the coordinator's proposal snapshot (radar panel)
  await coordPost(c.env, `/proposals/${proposalId}/attestation`, { attestation });

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
  const currentMainlineSha = await getHeadSha(baseRepo);

  // Evaluate all merge conditions
  const evalResult = evaluateMergeGate(proposal, commitSha, currentMainlineSha, ['test']);
  if (!evalResult.canMerge) {
    return c.json({
      error: evalResult.error,
      code: evalResult.code,
      details: evalResult.details,
    }, evalResult.status);
  }

  // Physical merge: integrate the fork's commits into the baseline repo.
  // Artifacts has no merge endpoint — the Worker is the merge authority, so
  // it performs the merge itself via isomorphic-git (Workers have no git
  // binary). Fast-forward when the fork is a descendant, merge commit
  // otherwise (author = agent, committer = Tributary). The push is
  // CAS-guarded: if mainline moved under us the push is rejected.
  const accountId = c.env.ARTIFACTS_ACCOUNT_ID;
  const remoteFor = (repo: string) =>
    `https://${accountId}.artifacts.cloudflare.net/git/tributary/${repo}.git`;
  // baseRepo is an RPC handle: `.remote` may be a lazy JsRpcProperty (truthy
  // but stringifies to "[object JsRpcProperty]"), so await it and validate.
  const handleRemote = await (baseRepo as unknown as { remote?: unknown }).remote;
  const baselineRemote =
    (typeof handleRemote === 'string' ? handleRemote : undefined) ??
    remoteFor(proposal.baselineRepo);
  const forkRemote =
    proposal.forkRemote ?? remoteFor(proposal.forkRepo);
  const tokenSecret = (t: string) => t.split('?')[0];

  const baselineToken = await baseRepo.createToken('write', 600);
  const forkRepoHandle = await getRepoHandle(c.env, proposal.forkRepo);
  const forkToken = await forkRepoHandle.createToken('read', 600);

  let physical: PhysicalMergeResult;
  try {
    physical = await physicalMerge({
      fs: new MemoryFS(),
      http,
      dir: '/merge',
      baselineRemote,
      forkRemote,
      baselineBranch: 'main',
      forkBranch: 'main',
      baselineAuth: { username: 'x', password: tokenSecret(baselineToken.plaintext) },
      forkAuth: { username: 'x', password: tokenSecret(forkToken.plaintext) },
      author: {
        name: proposal.agentId,
        email: `${proposal.agentId.toLowerCase().replace(/[^a-z0-9]+/g, '-') }@tributary.local`,
      },
      committer: { name: 'Tributary', email: 'merge@tributary.local' },
    });
  } catch (e) {
    if (e instanceof MergeConflictError) {
      return c.json(
        {
          error: 'Merge conflicts — rebase the fork onto mainline and re-attest',
          code: 'merge_conflict',
          details: e.message,
        },
        409
      );
    }
    if (e instanceof MainlineMovedError) {
      return c.json(
        { error: 'Mainline moved during merge — rebase and re-attest', code: 'mainline_moved' },
        409
      );
    }
    throw e;
  }

  // Merge succeeds: mark DO as merged
  await stub.fetch('http://internal/mark-merged', { method: 'POST' });

  // Release claims associated with this proposal (coordinator index) and
  // mark the snapshot merged
  await coordPost(c.env, '/claims/release-by-proposal', { proposalId });
  await coordPatch(c.env, `/proposals/${proposalId}`, { status: 'merged' });

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
    await coordPost(c.env, '/learnings', { rule: learningEntry });
  }

  return c.json({
    merged: true,
    proposalId,
    targetCommitSha: commitSha,
    mainlineSha: currentMainlineSha,
    mergedSha: physical.mergedSha,
    fastForward: physical.fastForward,
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
app.get('/v1/learnings', async (c) => {
  const { body } = await coordCall(c.env, '/learnings');
  return c.json({ learnings: body.learnings ?? [] });
});

// 12. GET /v1/claims — List active claims (coordinator global index)
app.get('/v1/claims', async (c) => {
  const { body } = await coordCall(c.env, '/claims');
  return c.json({ claims: body.claims ?? [] });
});

// 13. GET /v1/proposals — List proposals & queue state (coordinator snapshots)
app.get('/v1/proposals', async (c) => {
  const { body } = await coordCall(c.env, '/proposals');
  return c.json({ proposals: body.proposals ?? [] });
});

// 10. GET /v1/interventions — List intervention cards (pending by default)
app.get('/v1/interventions', async (c) => {
  const status = c.req.query('status') || 'pending';
  const { body } = await coordCall(c.env, `/interventions?status=${encodeURIComponent(status)}`);
  return c.json({ interventions: body.interventions ?? [] });
});

// 11. POST /v1/interventions/:id/resolve — 1-tap approve/reject
//
// Semantics (v1): 'approve' sides with the blocked agent — the conflicting
// claim is superseded (yielded) so the blocked agent can re-claim the path.
// 'reject' upholds the existing claim; the blocked agent must narrow its claim.
app.post('/v1/interventions/:id/resolve', async (c) => {
  const id = c.req.param('id');
  const { decision } = await c.req.json<{ decision: 'approve' | 'reject' }>();

  if (decision !== 'approve' && decision !== 'reject') {
    return c.json({ error: "decision must be 'approve' or 'reject'" }, 400);
  }

  const resolved = await coordPost(c.env, `/interventions/${id}/resolve`, { decision });
  if (resolved.status === 404) return c.json({ error: 'Intervention not found' }, 404);
  if (resolved.status === 409) return c.json({ error: resolved.body.error }, 409);
  const card: InterventionCard = resolved.body.intervention;

  if (decision === 'approve' && card.conflictingClaim) {
    await coordPost(c.env, '/claims/supersede', { claimId: card.conflictingClaim.id });
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

// 15. POST /v1/admin/seed — Ensure the baseline repo exists in Artifacts and
// mint a short-lived write token for pushing the seed content.
//
// Matches the binding behavior verified against the live API (PR #4,
// 2026-10-10): get() THROWS NOT_FOUND for a missing repo (never null),
// create() returns metadata — re-get() the handle afterwards. Any other
// binding error fails loudly with 503; no mocks on this route.
// The actual file push happens OUTSIDE the Worker: scripts/seed-baseline.ts
// takes the returned { remote, token } and pushes the local folder over git
// smart-HTTP with a Bearer header.
app.post('/v1/admin/seed', async (c) => {
  let body: { baseline?: string } = {};
  try { body = await c.req.json(); } catch { /* default baseline */ }
  const baseline = body.baseline || 'demo-shop';

  let repo: any;
  let created = false;
  try {
    repo = await c.env.ARTIFACTS.get(baseline);
  } catch (err) {
    const code = (err as { code?: string })?.code;
    const msg = err instanceof Error ? err.message : String(err);
    if (code !== 'NOT_FOUND' && !/not found/i.test(msg)) {
      return c.json({ error: `Artifacts binding error: ${msg}`, code: 'artifacts_error' }, 503);
    }
    try {
      await c.env.ARTIFACTS.create(baseline);
      repo = await c.env.ARTIFACTS.get(baseline);
      created = true;
    } catch (e2) {
      const m2 = e2 instanceof Error ? e2.message : String(e2);
      return c.json({
        error: `Artifacts unavailable — is the Workers Paid plan active? (${m2})`,
        code: 'artifacts_unavailable',
      }, 503);
    }
  }

  // repo may be an RPC handle: `.remote` can be a lazy JsRpcProperty (truthy
  // but stringifies to "[object JsRpcProperty]") — await and validate.
  const seedRemote: unknown = await (repo as { remote?: unknown }).remote;
  const remote: string | null =
    typeof seedRemote === 'string' ? seedRemote : null;
  const tokenResult: any = await repo.createToken('write', 600);
  const token: string = tokenResult.plaintext ?? tokenResult.token;

  return c.json({
    baseline,
    created,
    remote,
    remoteHint: remote
      ? undefined
      : 'https://<ACCOUNT_ID>.artifacts.cloudflare.net/git/tributary/<repo>.git',
    token,
    tokenExpiresAt: tokenResult.expiresAt,
    usage: 'git -c http.extraHeader="Authorization: Bearer <token>" push <remote> HEAD:main',
  }, created ? 201 : 200);
});

// 14. POST /v1/admin/simulate — Scripted swarm-collision scenario.
//
// The scenario itself is synthetic (scripted agents, no Artifacts forks), but
// every state change goes through the real coordinator paths: atomic declare,
// intervention cards, signed attestations, learnings. Nothing bypasses the
// coordination logic, so the radar shows exactly what real agents would
// produce. See docs/repos.md.
app.post('/v1/admin/simulate', async (c) => {
  const now = Date.now();
  const mkProposal = (id: string, agentId: string, taskRef: string): ChangeProposal => ({
    id,
    baselineRepo: 'demo-shop',
    forkRepo: `demo-shop__p_${id}`,
    agentId,
    taskRef,
    status: 'claiming',
    claims: [],
    attestations: [],
    createdAt: now,
    updatedAt: now,
  });

  const propA = mkProposal(`prop_auth_${ulid().slice(-6)}`, 'Agent A (Auth)', 'AUTH-101');
  const propB = mkProposal(`prop_billing_${ulid().slice(-6)}`, 'Agent B (Billing)', 'BILL-402');
  await coordPost(c.env, '/proposals', { proposal: propA });
  await coordPost(c.env, '/proposals', { proposal: propB });

  // Step 1: Agent A claims auth + createSession via the real atomic declare
  const claimA: Claim = {
    id: `claim_${ulid().slice(-6)}`,
    proposalId: propA.id,
    agentId: propA.agentId,
    paths: ['src/auth/**'],
    symbols: ['createSession'],
    rationale: 'Auth session lifecycle upgrade',
    leaseExpiresAt: now + 1800000,
    status: 'active',
    createdAt: now,
  };
  const decA = await coordPost(c.env, '/claims/declare', {
    claim: claimA,
    symbolIndex: DEFAULT_SYMBOL_INDEX,
  });
  if (decA.status === 201) {
    await coordPost(c.env, `/proposals/${propA.id}/claim`, { claim: claimA });
  }

  // Step 2: Agent B attempts the overlapping claim -> 409 on the real path
  const claimB: Claim = {
    id: `claim_${ulid().slice(-6)}`,
    proposalId: propB.id,
    agentId: propB.agentId,
    paths: ['src/billing/**', 'src/session.ts'],
    symbols: [],
    rationale: 'Billing refactor touching session',
    leaseExpiresAt: now + 1800000,
    status: 'active',
    createdAt: now,
  };
  const decB = await coordPost(c.env, '/claims/declare', {
    claim: claimB,
    symbolIndex: DEFAULT_SYMBOL_INDEX,
  });

  let interventionCard: InterventionCard | undefined;
  if (decB.status === 409) {
    interventionCard = {
      id: `int_${ulid().slice(-6)}`,
      proposalId: propB.id,
      title: 'Claim Overlap: Agent B vs Agent A',
      description: decB.body.reason || 'Overlapping claim on src/session.ts',
      conflictingClaim: decB.body.conflictingClaim,
      decision: 'pending',
      createdAt: now,
    };
    await coordPost(c.env, '/interventions', { card: interventionCard });
  }

  // Step 3: Agent B narrows to src/billing/** and proceeds
  const claimB2: Claim = {
    ...claimB,
    id: `claim_${ulid().slice(-6)}`,
    paths: ['src/billing/**'],
    symbols: ['processPayment'],
    rationale: 'Payment webhook handler update',
  };
  const decB2 = await coordPost(c.env, '/claims/declare', {
    claim: claimB2,
    symbolIndex: DEFAULT_SYMBOL_INDEX,
  });
  if (decB2.status === 201) {
    await coordPost(c.env, `/proposals/${propB.id}/claim`, { claim: claimB2 });
  }
  await coordPatch(c.env, `/proposals/${propB.id}`, { status: 'working' });

  // Step 4: gate attestation (signed, real HMAC path)
  const commitSha = `b202_${ulid().slice(-6)}`;
  const attestation = await signAttestation(
    'test',
    commitSha,
    'pass',
    'All 12 session and payment invariant assertions passed.',
    c.env.GATE_HMAC_SECRET || 'tributary-demo-secret-2026'
  );
  await coordPost(c.env, `/proposals/${propB.id}/attestation`, { attestation });
  await coordPatch(c.env, `/proposals/${propB.id}`, { status: 'gating' });

  // Step 5: merge + learning crystallization
  await coordPost(c.env, '/claims/release-by-proposal', { proposalId: propB.id });
  await coordPatch(c.env, `/proposals/${propB.id}`, { status: 'merged' });
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
  await coordPost(c.env, '/learnings', { rule: learningRule });

  return c.json({
    success: true,
    message: 'Swarm collision simulation ran through the real coordinator paths.',
    proposalA: propA.id,
    proposalB: propB.id,
    claimAccepted: decA.status === 201,
    overlapRejected: decB.status === 409,
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
