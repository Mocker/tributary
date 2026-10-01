export interface ArtifactRepo {
  createToken(
    scope: 'read' | 'write' | 'admin',
    ttlSeconds?: number
  ): Promise<{ token: string; plaintext: string; expiresAt: number }>;
  listTokens(): Promise<Array<{ id: string; scope: string; expiresAt: number }>>;
  revokeToken(tokenId: string): Promise<void>;
  fork(
    name: string,
    options?: { bare?: boolean; branch?: string }
  ): Promise<{ remote: string; token: string; repo: ArtifactRepo }>;
  getMetadata(): Promise<{
    name: string;
    namespace: string;
    defaultBranch: string;
    commitsCount: number;
    headSha?: string;
  }>;
}

export interface ArtifactsBinding {
  create(repoName: string): Promise<{ remote: string; token: string; repo: ArtifactRepo }>;
  fork?(sourceRepo: string, forkName: string): Promise<{ remote: string; token: string; repo: ArtifactRepo }>;
  get(repoName: string): Promise<ArtifactRepo | null>;
  list(): Promise<Array<{ name: string; namespace: string }>>;
  import(repoName: string, sourceGitUrl: string): Promise<ArtifactRepo>;
  delete(repoName: string): Promise<void>;
}

export interface Env {
  ARTIFACTS: ArtifactsBinding;
  CHANGE_PROPOSAL_DO: DurableObjectNamespace;
  TRIBUTARY_KV: KVNamespace;

  ENVIRONMENT?: string;
  GATE_HMAC_SECRET: string;
  DEFAULT_BASELINE_REPO?: string;
}
