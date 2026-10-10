// Cloudflare Artifacts types come from @cloudflare/workers-types
// (global `Artifacts` / `ArtifactsRepo` interfaces). Do NOT hand-roll them:
// the binding's real shapes are get() throws NOT_FOUND (never null),
// create()/fork() return ArtifactsCreateRepoResult (metadata + initial
// token, not a repo handle), and repo metadata comes from info()/log(),
// not getMetadata()/headSha.

export interface Env {
  ARTIFACTS: Artifacts;
  CHANGE_PROPOSAL_DO: DurableObjectNamespace;
  COORDINATOR_DO: DurableObjectNamespace;
  TRIBUTARY_KV: KVNamespace;

  ENVIRONMENT?: string;
  GATE_HMAC_SECRET: string;
  DEFAULT_BASELINE_REPO?: string;
}
