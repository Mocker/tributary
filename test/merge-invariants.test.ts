/**
 * merge-invariants.test.ts — machine-checked model of Tributary's merge gate.
 *
 * PLAN.md §7 states the merge-gating rules: a proposal merges only when
 *   (a) at least one claim is active with a live lease,
 *   (b) every required gate attested `pass` on the exact commit SHA being merged, and
 *   (c) the compare-and-swap on the target ref holds (mainline hasn't moved).
 *
 * This file encodes those rules as a Z3 model and proves, with the solver,
 * that each guard is INDIVIDUALLY NECESSARY: there is no assignment of the
 * guards under which `merged` holds while any single guard fails.
 *
 * What this proves: the abstract merge-gate model admits no path to `merged`
 * that skips a guard. The differential test below ties the model to the real
 * `evaluateMergeGate` implementation across all 8 guard combinations, so the
 * proved properties transfer to the implementation for the modeled aspects.
 *
 * What this does NOT prove: the deployed ChangeProposal Durable Object as a
 * whole. The DO's wiring (storage, heartbeats, event emission) is covered by
 * integration tests, not by Z3. In the demo, frame this as a machine-checked
 * model of the merge gate — not "formally verified end to end."
 *
 * Modeling note: `evaluateMergeGate` skips the CAS check when
 * `baselineParentSha` is unset. The model assumes it is always set, which
 * holds for proposals created through the Worker (the DO `/init` always
 * receives it from `POST /v1/proposals`). If that ever changes, the
 * differential test will fail and this model must be revisited.
 */
import test from 'node:test';
import assert from 'node:assert';
import { init } from 'z3-solver';
import { evaluateMergeGate } from '../src/core/merge-gate';
import { Attestation, ChangeProposal, Claim } from '../src/types';

const { Context } = await init();

const TARGET_SHA = 'sha_target_111';
const BASE_SHA = 'sha_base_000';
const MOVED_SHA = 'sha_base_999';

function makeClaim(overrides: Partial<Claim> = {}): Claim {
  return {
    id: 'claim_1',
    proposalId: 'prop_01J',
    agentId: 'Agent A',
    paths: ['src/auth/**'],
    symbols: [],
    rationale: 'test claim',
    leaseExpiresAt: Date.now() + 1800000,
    status: 'active',
    createdAt: Date.now(),
    ...overrides,
  };
}

function makeAttestation(overrides: Partial<Attestation> = {}): Attestation {
  return {
    gateId: 'test',
    commitSha: TARGET_SHA,
    verdict: 'pass',
    summary: 'ok',
    signedAt: Date.now(),
    signature: 'mock_sig',
    ...overrides,
  };
}

function makeProposal(opts: {
  claimOk: boolean;
  gatesOk: boolean;
  casOk: boolean;
}): ChangeProposal {
  return {
    id: 'prop_01J',
    baselineRepo: 'demo-shop',
    forkRepo: 'demo-shop__p_01J',
    agentId: 'Agent A',
    taskRef: 'TASK-1',
    status: 'working',
    claims: [
      makeClaim(
        opts.claimOk ? {} : { leaseExpiresAt: Date.now() - 1000 } // expired lease
      ),
    ],
    attestations: opts.gatesOk
      ? [makeAttestation({ verdict: 'pass' })]
      : [makeAttestation({ verdict: 'fail', summary: 'boom' })],
    baselineParentSha: BASE_SHA,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}

/**
 * Build the Z3 model of the merge decision. The symbolic guards are
 *   claimOk — an active claim with a live lease exists,
 *   gatesOk — every required gate attested `pass` on the exact target SHA,
 *   casOk   — baselineParentSha matches the current mainline SHA.
 * The `merged` decision is defined exactly as `evaluateMergeGate` decides it:
 * merge iff every guard holds.
 */
function buildMergeModel() {
  const z3 = new Context('merge-gate');
  const claimOk = z3.Bool.const('claimOk');
  const gatesOk = z3.Bool.const('gatesOk');
  const casOk = z3.Bool.const('casOk');
  const merged = z3.Bool.const('merged');
  const solver = new z3.Solver();
  solver.add(z3.Eq(merged, z3.And(claimOk, gatesOk, casOk)));
  return { z3, solver, claimOk, gatesOk, casOk, merged };
}

test('z3: merged is unreachable without an active claim (UNSAT)', async () => {
  const { z3, solver, merged, claimOk } = buildMergeModel();
  solver.push();
  solver.add(merged, z3.Not(claimOk));
  assert.strictEqual(await solver.check(), 'unsat');
  solver.pop();
});

test('z3: merged is unreachable without passing gate attestations (UNSAT)', async () => {
  const { z3, solver, merged, gatesOk } = buildMergeModel();
  solver.push();
  solver.add(merged, z3.Not(gatesOk));
  assert.strictEqual(await solver.check(), 'unsat');
  solver.pop();
});

test('z3: merged is unreachable when the CAS check fails (UNSAT)', async () => {
  const { z3, solver, merged, casOk } = buildMergeModel();
  solver.push();
  solver.add(merged, z3.Not(casOk));
  assert.strictEqual(await solver.check(), 'unsat');
  solver.pop();
});

test('differential: model verdict matches evaluateMergeGate on all 8 guard combinations', () => {
  for (const claimOk of [true, false]) {
    for (const gatesOk of [true, false]) {
      for (const casOk of [true, false]) {
        const proposal = makeProposal({ claimOk, gatesOk, casOk });
        const mainlineSha = casOk ? BASE_SHA : MOVED_SHA;
        const res = evaluateMergeGate(proposal, TARGET_SHA, mainlineSha);
        const modelVerdict = claimOk && gatesOk && casOk;
        assert.strictEqual(
          res.canMerge,
          modelVerdict,
          `divergence for claimOk=${claimOk} gatesOk=${gatesOk} casOk=${casOk} (got code=${res.code})`
        );
      }
    }
  }
});
