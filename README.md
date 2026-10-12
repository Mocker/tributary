# 🌊 Tributary — Agent-Native Code Collaboration Plane

> **"GitHub coordinates humans. Tributary coordinates agents."**  
> *Target Competition:* Cloudflare Challenge **"Build the next GitHub"**  
> *Submission Deadline:* **October 14, 2026, 11:59 PM PDT**  
> *Live Edge Deployment:* **[https://tributary.sokercap.workers.dev](https://tributary.sokercap.workers.dev)** (Workers + Artifacts + Durable Objects)  
> *Demo Video:* **[🎬 6-Minute Walkthrough Video](https://youtu.be/placeholder-tributary-demo)** *(Competition Submission)*  
> *License:* **MIT** (see [LICENSE](LICENSE))

---

## ⚡ The Core Problem

Git’s collaboration primitives — branches, textual 3-way merges, human pull requests — assume **human speed and human judgment**:
1. **Agents work concurrently at machine speed**: Dozens or hundreds of agent runs colliding on the same files cause massive merge conflict thrashing.
2. **Agents lose shared context between runs**: As interfaces evolve, agents work on outdated assumptions.
3. **Review volume explodes**: Agents generate code at a volume no human engineering team can manually review.

**Git finds out about conflicts at merge time. Tributary finds out at claim time.**

---

## 🚀 The Pillars of Tributary

```
agents (any client: scripts, MCP clients, IDE agents)
   │  HTTPS + git smart-HTTP
   ▼
┌─ Tributary Worker (Hono API) ─────────────────────────┐
│  POST /v1/admin/keys → mint per-agent API key         │
│  POST /v1/proposals → fork baseline via Artifacts     │
│  POST /v1/proposals/:id/claims → overlap check        │
│  POST /v1/proposals/:id/gates/:g/run → attestation    │
│  POST /v1/proposals/:id/merge → real git merge        │
│  GET  /v1/proposals/:id/events (SSE context bus)      │
│  GET  /v1/learnings · POST /v1/interventions/:id/...  │
└──────────┬───────────────────────────────┬────────────┘
           │                               │
   ┌───────▼────────┐            ┌─────────▼──────────┐
   │ CoordinatorDO  │            │ Cloudflare         │
   │ (global claim  │            │ Artifacts          │
   │  index, single │            │ (repos, forks,     │
   │  writer) +     │            │  git smart-HTTP,   │
   │ ChangeProposal │            │  scoped tokens)    │
   │ DO per proposal│            └────────────────────┘
   └────────────────┘
```

1. **Prevent conflicts before compute is spent**:  
   Claim-based intent declaration with semantic overlap detection (paths + symbol mapping via `tributary.symbols.json`). Overlaps are rejected at claim time with actionable 1-sentence explanations.
2. **Verify by attestation, not human review**:  
   Verification gates execute deterministic test invariants and emit cryptographically signed HMAC attestations. Merges are gated on passing attestations — and the merge itself is a real git merge executed in the Worker (isomorphic-git): fast-forward when clean, a true merge commit otherwise, pushed with CAS protection.
3. **Make every resolution compound**:  
   Instructive failures and resolved conflicts crystallize into durable markdown rules in `learnings/` (epistemic memory) — versioned files committed in the same push as the merge, so they survive every clone.
4. **Compare-And-Swap (CAS) Protection**:  
   Guards against race conditions on mainline. If the target ref moved while an agent was running gates, merge returns `409 { code: "ref_moved" }` prompting a clean rebase and re-attestation.

---

## ⚡ Why Cloudflare Artifacts? (The Substrate Advantage)

Tributary is not merely "hosted on Cloudflare" — **it fundamentally could not exist on traditional Git hosting or GitHub**:

```text
Legacy Git / GitHub                     Cloudflare Artifacts + Tributary
──────────────────────────────────      ────────────────────────────────────────
Heavyweight forks (3–15s queues)        Sub-200ms edge micro-forks (repo.fork)
Broad, long-lived PATs / OAuth          Task-scoped auto-expiring write tokens
Centralized storage → CI transit        Edge co-located: Workers + DOs + Artifacts
Textual 3-way merge conflicts           Claim-time atomic overlap prevention (CoordinatorDO)
Human PR review bottlenecks             Deterministic gates emitting HMAC attestations
Epistemic memory lost in PR comments    Durable rules synthesized into git history (learnings/)
```

> **The Scale Thesis:** *"Forking a repository per agent task is fast enough (~130ms median) that running 10,000 concurrent agent runs is an addressing problem, not a storage bottleneck."*  
> See the deep-dive whitepaper: [docs/why-cloudflare-artifacts.md](docs/why-cloudflare-artifacts.md).

---

## 🛠️ Repository Layout

```text
tributary/
├── docs/
│   ├── BUILD_PLAN.md               # Complete competition handoff and build plan
│   ├── CLOUDFLARE_CHALLENGE_REVIEW.md # Competition review & judging rubric alignment
│   ├── why-cloudflare-artifacts.md # Whitepaper: why Artifacts is the only viable substrate
│   ├── mcp.md                      # Model Context Protocol (MCP) server reference
│   ├── decisions.md                # Architectural decisions log (1 line per decision)
│   ├── artifacts-notes.md          # Cloudflare Artifacts capabilities and verified behavior
│   ├── repos.md                    # Namespace and baseline/fork lifecycle design
│   └── spikes/
│       └── phase0-spikes.md        # Fork latency and gate execution spike notes
├── demo-shop/                      # Demo victim repo (e-commerce API)
│   ├── tributary.symbols.json      # Symbol-to-file mapping index
│   ├── src/
│   │   ├── session.ts              # Shared module trap (auth + billing)
│   │   ├── auth/login.ts           # Imports session
│   │   └── billing/checkout.ts     # Imports session
│   └── test/session.test.ts        # Unit test invariants
├── src/
│   ├── index.ts                    # Main Hono Worker & /v1 API routes
│   ├── env.d.ts                    # Cloudflare Workers environment typings
│   ├── types/index.ts              # Core data models (ChangeProposal, Claim, Attestation)
│   ├── core/
│   │   ├── overlap.ts              # Path & symbol overlap detection engine
│   │   ├── attestation.ts          # HMAC-SHA256 signature generator & validator
│   │   ├── merge-gate.ts           # Gated merge logic with CAS validation
│   │   ├── physical-merge.ts       # Real git merge in-Worker (isomorphic-git)
│   │   ├── api-keys.ts             # Per-agent API key issuance & verification
│   │   └── learnings.ts            # Epistemic memory note generator
│   ├── mcp/
│   │   └── server.ts               # Model Context Protocol (MCP) server implementation
│   ├── memory-fs.ts                # In-memory FS for isomorphic-git in Workers
│   └── do/
│       ├── coordinator.ts          # CoordinatorDO: global atomic claim index
│       └── change-proposal.ts      # ChangeProposal Durable Object (per-proposal state)
├── ui/                             # Radar Console: React 18 + Vite live ops dashboard
│   ├── src/
│   │   ├── App.tsx                 # Live claims, queue, attestations & Judge Tour
│   │   ├── api.ts                  # REST + SSE real-time connection client
│   │   └── index.css               # Ops-console theme (Workers Assets served)
│   └── vite.config.ts              # Static build config (output to ui/dist)
├── test/
│   ├── overlap.test.ts             # Overlap detection tests
│   ├── attestation.test.ts         # Cryptographic signing tests
│   ├── merge-gate.test.ts          # Merge gating and CAS tests
│   ├── merge-invariants.test.ts    # Z3 solver machine-checked invariants
│   ├── mcp.test.ts                 # Model Context Protocol (MCP) tool tests
│   ├── physical-merge.test.ts      # Real merge scenarios against local git
│   ├── api-keys.test.ts            # API key generation & hashing
│   └── coordinator.test.ts         # Global claim index tests
├── scripts/
│   ├── run-demo-script.ts          # Rehearses the complete 6-act competition video demo
│   ├── mcp-server.ts               # Standalone MCP stdio server entrypoint
│   └── seed-baseline.ts            # Seeds baseline repos into Artifacts via git smart-HTTP
├── wrangler.jsonc                  # Cloudflare Workers + Artifacts + DO + Assets config
├── LICENSE                         # MIT License
└── package.json
```

---

## 📦 Run Instructions (For Judges & Developers)

**Live deployment:** https://tributary.sokercap.workers.dev — radar UI + full `/v1` API on Workers + Artifacts + Durable Objects.  
*Tip for judges:* Click **"📖 Judge API Tour"** directly in the Radar UI header for interactive, 1-click copyable `curl` commands against the live edge deployment.

### Prerequisites

Node 24+, npm. No Docker, no Devbox, no Cloudflare account needed for the local path.

### 1. Run the test suite

```bash
npm install
npm test         # 32 tests: overlap detection, HMAC attestations, CAS merge gate,
                 # Z3 machine-checked invariants, CoordinatorDO (incl. the
                 # cross-isolate 409 regression test), physical merge,
                 # API keys
npm run typecheck
```

### 2. Run the worker locally

```bash
npm run dev      # Worker + radar UI at http://localhost:8787
```

Drive the API directly (mutating routes need a Bearer API key):

```bash
# Mint an API key for your agent (shown once; only the hash is stored)
KEY=$(curl -s -X POST localhost:8787/v1/admin/keys \
  -H 'Content-Type: application/json' \
  -d '{"agentId":"agent-a"}' | python3 -c "import json,sys; print(json.load(sys.stdin)['apiKey'])")

# Mint a proposal (real Artifacts fork when deployed with the binding).
# agentId comes from the key — clients can't self-assert identity.
curl -X POST localhost:8787/v1/proposals \
  -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' \
  -d '{"baseline":"demo-shop","taskRef":"AUTH-101"}'

# Claim before you work — overlapping claims get HTTP 409 here,
# not a merge conflict three hours later
curl -X POST localhost:8787/v1/proposals/<id>/claims \
  -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' \
  -d '{"paths":["src/auth/**"],"symbols":["createSession"],"rationale":"auth upgrade"}'

# Scripted 6-act scenario through the real coordinator paths:
curl -X POST localhost:8787/v1/admin/simulate
```

### 3. Run against the live deployment

```bash
# Seed the demo-shop baseline into Artifacts (once per namespace):
npm run seed -- --worker https://tributary.sokercap.workers.dev

# Then use the same /v1 API against the live worker URL.
```

### 4. Deploy your own

```bash
npx wrangler deploy   # requires a Workers Paid plan (Artifacts requirement)
```

---

## 🤖 Agent Ecosystem Integration (How External Agents Plug In)

Tributary is client-agnostic. Any coding agent (Claude Code, Cursor, Pi, Aider, Devin, or custom agent swarms) coordinates through Tributary using standard git smart-HTTP and REST:

1. **Authentication:** The agent or harness receives a task key (`trib_...`) minted via `POST /v1/admin/keys`.
2. **Workspace Provisioning:** The agent requests a workspace via `POST /v1/proposals { baseline, taskRef }`. Tributary forks the baseline in Cloudflare Artifacts (`demo-shop__p_<ulid>`) and mints a 1-hour scoped git write token.
3. **Claim Intent (Collision Check):** Before modifying files, the agent declares intent:
   `POST /v1/proposals/:id/claims { paths, symbols, rationale }`.
   If another agent holds a conflicting lease, Tributary returns **HTTP 409** immediately — preventing wasted LLM drafting compute.
4. **Git Clone & Work:** The agent interacts with Artifacts using standard Git:
   ```bash
   git -c http.extraHeader="Authorization: Bearer <scoped_token>" clone <fork_remote>
   # agent drafts code, runs local unit tests, and commits
   git -c http.extraHeader="Authorization: Bearer <scoped_token>" push origin HEAD:main
   ```
5. **Gated Verification:** The agent triggers verification:
   `POST /v1/proposals/:id/gates/test/run { commitSha }`.
   The gate runs deterministic invariants and returns an HMAC-signed attestation.
6. **In-Worker Physical Merge:** The agent merges via `POST /v1/proposals/:id/merge`. The Worker evaluates the CAS guard, executes the merge commit in memory via `isomorphic-git`, commits any synthesized failure rules to `learnings/`, and pushes directly to the Artifacts baseline.

### 🔌 Native Model Context Protocol (MCP) Server

Tributary includes a first-class **Model Context Protocol (MCP)** server (`@modelcontextprotocol/sdk`) for coding agents like Claude Desktop, Cursor, Pi, and Aider. The MCP server exposes Tributary's coordination primitives as 10 callable tools over stdio:

```bash
# Run the local MCP server over stdio
npm run mcp
```

Add to Cursor or Claude Desktop (`claude_desktop_config.json`):
```json
{
  "mcpServers": {
    "tributary": {
      "command": "npx",
      "args": ["-y", "tsx", "scripts/mcp-server.ts"],
      "cwd": "/path/to/tributary",
      "env": {
        "TRIBUTARY_URL": "https://tributary.sokercap.workers.dev"
      }
    }
  }
}
```

When an agent attempts an overlapping claim, Tributary returns an actionable prompt payload directly to the LLM context:
> `🚨 CLAIM OVERLAP REJECTED (HTTP 409)`  
> `Reason: "conflicts with Agent A (Auth)'s claim on src/session.ts (symbol createSession)"`  
> `Action required: Zero compute wasted! Narrow your claim paths/symbols before writing code.`

See full tool schemas and documentation in [docs/mcp.md](docs/mcp.md).

---

## 🎬 The 6-Act Competition Demo

1. **Act 1 (Problem):** Two agents edit `src/session.ts` concurrently; standard Git discovers the conflict only at merge time.
2. **Act 2 (Prevention):** Agent A claims `src/auth/**` + `createSession`. Agent B claims `src/session.ts` → instant **HTTP 409**: *"conflicts with Agent A's claim on src/session.ts (symbol createSession)"*. The CoordinatorDO (single-writer Durable Object) makes this atomic across all Workers isolates — verified live. Zero compute wasted.
3. **Act 3 (Verification):** Agent B narrows its claim, runs gate `test`, and records an HMAC-signed attestation on the exact commit SHA.
4. **Act 4 (Memory):** The session-boundary invariant crystallizes into `learnings/` as a versioned file in the merge push itself.
5. **Act 5 (Scale):** Fork-per-proposal in Artifacts — median **3.08s** end-to-end per fork (measured live, n=5). Parallelize the scale shot; 50 serial forks ≈ 2.5 min.
6. **Act 6 (Close):** *"GitHub coordinates humans. Tributary coordinates agents."*

---

## 👤 Author

**Ryan Guthrie** — Senior Software Engineer / Systems Architect, building agent infrastructure on Cloudflare.

- 🌐 [ryanguthrie.com](https://ryanguthrie.com) — portfolio & résumé
- 💼 Open to remote senior backend / platform roles
- 💖 [Sponsor @Mocker on GitHub](https://github.com/sponsors/Mocker) — if Tributary is useful to you

---

## 📄 License

MIT License. Copyright (c) 2026 Ryan Guthrie.
