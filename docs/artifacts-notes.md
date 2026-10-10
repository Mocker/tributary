# Cloudflare Artifacts: Capabilities, Signatures & Integration Notes

Log of verified Cloudflare Artifacts capabilities, binding signatures, and observations during Tributary development.

---

## 1. Verified API Surface (as of 2026-10-01)

### Namespace Binding (`env.ARTIFACTS`)
Exposed via `[[artifacts]]` in `wrangler.jsonc`. Namespace methods:
- `env.ARTIFACTS.create(repoName: string): Promise<{ remote: string; token: string; repo: ArtifactRepo }>`
- `env.ARTIFACTS.get(repoName: string): Promise<ArtifactRepo | null>`
- `env.ARTIFACTS.list(): Promise<Array<{ name: string; namespace: string }>>`
- `env.ARTIFACTS.import(repoName: string, sourceGitUrl: string): Promise<ArtifactRepo>`
- `env.ARTIFACTS.delete(repoName: string): Promise<void>`

### Repository Handle (`ArtifactRepo`)
Object returned from `create`, `get`, `import`, or `fork`:
- `repo.createToken(scope: 'read' | 'write' | 'admin', ttlSeconds: number): Promise<{ token: string; plaintext: string; expiresAt: number }>`
- `repo.listTokens(): Promise<Array<{ id: string; scope: string; expiresAt: number }>>`
- `repo.revokeToken(tokenId: string): Promise<void>`
- `repo.fork(forkName: string, options?: { bare?: boolean; branch?: string }): Promise<{ remote: string; token: string; repo: ArtifactRepo }>`

### Smart HTTP Git Protocol Shape
- Endpoint: `https://<ACCOUNT_ID>.artifacts.cloudflare.net/git/<namespace>/<repo>.git`
- Protocols supported:
  - Git fetch: wire protocol v1 and v2
  - Git push: wire protocol v1
- Auth token format: `art_v1_<hex>?expires=<unix>` passed via HTTP Basic Auth (`git:<token>`) or Bearer header.

---

---

## 2. Invariants & Nuances
1. **Fork Terminology**: Do not claim "zero-copy/O(1) forks". That phrasing is non-canonical. Always report empirically measured fork latency from Phase 0 spike tests.
2. **Miniflare Limitation**: Miniflare local simulation of Artifacts acts as a remote proxy to Cloudflare's edge storage. Local offline emulation without an API token requires mock fixtures.
3. **Token Scoping**: Scoped write tokens are locked to the specific micro-fork (`demo-shop__p_<ulid>`) and expire automatically after their TTL. Mainline repo write tokens are strictly held by the Tributary Worker.

---

## 3. Deployment prerequisites (verified 2026-10-10)

- **Wrangler ≥ 4.84.0 required.** The `[[artifacts]]` binding config key was added
  in wrangler 4.84.0 (workers-sdk PR #13326). Wrangler 3.114.17 warns
  `Unexpected fields found in top-level field: "artifacts"` and silently drops
  the binding — the deployed Worker then falls back to the mock Artifacts
  handle in `getOrInitArtifacts` (src/index.ts), which would fake every fork.
  Repo still pins 3.114.17 in package.json; deploy with
  `npx -y wrangler@4 deploy` (does not touch the repo pin) until the pin is
  deliberately upgraded.
- **Workers Paid plan required.** Deploying a Worker with an Artifacts binding
  on a Free-plan account fails at script upload with API error 10403:
  "In order to use Artifacts, you must switch to a paid plan". Activate at
  dash.cloudflare.com → Workers → Plans ($5/mo) before deploying.
- **Secrets vs vars:** `GATE_HMAC_SECRET` must be set via
  `wrangler secret put GATE_HMAC_SECRET` and must NOT appear in wrangler.jsonc
  `vars` — wrangler replaces the remote secret with the plain `vars` value on
  every deploy. Keep only `ENVIRONMENT` / `DEFAULT_BASELINE_REPO` in `vars`.
- **KV namespace** `TRIBUTARY_KV` id `8221143a7e76470a897ce32612a52acd`
  (created 2026-10-10) is committed in wrangler.jsonc — required for deploy.
- **Deployed resources (2026-10-10 attempt):** Worker name `tributary`
  (placeholder shell exists; real deploy pending paid plan),
  `tributary.<account>.workers.dev` URL reserved. Radar UI assets (3 files,
  150KB JS) uploaded successfully on the failed attempt — they persist and
  will attach on the next successful deploy.

## 4. Real fork-latency measurements

Measured 2026-10-10 against the live binding (Worker `tributary`, paid plan
active). Method: 5× `POST /v1/proposals { baseline: "demo-shop" }` timed
end-to-end — this covers `repo.fork()` + `createToken('write')` + DO init,
so it is an upper bound on pure fork latency, not the fork RPC alone:

- min 2.73s, **median 3.08s**, max 4.05s (n=5)
- Forks are real git repos: `git ls-remote` on a fork remote with the minted
  `art_v2_*` Bearer <redacted> returns HEAD = the seeded baseline SHA
  (`5483b1a6…`), `refs/heads/main` present.

Act 5 implication: at ~3s per fork, 50 serial forks ≈ 2.5 min — the demo's
scale segment should fork in parallel (or pre-record); the "addressing
problem, not a storage problem" line holds, with measured numbers behind it.

---

---

