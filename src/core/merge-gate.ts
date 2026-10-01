import { ChangeProposal, Attestation } from '../types';

export interface MergeEvaluationResult {
  canMerge: boolean;
  status: 200 | 400 | 409 | 422;
  error?: string;
  code?: 'claims_invalid' | 'gate_failed' | 'no_attestation' | 'ref_moved' | 'proposal_not_ready';
  details?: any;
}

/**
 * Evaluates whether a ChangeProposal satisfies all gating conditions for merge:
 * 1. Claims are active with live leases
 * 2. All required gates have a valid 'pass' attestation on the exact target commitSha
 * 3. Compare-And-Swap (CAS): current target mainline SHA matches proposal baselineParentSha
 */
export function evaluateMergeGate(
  proposal: ChangeProposal,
  targetCommitSha: string,
  currentMainlineSha: string,
  requiredGateIds: string[] = ['test']
): MergeEvaluationResult {
  const now = Date.now();

  // 1. Verify claims are active and leases are valid
  const activeClaims = proposal.claims.filter(
    (c) => c.status === 'active' && c.leaseExpiresAt > now
  );

  if (activeClaims.length === 0) {
    return {
      canMerge: false,
      status: 409,
      code: 'claims_invalid',
      error: 'Cannot merge: Proposal has no active claim with a valid lease. Re-claim or heartbeat first.',
    };
  }

  // 2. Verify all required gates have passed on this exact commitSha
  for (const gateId of requiredGateIds) {
    const attestation = proposal.attestations.find(
      (a) => a.gateId === gateId && a.commitSha === targetCommitSha
    );

    if (!attestation) {
      return {
        canMerge: false,
        status: 422,
        code: 'no_attestation',
        error: `Required verification gate '${gateId}' has not run for commit ${targetCommitSha.slice(0, 7)}.`,
      };
    }

    if (attestation.verdict !== 'pass') {
      return {
        canMerge: false,
        status: 422,
        code: 'gate_failed',
        error: `Merge blocked: Gate '${gateId}' failed on commit ${targetCommitSha.slice(0, 7)}: "${attestation.summary}"`,
        details: attestation,
      };
    }
  }

  // 3. Compare-And-Swap (CAS) on target ref
  if (proposal.baselineParentSha && proposal.baselineParentSha !== currentMainlineSha) {
    return {
      canMerge: false,
      status: 409,
      code: 'ref_moved',
      error: `Mainline reference moved from ${proposal.baselineParentSha.slice(0, 7)} to ${currentMainlineSha.slice(0, 7)}. Rebase your fork onto mainline and re-attest.`,
      details: {
        expectedMainlineSha: proposal.baselineParentSha,
        actualMainlineSha: currentMainlineSha,
      },
    };
  }

  return { canMerge: true, status: 200 };
}
