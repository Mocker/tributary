// Artifacts types are the real globals from @cloudflare/workers-types.
// Verified against the live binding 2026-10-10:
// - get() THROWS ArtifactsError NOT_FOUND for a missing repo (never null)
// - create()/fork() return ArtifactsCreateRepoResult (metadata + initial
//   token), NOT a repo handle — re-get() the handle afterwards
// - repo metadata comes from info()/log(), createToken() returns
//   { id, plaintext, scope, expiresAt: ISO-8601 string }

export interface MicroForkResult {
  forkName: string;
  remoteUrl: string;
  token: string;
  /** ISO-8601 expiry timestamp (as returned by the binding). */
  expiresAt: string;
}

/** True when err is the binding's NOT_FOUND (missing repo), by code or message. */
export function isArtifactsNotFound(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  return (
    (err as { code?: string }).code === 'NOT_FOUND' ||
    /not found/i.test(err.message)
  );
}

export class ArtifactsClient {
  constructor(private artifacts: Artifacts) {}

  /**
   * Initializes or gets the primary base repository
   */
  async ensureBaseRepo(repoName: string): Promise<ArtifactsRepo> {
    try {
      return await this.artifacts.get(repoName);
    } catch (err) {
      if (!isArtifactsNotFound(err)) throw err;
    }
    await this.artifacts.create(repoName);
    return this.artifacts.get(repoName);
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
    const forked = await base.fork(forkName);

    // Mint scoped, short-lived Git write token for this micro-fork
    const forkHandle = await this.artifacts.get(forkName);
    const { plaintext, expiresAt } = await forkHandle.createToken(
      'write',
      ttlSeconds
    );

    return {
      forkName,
      remoteUrl: forked.remote,
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
