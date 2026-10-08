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
   * Spawns a per-task micro-fork of the baseline repo via the repo-handle
   * fork primitive (repo.fork(name)), matching the plan's §4 API surface.
   * (Do not claim "zero-copy"/O(1) forks without measured data — see
   * docs/spikes/phase0-spikes.md for the measured latency notes.)
   */
  async spawnMicroFork(
    baseRepo: string,
    agentTaskId: string,
    ttlSeconds: number = 3600
  ): Promise<MicroForkResult> {
    const forkName = `${baseRepo}__p_${agentTaskId}`;

    // Cloudflare Artifacts programmatic fork primitive (repo handle)
    const base = await this.ensureBaseRepo(baseRepo);
    const { remote, repo } = await base.fork(forkName);

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
