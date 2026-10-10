export interface ChangeProposal {
  id: string; // ulid
  baselineRepo: string; // Artifacts repo name, e.g. "demo-shop"
  forkRepo: string; // forked repo name, e.g. "demo-shop__p_01J..."
  forkRemote?: string; // git remote URL of the fork (set at proposal creation)
  agentId: string;
  taskRef: string;
  status:
    | 'claiming'
    | 'working'
    | 'gating'
    | 'merging'
    | 'merged'
    | 'rejected'
    | 'expired';
  claims: Claim[];
  attestations: Attestation[];
  baselineParentSha?: string; // SHA of mainline ref when proposal was minted (for CAS on merge)
  createdAt: number;
  updatedAt: number;
}

export interface Claim {
  id: string;
  proposalId: string;
  agentId: string;
  paths: string[]; // e.g. ["src/auth/**"]
  symbols: string[]; // e.g. ["createSession"]
  rationale: string;
  leaseExpiresAt: number; // renewed via heartbeat; expiry releases the claim
  status: 'active' | 'released' | 'expired' | 'superseded';
  createdAt: number;
}

export interface Attestation {
  gateId: string; // e.g. "test"
  commitSha: string;
  verdict: 'pass' | 'fail';
  summary: string; // human-readable, shown in radar + merge blockers
  detailsUri?: string;
  signedAt: number;
  signature: string; // HMAC over the attestation payload
}

export interface OverlapResult {
  hasOverlap: boolean;
  conflictingClaim?: Claim;
  reason?: string;
}

export interface SymbolIndex {
  symbols: Record<string, string>; // e.g. { "createSession": "src/session.ts" }
}

export interface InterventionCard {
  id: string;
  proposalId: string;
  title: string;
  description: string;
  conflictingClaim?: Claim;
  decision: 'pending' | 'approved' | 'rejected';
  createdAt: number;
  resolvedAt?: number;
}

export interface LearningRule {
  date: string;
  slug: string;
  title: string;
  whatHappened: string;
  rule: string;
  filePath: string;
}
