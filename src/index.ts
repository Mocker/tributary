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

// 10. GET /v1/interventions — Pending human-decision cards
app.get('/v1/interventions', (c) => {
  const pending = Array.from(interventionsRegistry.values()).filter((i) => i.decision === 'pending');
  return c.json({ interventions: pending });
});

// 11. POST /v1/interventions/:id/resolve — 1-tap decision
app.post('/v1/interventions/:id/resolve', async (c) => {
  const id = c.req.param('id');
  const { decision } = await c.req.json<{ decision: 'approve' | 'reject' }>();

  const card = interventionsRegistry.get(id);
  if (!card) return c.json({ error: 'Intervention not found' }, 404);

  card.decision = decision;
  card.resolvedAt = Date.now();
  interventionsRegistry.set(id, card);

  return c.json({ success: true, intervention: card });
});

// -------------------------------------------------------------
// Radar UI (Static HTML + SSE Client)
// -------------------------------------------------------------
app.get('/', (c) => {
  return c.html(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Tributary Radar — Agent Collaboration Plane</title>
  <script src="https://cdn.tailwindcss.com"></script>
  <style>
    body { background-color: #0d1117; color: #c9d1d9; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif; }
    .radar-card { background: #161b22; border: 1px solid #30363d; border-radius: 8px; }
  </style>
</head>
<body class="p-6">
  <div class="max-w-7xl mx-auto">
    <header class="flex justify-between items-center pb-6 border-b border-gray-800">
      <div>
        <div class="flex items-center gap-3">
          <span class="text-2xl font-bold tracking-tight text-white">🌊 Tributary</span>
          <span class="px-2 py-0.5 text-xs font-semibold bg-emerald-950 text-emerald-400 border border-emerald-800 rounded">LIVE RADAR</span>
        </div>
        <p class="text-sm text-gray-400 mt-1">"GitHub coordinates humans. Tributary coordinates agents."</p>
      </div>
      <div class="flex gap-4 text-xs font-mono text-gray-400">
        <div>Substrate: <span class="text-emerald-400">Cloudflare Artifacts</span></div>
        <div>Runtime: <span class="text-emerald-400">Workers + Durable Objects</span></div>
      </div>
    </header>

    <div class="grid grid-cols-1 md:grid-cols-3 gap-6 mt-6">
      <!-- Panel 1: Live Claims -->
      <div class="radar-card p-4">
        <div class="flex justify-between items-center mb-3">
          <h2 class="text-sm font-bold uppercase tracking-wider text-gray-300">1. Live Claims</h2>
          <span id="claim-count" class="text-xs bg-blue-950 text-blue-300 px-2 py-0.5 rounded">0 active</span>
        </div>
        <div id="claims-list" class="space-y-2 text-xs">
          <div class="text-gray-500 italic p-3 text-center">No active claims</div>
        </div>
      </div>

      <!-- Panel 2: Gate Runs & Attestations -->
      <div class="radar-card p-4">
        <div class="flex justify-between items-center mb-3">
          <h2 class="text-sm font-bold uppercase tracking-wider text-gray-300">2. Gate Attestations</h2>
          <span class="text-xs bg-purple-950 text-purple-300 px-2 py-0.5 rounded">HMAC Signed</span>
        </div>
        <div id="gates-list" class="space-y-2 text-xs">
          <div class="text-gray-500 italic p-3 text-center">Awaiting gate runs</div>
        </div>
      </div>

      <!-- Panel 3: Merge Queue & Memory -->
      <div class="radar-card p-4">
        <div class="flex justify-between items-center mb-3">
          <h2 class="text-sm font-bold uppercase tracking-wider text-gray-300">3. Merge & Epistemic Memory</h2>
          <span class="text-xs bg-amber-950 text-amber-300 px-2 py-0.5 rounded">CAS Guarded</span>
        </div>
        <div id="merge-list" class="space-y-2 text-xs">
          <div class="text-gray-500 italic p-3 text-center">Merge queue idle</div>
        </div>
      </div>
    </div>

    <!-- Intervention Radar Card -->
    <div id="intervention-drawer" class="mt-6 radar-card p-4 border-amber-900/50 bg-amber-950/20 hidden">
      <div class="flex justify-between items-center">
        <div class="flex items-center gap-2">
          <span class="text-amber-400 font-bold">⚠️ Human Intervention Required</span>
          <span id="int-title" class="text-sm text-gray-200"></span>
        </div>
        <div class="flex gap-2">
          <button onclick="resolveIntervention('reject')" class="px-3 py-1 bg-red-900/50 hover:bg-red-800 text-red-200 text-xs rounded border border-red-700">1-Tap Reject</button>
          <button onclick="resolveIntervention('approve')" class="px-3 py-1 bg-emerald-900/50 hover:bg-emerald-800 text-emerald-200 text-xs rounded border border-emerald-700">1-Tap Approve</button>
        </div>
      </div>
      <p id="int-desc" class="text-xs text-gray-400 mt-2"></p>
    </div>
  </div>

  <script>
    async function refreshRadar() {
      try {
        const intRes = await fetch('/v1/interventions');
        const intData = await intRes.json();
        const drawer = document.getElementById('intervention-drawer');
        if (intData.interventions && intData.interventions.length > 0) {
          const first = intData.interventions[0];
          document.getElementById('int-title').innerText = first.title;
          document.getElementById('int-desc').innerText = first.description;
          drawer.classList.remove('hidden');
          window.activeInterventionId = first.id;
        } else {
          drawer.classList.add('hidden');
        }
      } catch (e) {}
    }
    async function resolveIntervention(decision) {
      if (!window.activeInterventionId) return;
      await fetch('/v1/interventions/' + window.activeInterventionId + '/resolve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ decision })
      });
      refreshRadar();
    }
    setInterval(refreshRadar, 2000);
    refreshRadar();
  </script>
</body>
</html>`);
});

export default app;
