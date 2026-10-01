export interface ArtifactRepo {
  createToken(
    scope: 'read' | 'write' | 'admin',
    ttlSeconds?: number
  ): Promise<{ token: string; plaintext: string; expiresAt: number }>;
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
  fork(sourceRepo: string, forkName: string): Promise<{ remote: string; token: string; repo: ArtifactRepo }>;
  get(repoName: string): Promise<ArtifactRepo | null>;
  delete(repoName: string): Promise<void>;
  list?(): Promise<Array<{ name: string; namespace: string }>>;
}

export interface Env {
  ARTIFACTS: ArtifactsBinding;
  SWARM_COORDINATOR: DurableObjectNamespace;
  OMNIGIT_KV: KVNamespace;
  OMNIGIT_LEARNINGS_INDEX?: VectorizeIndex;
  AI?: any;

  ENVIRONMENT?: string;
  POLICY_STORAGE?: string;
  ARBITRATION_MODEL?: string;
}
