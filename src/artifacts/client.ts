import { ArtifactsBinding, ArtifactRepo } from '../env';

export interface MicroForkResult {
  forkName: string;
  remoteUrl: string;
  token: string;
  expiresAt: number;
}

export class ArtifactsClient {
  constructor(private artifacts: ArtifactsBinding) {}

  /**
   * Initializes or gets the primary base repository
   */
  async ensureBaseRepo(repoName: string): Promise<ArtifactRepo> {
    const existing = await this.artifacts.get(repoName);
    if (existing) {
      return existing;
    }
    const { repo } = await this.artifacts.create(repoName);
    return repo;
  }

  /**
   * Spawns an instant, zero-copy micro-fork for an agent task
   */
  async spawnMicroFork(
    baseRepo: string,
    agentTaskId: string,
    ttlSeconds: number = 3600
  ): Promise<MicroForkResult> {
    const forkName = `${baseRepo}-task-${agentTaskId}`;

    // Cloudflare Artifacts programmatic fork primitive
    const { remote, repo } = await this.artifacts.fork(baseRepo, forkName);

    // Mint scoped, short-lived Git write token for this micro-fork
    const { plaintext, expiresAt } = await repo.createToken('write', ttlSeconds);

    return {
      forkName,
      remoteUrl: remote,
      token: plaintext,
      expiresAt,
    };
  }

  /**
   * Merges or dissolves an ephemeral micro-fork after verification
   */
  async dissolveMicroFork(forkName: string): Promise<void> {
    await this.artifacts.delete(forkName);
  }
}
