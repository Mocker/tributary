#!/usr/bin/env -S npx tsx
/**
 * Seeds a local folder (default ./demo-shop) as a baseline repo in the
 * Tributary Artifacts namespace.
 *
 * Flow:
 *   1. POST <worker>/v1/admin/seed { baseline } -> { remote, token }
 *      (the Worker creates the repo via the Artifacts binding — no mocks)
 *   2. Copies the folder into a temp dir, git init + single squashed commit
 *   3. Pushes over git smart-HTTP with a Bearer header (token never in the URL)
 *   4. Verifies with git ls-remote
 *
 * Idempotent: re-running against an already-seeded repo is a no-op push.
 *
 * Requires: deployed Tributary Worker (Workers Paid plan), git, tsx.
 * Usage:   npm run seed -- --worker https://tributary.<acct>.workers.dev [--baseline demo-shop] [--dir ./demo-shop]
 */
import { execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

function arg(name: string, def: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] !== undefined ? process.argv[i + 1] : def;
}

function sh(cmd: string, args: string[], cwd?: string): string {
  return execFileSync(cmd, args, { cwd, stdio: 'pipe', encoding: 'utf8' });
}

const worker = arg('worker', 'http://localhost:8787').replace(/\/$/, '');
const baseline = arg('baseline', 'demo-shop');
const dir = resolve(arg('dir', './demo-shop'));
const account = arg('account', '162681bef56337d181bf689c4b77268c');

console.log(`Seeding baseline '${baseline}' from ${dir} via ${worker} ...`);

const seedRes = await fetch(`${worker}/v1/admin/seed`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ baseline }),
});
const seed = (await seedRes.json()) as {
  remote?: string;
  token?: string;
  created?: boolean;
  error?: string;
  code?: string;
};
if (!seedRes.ok || !seed.token) {
  console.error(
    `seed endpoint failed (HTTP ${seedRes.status}): ${seed.error ?? 'unknown'} [${seed.code ?? '?'}]`
  );
  process.exit(1);
}
const remote = seed.remote ?? `https://${account}.artifacts.cloudflare.net/git/tributary/${baseline}.git`;
if (!seed.remote) console.log(`(route returned no remote; using constructed fallback)`);
console.log(`repo ${seed.created ? 'created' : 'already existed'} — remote: ${remote}`);

const tmp = mkdtempSync(join(tmpdir(), 'tributary-seed-'));
try {
  cpSync(dir, tmp, { recursive: true });
  const git = (a: string[]) => sh('git', a, tmp);
  const ident = ['-c', 'user.name=tributary-seed', '-c', 'user.email=seed@tributary.local'];
  git(['init', '-b', 'main']);
  git([...ident, 'add', '-A']);
  git([...ident, 'commit', '-m', `seed: ${baseline} baseline`, '--quiet']);

  const header = `http.extraHeader=Authorization: Bearer ${seed.token}`;
  try {
    sh('git', ['-c', header, 'push', remote, 'HEAD:main'], tmp);
    console.log('push: ok');
  } catch (e: any) {
    const out: string = String(e.stdout ?? '') + String(e.stderr ?? '');
    if (/up[- ]to[- ]date/i.test(out)) {
      console.log('push: remote already has this commit — nothing to do.');
    } else {
      throw e;
    }
  }

  const ls = sh('git', ['-c', header, 'ls-remote', remote, 'HEAD'], tmp).trim();
  if (!ls) {
    console.error('verify failed: remote has no HEAD ref');
    process.exit(1);
  }
  console.log(`verify: ${ls.split(/\s/)[0].slice(0, 12)} on ${remote}`);
  console.log(
    `\nSeeded '${baseline}'. Agents can now POST /v1/proposals { baseline: '${baseline}' } for real forks.`
  );
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
