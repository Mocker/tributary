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

## 2. Invariants & Nuances
1. **Fork Terminology**: Do not claim "zero-copy/O(1) forks". That phrasing is non-canonical. Always report empirically measured fork latency from Phase 0 spike tests.
2. **Miniflare Limitation**: Miniflare local simulation of Artifacts acts as a remote proxy to Cloudflare's edge storage. Local offline emulation without an API token requires mock fixtures.
3. **Token Scoping**: Scoped write tokens are locked to the specific micro-fork (`demo-shop__p_<ulid>`) and expire automatically after their TTL. Mainline repo write tokens are strictly held by the Tributary Worker.
