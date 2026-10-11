import git from 'isomorphic-git';

/**
 * Physical merge: integrate a proposal fork's commits into the baseline repo.
 *
 * Cloudflare Artifacts exposes no merge endpoint — the merge is the
 * orchestrator's job. Workers have no git binary, so this uses isomorphic-git
 * (pure JS, the documented Artifacts integration path) against an injected
 * filesystem and HTTP client. In production the Worker passes a MemoryFS and
 * `isomorphic-git/http/web`; tests pass node:fs and never touch the network.
 */

export interface GitIdentity {
  name: string;
  email: string;
}

export interface GitAuth {
  username: string;
  password: string;
}

export interface ApplyMergeInput {
  fs: any;
  dir: string;
  baselineBranch: string;
  /** Local ref of the fetched fork head, e.g. 'fork/main'. */
  forkRef: string;
  /** The agent that did the work. */
  author: GitIdentity;
  /** The coordination plane applying the merge. */
  committer: GitIdentity;
}

export interface ApplyMergeResult {
  mergedSha: string;
  fastForward: boolean;
}

export class MergeConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MergeConflictError';
  }
}

export class MainlineMovedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MainlineMovedError';
  }
}

export interface ExtraCommit {
  /** Repo-relative path -> file content. */
  files: Record<string, string>;
  message: string;
  author: GitIdentity;
  committer: GitIdentity;
}

/**
 * Decide and apply the merge once both heads are present locally.
 * Fast-forward when the fork is a descendant; otherwise a real merge commit
 * (author = agent, committer = Tributary). Throws MergeConflictError on
 * conflicting changes.
 */
export async function applyMerge(
  input: ApplyMergeInput
): Promise<ApplyMergeResult> {
  const { fs, dir, baselineBranch, forkRef } = input;

  const baselineHead = await git.resolveRef({ fs, dir, ref: baselineBranch });
  const forkHead = await git.resolveRef({ fs, dir, ref: forkRef });

  if (baselineHead === forkHead) {
    return { mergedSha: baselineHead, fastForward: true };
  }

  if (
    await git.isDescendent({ fs, dir, oid: forkHead, ancestor: baselineHead })
  ) {
    await git.branch({
      fs,
      dir,
      ref: baselineBranch,
      object: forkHead,
      force: true,
      checkout: false,
    });
    return { mergedSha: forkHead, fastForward: true };
  }

  await git.checkout({ fs, dir, ref: baselineBranch });
  try {
    const result = await git.merge({
      fs,
      dir,
      theirs: forkRef,
      author: input.author,
      committer: input.committer,
    });
    if (!result.oid) {
      throw new MergeConflictError('merge produced no commit');
    }
    return { mergedSha: result.oid, fastForward: false };
  } catch (e: any) {
    if (e instanceof MergeConflictError) throw e;
    if (e.code === 'MergeConflictError' || /merge conflict/i.test(e.message)) {
      throw new MergeConflictError(
        `Conflicting changes between fork ${forkHead.slice(0, 8)} and ` +
          `mainline ${baselineHead.slice(0, 8)}`
      );
    }
    throw e;
  }
}

/**
 * Write extra files and commit them on top of the current HEAD.
 * Used for Tributary-synthesized commits that ride the same push as the
 * merge (e.g. crystallized learnings). Exported for testing.
 */
export async function applyExtraCommits(
  fs: any,
  dir: string,
  commits: ExtraCommit[]
): Promise<string[]> {
  const shas: string[] = [];
  for (const ec of commits) {
    for (const [p, content] of Object.entries(ec.files)) {
      // mkdir -p: node:fs does not create parents on writeFile (MemoryFS does),
      // and this must work on both.
      const parent = p.split('/').slice(0, -1).join('/');
      if (parent) await fs.promises.mkdir(`${dir}/${parent}`, { recursive: true });
      await fs.promises.writeFile(`${dir}/${p}`, content);
      await git.add({ fs, dir, filepath: p });
    }
    const sha = await git.commit({
      fs,
      dir,
      message: ec.message,
      author: ec.author,
      committer: ec.committer,
    });
    shas.push(sha);
  }
  return shas;
}

export interface PhysicalMergeInput extends Omit<ApplyMergeInput, 'forkRef'> {
  http: any;
  baselineRemote: string;
  forkRemote: string;
  forkBranch?: string;
  baselineAuth: GitAuth;
  forkAuth: GitAuth;
  /** Optional Tributary-synthesized commits applied on top of the merge. */
  extraCommits?: ExtraCommit[];
}

export interface PhysicalMergeResult extends ApplyMergeResult {
  baselineHeadBefore: string;
}

/**
 * Full orchestration: clone baseline, fetch fork, merge, push.
 * The push is CAS-guarded — if mainline moved under us the server rejects
 * the non-fast-forward push and we surface MainlineMovedError (the caller
 * maps it to HTTP 409 so the agent rebases and re-attests).
 */
export async function physicalMerge(
  input: PhysicalMergeInput
): Promise<PhysicalMergeResult> {
  const { fs, http, dir } = input;
  const baselineBranch = input.baselineBranch;
  const forkBranch = input.forkBranch ?? 'main';
  const forkRef = `fork/${forkBranch}`;

  await git.clone({
    fs,
    http,
    dir,
    url: input.baselineRemote,
    ref: baselineBranch,
    singleBranch: true,
    onAuth: () => input.baselineAuth,
  });

  await git.addRemote({ fs, dir, remote: 'fork', url: input.forkRemote });
  await git.fetch({
    fs,
    http,
    dir,
    remote: 'fork',
    ref: forkBranch,
    onAuth: () => input.forkAuth,
  });

  const baselineHeadBefore = await git.resolveRef({ fs, dir, ref: baselineBranch });

  const applied = await applyMerge({
    fs,
    dir,
    baselineBranch,
    forkRef,
    author: input.author,
    committer: input.committer,
  });

  // Tributary-synthesized commits (e.g. learnings) ride the same push.
  await applyExtraCommits(fs, dir, input.extraCommits ?? []);
  const pushedSha = await git.resolveRef({ fs, dir, ref: baselineBranch });

  try {
    await git.push({
      fs,
      http,
      dir,
      url: input.baselineRemote,
      ref: baselineBranch,
      onAuth: () => input.baselineAuth,
    });
  } catch (e: any) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/non-fast-forward|fetch first|rejected/i.test(msg)) {
      throw new MainlineMovedError(
        `Mainline moved during merge (was ${baselineHeadBefore.slice(0, 8)}): ${msg}`
      );
    }
    throw e;
  }

  return { ...applied, mergedSha: pushedSha, baselineHeadBefore };
}
