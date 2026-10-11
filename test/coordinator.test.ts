import test from 'node:test';
import assert from 'node:assert';
import { CoordinatorDO } from '../src/do/coordinator';
import { Claim, InterventionCard, SymbolIndex } from '../src/types';

// In-memory DurableObjectState stub: the DO only touches state.storage,
// so a Map-backed stub exercises the real read-modify-write paths.
function makeDO(): CoordinatorDO {
  const store = new Map<string, unknown>();
  const state = {
    storage: {
      async get(key: string) {
        return store.has(key) ? store.get(key) : null;
      },
      async put(key: string, val: unknown) {
        store.set(key, val);
      },
    },
  } as unknown as DurableObjectState;
  return new CoordinatorDO(state);
}

async function post(do_: CoordinatorDO, path: string, payload: unknown) {
  const res = await do_.fetch(
    new Request(`http://internal${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
  );
  return { status: res.status, body: await res.json() as any };
}

async function get(do_: CoordinatorDO, path: string) {
  const res = await do_.fetch(new Request(`http://internal${path}`));
  return { status: res.status, body: await res.json() as any };
}

const symbolIndex: SymbolIndex = {
  symbols: { createSession: 'src/session.ts', authenticate: 'src/auth/login.ts' },
};

function mkClaim(over: Partial<Claim> = {}): Claim {
  return {
    id: `claim_${Math.random().toString(36).slice(2, 8)}`,
    proposalId: 'prop_1',
    agentId: 'Agent A',
    paths: ['src/auth/**'],
    symbols: ['createSession'],
    rationale: 'test',
    leaseExpiresAt: Date.now() + 30 * 60 * 1000,
    status: 'active',
    createdAt: Date.now(),
    ...over,
  };
}

test('coordinator: declare accepts a disjoint claim (201)', async () => {
  const do_ = makeDO();
  const { status, body } = await post(do_, '/claims/declare', {
    claim: mkClaim(),
    symbolIndex,
  });
  assert.equal(status, 201);
  assert.equal(body.hasOverlap, false);
  assert.equal(body.claim.id.startsWith('claim_'), true);
});

test('coordinator: declare rejects overlapping claim with reason (409) — the isolate-bug regression', async () => {
  const do_ = makeDO();
  // Agent A holds src/auth/** + symbol createSession (-> src/session.ts)
  await post(do_, '/claims/declare', { claim: mkClaim(), symbolIndex });

  // Agent B (a "different isolate" in the old world — here, a second call to
  // the SAME single-writer DO) tries src/session.ts directly.
  const { status, body } = await post(do_, '/claims/declare', {
    claim: mkClaim({
      id: 'claim_b',
      proposalId: 'prop_2',
      agentId: 'Agent B',
      paths: ['src/session.ts'],
      symbols: [],
    }),
    symbolIndex,
  });
  assert.equal(status, 409);
  assert.equal(body.hasOverlap, true);
  assert.ok(typeof body.reason === 'string' && body.reason.length > 10);
  assert.equal(body.conflictingClaim.agentId, 'Agent A');
});

test('coordinator: expired claims never block', async () => {
  const do_ = makeDO();
  await post(do_, '/claims/declare', {
    claim: mkClaim({ leaseExpiresAt: Date.now() - 1000 }),
    symbolIndex,
  });
  const { status } = await post(do_, '/claims/declare', {
    claim: mkClaim({ id: 'claim_fresh', paths: ['src/auth/**'], symbols: [] }),
    symbolIndex,
  });
  assert.equal(status, 201);
});

test('coordinator: heartbeat extends lease; release removes', async () => {
  const do_ = makeDO();
  const claim = mkClaim();
  await post(do_, '/claims/declare', { claim, symbolIndex });

  const hb = await post(do_, '/claims/heartbeat', { claimId: claim.id });
  assert.equal(hb.status, 200);
  assert.ok(hb.body.leaseExpiresAt > claim.leaseExpiresAt);

  const rel = await post(do_, '/claims/release', { claimId: claim.id });
  assert.equal(rel.status, 200);
  const list = await get(do_, '/claims');
  assert.equal(list.body.claims.length, 0);

  const hb2 = await post(do_, '/claims/heartbeat', { claimId: claim.id });
  assert.equal(hb2.status, 404);
});

test('coordinator: supersede + release-by-proposal', async () => {
  const do_ = makeDO();
  const c1 = mkClaim({ id: 'c1', proposalId: 'p1', paths: ['src/a/**'], symbols: [] });
  const c2 = mkClaim({ id: 'c2', proposalId: 'p1', paths: ['src/b/**'], symbols: [] });
  await post(do_, '/claims/declare', { claim: c1, symbolIndex });
  await post(do_, '/claims/declare', { claim: c2, symbolIndex });

  await post(do_, '/claims/supersede', { claimId: 'c1' });
  let list = await get(do_, '/claims');
  assert.equal(list.body.claims.length, 1);

  await post(do_, '/claims/release-by-proposal', { proposalId: 'p1' });
  list = await get(do_, '/claims');
  assert.equal(list.body.claims.length, 0);
});

test('coordinator: release-by-agent clears all claims for an agent', async () => {
  const do_ = makeDO();
  const c1 = mkClaim({ id: 'c1', agentId: 'Agent A', paths: ['src/a/**'], symbols: [] });
  const c2 = mkClaim({ id: 'c2', agentId: 'Agent A', paths: ['src/b/**'], symbols: [] });
  const c3 = mkClaim({ id: 'c3', agentId: 'Agent B', paths: ['src/c/**'], symbols: [] });
  await post(do_, '/claims/declare', { claim: c1, symbolIndex });
  await post(do_, '/claims/declare', { claim: c2, symbolIndex });
  await post(do_, '/claims/declare', { claim: c3, symbolIndex });

  const rel = await post(do_, '/claims/release-by-agent', { agentId: 'Agent A' });
  assert.equal(rel.status, 200);
  assert.equal(rel.body.released, 2);

  const list = await get(do_, '/claims');
  assert.equal(list.body.claims.length, 1);
  assert.equal(list.body.claims[0].agentId, 'Agent B');
});

test('coordinator: interventions create / list / resolve', async () => {
  const do_ = makeDO();
  const card: InterventionCard = {
    id: 'int_1',
    proposalId: 'prop_2',
    title: 'Claim Overlap',
    description: 'conflicts with Agent A',
    decision: 'pending',
    createdAt: Date.now(),
  };
  await post(do_, '/interventions', { card });

  const pending = await get(do_, '/interventions');
  assert.equal(pending.body.interventions.length, 1);

  const res = await post(do_, '/interventions/int_1/resolve', { decision: 'approve' });
  assert.equal(res.status, 200);
  assert.equal(res.body.intervention.decision, 'approved');

  const again = await post(do_, '/interventions/int_1/resolve', { decision: 'reject' });
  assert.equal(again.status, 409);

  const all = await get(do_, '/interventions?status=all');
  assert.equal(all.body.interventions.length, 1);
});

test('coordinator: learnings append / list', async () => {
  const do_ = makeDO();
  await post(do_, '/learnings', {
    rule: {
      date: '2026-10-10',
      slug: 's1',
      title: 'T',
      whatHappened: 'W',
      rule: 'R',
      filePath: 'x.md',
    },
  });
  const list = await get(do_, '/learnings');
  assert.equal(list.body.learnings.length, 1);
  assert.equal(list.body.learnings[0].slug, 's1');
});

test('coordinator: proposal snapshots register / claim / attestation / status', async () => {
  const do_ = makeDO();
  const proposal: any = {
    id: 'prop_9',
    baselineRepo: 'demo-shop',
    forkRepo: 'demo-shop__p_x',
    agentId: 'Agent Z',
    taskRef: 'T-1',
    status: 'claiming',
    claims: [],
    attestations: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  await post(do_, '/proposals', { proposal });

  const claim = mkClaim({ proposalId: 'prop_9', agentId: 'Agent Z' });
  await post(do_, '/proposals/prop_9/claim', { claim });
  await post(do_, '/proposals/prop_9/attestation', {
    attestation: { gateId: 'test', commitSha: 'abc', verdict: 'pass', summary: 'ok', signedAt: 1, signature: 'sig' },
  });
  await do_.fetch(
    new Request('http://internal/proposals/prop_9', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'merged' }),
    })
  );

  const list = await get(do_, '/proposals');
  const snap = list.body.proposals.find((p: any) => p.id === 'prop_9');
  assert.equal(snap.status, 'merged');
  assert.equal(snap.claims.length, 1);
  assert.equal(snap.attestations.length, 1);
});
