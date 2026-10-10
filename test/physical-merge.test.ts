import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import git from 'isomorphic-git';
import { MemoryFS } from '../src/memory-fs';
import {
  applyMerge,
  MergeConflictError,
} from '../src/core/physical-merge';

const author = { name: 'Agent A', email: 'agent-a@tributary.local' };
const committer = { name: 'Tributary', email: 'merge@tributary.local' };

async function mkRepo(): Promise<string> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tributary-merge-'));
  await git.init({ fs, dir, defaultBranch: 'main' });
  return dir;
}

async function commitFile(
  dir: string,
  filepath: string,
  content: string,
  message: string
): Promise<string> {
  fs.writeFileSync(path.join(dir, filepath), content);
  await git.add({ fs, dir, filepath });
  return git.commit({
    fs,
    dir,
    message,
    author: { ...author, timestamp: 1700000000, timezoneOffset: 0 },
  });
}

test('physical-merge: fast-forwards when fork is a descendant', async () => {
  const dir = await mkRepo();
  const base = await commitFile(dir, 'a.txt', 'a', 'base');
  const forkHead = await commitFile(dir, 'b.txt', 'b', 'fork work');
  await git.branch({ fs, dir, ref: 'fork/main', object: forkHead, checkout: false });
  // move main back so fork/main is strictly ahead
  await git.branch({ fs, dir, ref: 'main', object: base, force: true, checkout: false });

  const res = await applyMerge({
    fs,
    dir,
    baselineBranch: 'main',
    forkRef: 'fork/main',
    author,
    committer,
  });

  assert.equal(res.fastForward, true);
  assert.equal(res.mergedSha, forkHead);
  assert.equal(await git.resolveRef({ fs, dir, ref: 'main' }), forkHead);
});

test('physical-merge: creates a merge commit on divergence (author=agent, committer=Tributary)', async () => {
  const dir = await mkRepo();
  const base = await commitFile(dir, 'a.txt', 'a', 'base');
  await git.branch({ fs, dir, ref: 'fork/main', object: base, checkout: false });

  // advance main
  await commitFile(dir, 'main.txt', 'm', 'main work');
  // advance fork
  await git.checkout({ fs, dir, ref: 'fork/main' });
  const forkHead = await commitFile(dir, 'fork.txt', 'f', 'fork work');

  const res = await applyMerge({
    fs,
    dir,
    baselineBranch: 'main',
    forkRef: 'fork/main',
    author,
    committer,
  });

  assert.equal(res.fastForward, false);
  const mainHead = await git.resolveRef({ fs, dir, ref: 'main' });
  assert.equal(res.mergedSha, mainHead);
  const commit = await git.readCommit({ fs, dir, oid: mainHead });
  assert.equal(commit.commit.parent.length, 2);
  assert.ok(commit.commit.parent.includes(forkHead));
  assert.equal(commit.commit.author.name, 'Agent A');
  assert.equal(commit.commit.committer.name, 'Tributary');
});

test('physical-merge: throws MergeConflictError on conflicting changes', async () => {
  const dir = await mkRepo();
  const base = await commitFile(dir, 'x.txt', 'base', 'base');
  await git.branch({ fs, dir, ref: 'fork/main', object: base, checkout: false });

  await commitFile(dir, 'x.txt', 'main version', 'main work');
  await git.checkout({ fs, dir, ref: 'fork/main' });
  await commitFile(dir, 'x.txt', 'fork version', 'fork work');

  await assert.rejects(
    applyMerge({ fs, dir, baselineBranch: 'main', forkRef: 'fork/main', author, committer }),
    (e: any) => e instanceof MergeConflictError
  );
});

test('physical-merge: no-op when already merged', async () => {
  const dir = await mkRepo();
  const head = await commitFile(dir, 'a.txt', 'a', 'base');
  await git.branch({ fs, dir, ref: 'fork/main', object: head, checkout: false });

  const res = await applyMerge({
    fs,
    dir,
    baselineBranch: 'main',
    forkRef: 'fork/main',
    author,
    committer,
  });
  assert.equal(res.fastForward, true);
  assert.equal(res.mergedSha, head);
});

test('physical-merge: works against MemoryFS (the Worker fs)', async () => {
  // Exercises the exact filesystem the Worker uses, including rm/readlink
  // handling that isomorphic-git requires.
  const fs = new MemoryFS();
  const dir = '/repo';
  await git.init({ fs, dir, defaultBranch: 'main' });
  const base = await (async () => {
    await fs.promises.writeFile(`${dir}/a.txt`, 'a');
    await git.add({ fs, dir, filepath: 'a.txt' });
    return git.commit({
      fs, dir, message: 'base',
      author: { ...author, timestamp: 1700000000, timezoneOffset: 0 },
    });
  })();
  const forkHead = await (async () => {
    await fs.promises.writeFile(`${dir}/b.txt`, 'b');
    await git.add({ fs, dir, filepath: 'b.txt' });
    return git.commit({
      fs, dir, message: 'fork work',
      author: { ...author, timestamp: 1700000001, timezoneOffset: 0 },
    });
  })();
  await git.branch({ fs, dir, ref: 'fork/main', object: forkHead, checkout: false });
  await git.branch({ fs, dir, ref: 'main', object: base, force: true, checkout: false });

  const res = await applyMerge({
    fs, dir, baselineBranch: 'main', forkRef: 'fork/main', author, committer,
  });
  assert.equal(res.fastForward, true);
  assert.equal(res.mergedSha, forkHead);
});
