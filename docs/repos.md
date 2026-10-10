# Tributary repo management

How code lives in Tributary: one namespace, long-lived baselines, short-lived
per-proposal forks, and short-lived scoped tokens. Written 2026-10-10.

## The shape

- **One Artifacts namespace**: `tributary`. Every repo Tributary manages lives
  here. Namespace is bound to the Worker as `env.ARTIFACTS`.
- **Baseline repos** (long-lived): the reviewed mainlines agents work from.
  `demo-shop` is the first. Created by `scripts/seed-baseline.ts`, which calls
  `POST /v1/admin/seed` (Worker creates the repo via the binding, mints a
  10-minute write token) and then pushes the local folder over git smart-HTTP
  with a `Bearer` header — the token never lands in the remote URL.
- **Proposal forks** (short-lived): `POST /v1/proposals { baseline }` calls
  `repo.fork('<baseline>__p_<ulid>')`. One fork per proposal: an agent's
  private workspace. Forks are cheap; ten thousand agents is an addressing
  problem, not a storage problem.
- **Scoped tokens** (short-lived): each proposal mints
  `repo.createToken('write', 3600)`. Agents authenticate git with
  `git -c http.extraHeader="Authorization: Bearer <token>"`. Read scope
  allows clone/fetch/pull; write adds push. A recipient needs no Cloudflare
  account of their own — just the remote URL and a token.

## The agent git flow (the "plug in your coding agents" path)

1. `POST /v1/proposals { baseline, taskRef, agentId }` → `{ proposalId, forkRemote, token, tokenExpiresAt }`
2. `git clone` the fork remote (Bearer header) → work → commit → `git push`
3. `POST /v1/proposals/:id/gates/test/run { commitSha }` → HMAC-signed attestation
4. `POST /v1/proposals/:id/merge` → gated merge into the baseline

## What's real vs planned (2026-10-10)

- **Real**: namespace binding, `create`/`get`/`fork`/`createToken`, git
  smart-HTTP remotes, overlap detection, HMAC attestation signing/verification,
  merge-gate evaluation (live claims + attestations on the exact SHA + CAS on
  the target ref), claim leases + heartbeats, SSE context bus, radar UI.
- **Planned, not built**: the *physical* merge — the merge route currently
  marks the proposal DO merged, releases claims, and crystallizes learnings,
  but does not yet execute the git-level fast-forward/three-way merge of the
  fork into the baseline mainline via Artifacts. Also planned: the 24h fork
  sweeper, and a real gate executor (today the gate asserts verdicts; see
  `docs/BUILD_PLAN.md` §11).
- **Simulation button** (`POST /v1/admin/simulate`, radar "Run Swarm
  Simulation"): a synthetic scenario rehearsal. The overlap detection,
  attestation signing, and learning crystallization it exercises are the real
  algorithms, but the agents, repos, and commits are fabricated in-memory —
  no Artifacts calls, no git. It is a demo of the coordination logic, not an
  end-to-end run. The real end-to-end path is the agent git flow above, once
  a baseline is seeded.
