import test from 'node:test';
import assert from 'node:assert';
import { evaluateMergeGate } from '../src/core/merge-gate';
import { ChangeProposal } from '../src/types';

function createMockProposal(overrides: Partial<ChangeProposal> = {}): ChangeProposal {
  return {
    id: 'prop_01J',
    baselineRepo: 'demo-shop',
    forkRepo: 'demo-shop__p_01J',
    agentId: 'Agent A',
    taskRef: 'TASK-1',
    status: 'working',
    claims: [
      {
        id: 'claim_1',
        proposalId: 'prop_01J',
        agentId: 'Agent A',
        paths: ['src/auth/**'],
        symbols: [],
        rationale: 'Auth rewrite',
        leaseExpiresAt: Date.now() + 1800000,
        status: 'active',
        createdAt: Date.now(),
      },
    ],
    attestations: [],
    baselineParentSha: 'sha_base_000',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  };
}

test('merge-gate: blocks merge when proposal has no valid active lease', () => {
  const proposal = createMockProposal({
    claims: [
      {
        id: 'claim_1',
        proposalId: 'prop_01J',
        agentId: 'Agent A',
        paths: ['src/auth/**'],
        symbols: [],
        rationale: 'Expired lease',
        leaseExpiresAt: Date.now() - 1000, // Expired!
        status: 'active',
        createdAt: Date.now() - 2000,
      },
    ],
  });

  const res = evaluateMergeGate(proposal, 'sha_target_111', 'sha_base_000');
  assert.strictEqual(res.canMerge, false);
  assert.strictEqual(res.code, 'claims_invalid');
});

test('merge-gate: blocks merge when required gate attestation failed', () => {
  const proposal = createMockProposal({
    attestations: [
      {
        gateId: 'test',
        commitSha: 'sha_target_111',
        verdict: 'fail',
        summary: 'Session assertion failed on line 42',
        signedAt: Date.now(),
        signature: 'mock_sig',
      },
    ],
  });

  const res = evaluateMergeGate(proposal, 'sha_target_111', 'sha_base_000');
  assert.strictEqual(res.canMerge, false);
  assert.strictEqual(res.code, 'gate_failed');
  assert.match(res.error || '', /Session assertion failed/);
});

test('merge-gate: blocks merge with 409 ref_moved when mainline moved (CAS)', () => {
  const proposal = createMockProposal({
    baselineParentSha: 'sha_base_000',
    attestations: [
      {
        gateId: 'test',
        commitSha: 'sha_target_111',
        verdict: 'pass',
        summary: 'All passed',
        signedAt: Date.now(),
        signature: 'mock_sig',
      },
    ],
  });

  // Mainline moved to sha_base_999 concurrently by another agent
  const res = evaluateMergeGate(proposal, 'sha_target_111', 'sha_base_999');
  assert.strictEqual(res.canMerge, false);
  assert.strictEqual(res.status, 409);
  assert.strictEqual(res.code, 'ref_moved');
  assert.match(res.error || '', /Mainline reference moved/);
});

test('merge-gate: approves merge when claims valid, gate passed, and CAS matches', () => {
  const proposal = createMockProposal({
    baselineParentSha: 'sha_base_000',
    attestations: [
      {
        gateId: 'test',
        commitSha: 'sha_target_111',
        verdict: 'pass',
        summary: 'All 15 assertions passed',
        signedAt: Date.now(),
        signature: 'mock_sig',
      },
    ],
  });

  const res = evaluateMergeGate(proposal, 'sha_target_111', 'sha_base_000');
  assert.strictEqual(res.canMerge, true);
  assert.strictEqual(res.status, 200);
});
