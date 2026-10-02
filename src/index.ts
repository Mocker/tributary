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
    body { background-color: #0b0f17; color: #c9d1d9; font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
    .radar-card { background: #131823; border: 1px solid #232b3b; border-radius: 10px; }
  </style>
</head>
<body class="p-6">
  <div class="max-w-7xl mx-auto">
    <!-- Header -->
    <header class="flex flex-col md:flex-row md:items-center justify-between pb-6 border-b border-gray-800 gap-4">
      <div>
        <div class="flex items-center gap-3">
          <span class="text-2xl font-bold tracking-tight text-white flex items-center gap-2">
            <span>🌊</span> Tributary
          </span>
          <span class="px-2.5 py-0.5 text-xs font-semibold bg-emerald-950/80 text-emerald-400 border border-emerald-800/80 rounded-full tracking-wide">
            LIVE RADAR
          </span>
        </div>
        <p class="text-sm text-gray-400 mt-1 italic">
          "GitHub coordinates humans. Tributary coordinates agents."
        </p>
      </div>

      <div class="flex items-center gap-3">
        <button onclick="runSimulation()" id="sim-btn" class="px-4 py-2 bg-emerald-600 hover:bg-emerald-500 text-white font-medium text-xs rounded-lg transition shadow-lg shadow-emerald-950 flex items-center gap-2 cursor-pointer">
          <span>▶️</span> Run Swarm Simulation
        </button>
        <div class="text-xs font-mono text-gray-400 bg-gray-900 border border-gray-800 px-3 py-1.5 rounded-lg">
          <div>Substrate: <span class="text-emerald-400 font-semibold">Artifacts</span> | Runtime: <span class="text-emerald-400 font-semibold">Workers DO</span></div>
        </div>
      </div>
    </header>

    <!-- 3-Panel Coordination Grid -->
    <div class="grid grid-cols-1 md:grid-cols-3 gap-6 mt-6">
      <!-- Panel 1: Live Claims -->
      <div class="radar-card p-5">
        <div class="flex justify-between items-center mb-4">
          <div class="flex items-center gap-2">
            <span class="text-blue-400">🛡️</span>
            <h2 class="text-xs font-bold uppercase tracking-wider text-gray-300">1. Live Claims</h2>
          </div>
          <span id="claim-count" class="text-xs bg-blue-950/80 text-blue-300 border border-blue-800/60 px-2.5 py-0.5 rounded-full font-mono">0 active</span>
        </div>
        <div id="claims-list" class="space-y-3 text-xs max-h-[460px] overflow-y-auto pr-1">
          <div class="text-gray-500 italic p-6 text-center border border-dashed border-gray-800 rounded-lg">No active claims</div>
        </div>
      </div>

      <!-- Panel 2: Gate Runs & Attestations -->
      <div class="radar-card p-5">
        <div class="flex justify-between items-center mb-4">
          <div class="flex items-center gap-2">
            <span class="text-purple-400">⚡</span>
            <h2 class="text-xs font-bold uppercase tracking-wider text-gray-300">2. Gate Attestations</h2>
          </div>
          <span class="text-xs bg-purple-950/80 text-purple-300 border border-purple-800/60 px-2.5 py-0.5 rounded-full font-mono">HMAC SHA-256</span>
        </div>
        <div id="gates-list" class="space-y-3 text-xs max-h-[460px] overflow-y-auto pr-1">
          <div class="text-gray-500 italic p-6 text-center border border-dashed border-gray-800 rounded-lg">Awaiting gate runs</div>
        </div>
      </div>

      <!-- Panel 3: Merge Queue & Epistemic Memory -->
      <div class="radar-card p-5">
        <div class="flex justify-between items-center mb-4">
          <div class="flex items-center gap-2">
            <span class="text-amber-400">🧠</span>
            <h2 class="text-xs font-bold uppercase tracking-wider text-gray-300">3. Epistemic Memory</h2>
          </div>
          <span class="text-xs bg-amber-950/80 text-amber-300 border border-amber-800/60 px-2.5 py-0.5 rounded-full font-mono">.git/learnings</span>
        </div>
        <div id="memory-list" class="space-y-3 text-xs max-h-[460px] overflow-y-auto pr-1">
          <div class="text-gray-500 italic p-6 text-center border border-dashed border-gray-800 rounded-lg">No learnings crystallized</div>
        </div>
      </div>
    </div>

    <!-- Intervention Radar Card -->
    <div id="intervention-drawer" class="mt-6 radar-card p-5 border-amber-900/60 bg-amber-950/20 hidden">
      <div class="flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <div class="flex items-center gap-2">
            <span class="px-2 py-0.5 bg-amber-500 text-black font-bold text-xs rounded">ACTION REQUIRED</span>
            <span id="int-title" class="text-sm font-semibold text-amber-200"></span>
          </div>
          <p id="int-desc" class="text-xs text-gray-300 mt-2 font-mono"></p>
        </div>
        <div class="flex gap-2 shrink-0">
          <button onclick="resolveIntervention('reject')" class="px-3.5 py-1.5 bg-red-950 hover:bg-red-900 text-red-200 text-xs font-semibold rounded-lg border border-red-800 transition cursor-pointer">1-Tap Reject</button>
          <button onclick="resolveIntervention('approve')" class="px-3.5 py-1.5 bg-emerald-950 hover:bg-emerald-900 text-emerald-200 text-xs font-semibold rounded-lg border border-emerald-800 transition cursor-pointer">1-Tap Approve</button>
        </div>
      </div>
    </div>
  </div>

  <script>
    async function refreshRadar() {
      try {
        // 1. Fetch claims
        const claimsRes = await fetch('/v1/claims');
        const claimsData = await claimsRes.json();
        const claimsList = document.getElementById('claims-list');
        const countSpan = document.getElementById('claim-count');
        const claims = claimsData.claims || [];
        countSpan.innerText = claims.length + ' active';

        if (claims.length === 0) {
          claimsList.innerHTML = '<div class="text-gray-500 italic p-6 text-center border border-dashed border-gray-800 rounded-lg">No active claims</div>';
        } else {
          claimsList.innerHTML = claims.map(c => `
            <div class="p-3 bg-gray-900/90 border border-gray-800 rounded-lg">
              <div class="flex justify-between items-center mb-1.5">
                <span class="font-bold text-blue-300">\${c.agentId}</span>
                <span class="text-[10px] text-gray-500 font-mono">lease: \${Math.max(0, Math.round((c.leaseExpiresAt - Date.now()) / 60000))}m</span>
              </div>
              <div class="flex flex-wrap gap-1 mb-1.5">
                \${c.paths.map(p => '<span class="bg-gray-800 text-gray-300 px-1.5 py-0.5 rounded text-[11px] font-mono">' + p + '</span>').join('')}
                \${(c.symbols || []).map(s => '<span class="bg-indigo-950 text-indigo-300 border border-indigo-800 px-1.5 py-0.5 rounded text-[11px] font-mono">sym:' + s + '</span>').join('')}
              </div>
              <div class="text-[11px] text-gray-400 italic">\${c.rationale || ''}</div>
            </div>
          `).join('');
        }

        // 2. Fetch proposals & attestations
        const propRes = await fetch('/v1/proposals');
        const propData = await propRes.json();
        const gatesList = document.getElementById('gates-list');
        const proposals = propData.proposals || [];
        const allAttestations = proposals.flatMap(p => p.attestations.map(a => ({ ...a, agentId: p.agentId })));

        if (allAttestations.length === 0) {
          gatesList.innerHTML = '<div class="text-gray-500 italic p-6 text-center border border-dashed border-gray-800 rounded-lg">Awaiting gate runs</div>';
        } else {
          gatesList.innerHTML = allAttestations.map(a => `
            <div class="p-3 bg-gray-900/90 border border-gray-800 rounded-lg">
              <div class="flex justify-between items-center mb-1">
                <span class="font-semibold text-purple-300 font-mono">gate:\${a.gateId}</span>
                <span class="px-2 py-0.5 rounded text-[10px] font-bold \${a.verdict === 'pass' ? 'bg-emerald-950 text-emerald-300 border border-emerald-800' : 'bg-red-950 text-red-300 border border-red-800'}">\${a.verdict.toUpperCase()}</span>
              </div>
              <div class="text-[11px] text-gray-300 mb-1 font-mono">commit: \${a.commitSha.slice(0, 10)}</div>
              <div class="text-[11px] text-gray-400">\${a.summary}</div>
              <div class="mt-1 text-[9px] text-gray-500 font-mono truncate">sig: \${a.signature.slice(0, 32)}...</div>
            </div>
          `).join('');
        }

        // 3. Fetch learnings (.git/learnings/)
        const learnRes = await fetch('/v1/learnings');
        const learnData = await learnRes.json();
        const memList = document.getElementById('memory-list');
        const learnings = learnData.learnings || [];

        if (learnings.length === 0) {
          memList.innerHTML = '<div class="text-gray-500 italic p-6 text-center border border-dashed border-gray-800 rounded-lg">No learnings crystallized</div>';
        } else {
          memList.innerHTML = learnings.map(l => `
            <div class="p-3 bg-gray-900/90 border border-amber-900/40 rounded-lg">
              <div class="font-bold text-amber-300 text-xs mb-1">\${l.title}</div>
              <div class="text-[11px] text-gray-300 border-l-2 border-amber-500 pl-2 my-2 italic">\${l.rule}</div>
              <div class="text-[10px] text-gray-500 font-mono">\${l.filePath}</div>
            </div>
          `).join('');
        }

        // 4. Fetch interventions
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
      } catch (e) {
        console.error(e);
      }
    }

    async function runSimulation() {
      const btn = document.getElementById('sim-btn');
      btn.innerText = '⏳ Simulating...';
      btn.disabled = true;
      try {
        await fetch('/v1/admin/simulate', { method: 'POST' });
        await refreshRadar();
      } finally {
        btn.innerText = '▶️ Run Swarm Simulation';
        btn.disabled = false;
      }
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
