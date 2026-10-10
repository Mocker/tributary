# 🌊 Tributary — Agent-Native Code Collaboration Plane

> **"GitHub coordinates humans. Tributary coordinates agents."**  
> *Target Competition:* Cloudflare Challenge **"Build the next GitHub"**  
> *Submission Deadline:* **October 14, 2026, 11:59 PM PDT**  
> *License:* **MIT** (see [LICENSE](LICENSE))

---

## ⚡ The Core Problem

Git’s collaboration primitives — branches, textual 3-way merges, human pull requests — assume **human speed and human judgment**:
1. **Agents work concurrently at machine speed**: Dozens or hundreds of agent runs colliding on the same files cause massive merge conflict thrashing.
2. **Agents lose shared context between runs**: As interfaces evolve, agents work on outdated assumptions.
3. **Review volume explodes**: Agents generate code at a volume no human engineering team can manually review.

**Git finds out about conflicts at merge time. Tributary finds out at claim time.**

---

## 🚀 The Three Pillars of Tributary

```
agents (any client: scripts, MCP clients, IDE agents)
   │  HTTPS + git smart-HTTP
   ▼
┌─ Tributary Worker (Hono API) ─────────────────────────┐
│  POST /v1/proposals → fork baseline via Artifacts      │
│  POST /v1/proposals/:id/claims → overlap check        │
│  POST /v1/proposals/:id/gates/:g/run → attestation    │
│  POST /v1/proposals/:id/merge → gated merge           │
│  GET  /v1/proposals/:id/events (SSE context bus)      │
│  GET  /v1/learnings · POST /v1/interventions/:id/...  │
└──────────┬───────────────────────────────┬────────────┘
           │                               │
   ┌───────▼────────┐            ┌─────────▼──────────┐
   │ ChangeProposal │            │ Cloudflare         │
   │ Durable Object │            │ Artifacts          │
   │ (one per       │            │ (repos, forks,     │
   │  proposal:     │            │  git smart-HTTP,   │
   │  claims, gates,│            │  scoped tokens)    │
   │  merge state)  │            └────────────────────┘
   └────────────────┘
```

1. **Prevent conflicts before compute is spent**:  
   Claim-based intent declaration with semantic overlap detection (paths + symbol mapping via `tributary.symbols.json`). Overlaps are rejected at claim time with actionable 1-sentence explanations.
2. **Verify by attestation, not human review**:  
   Verification gates execute deterministic test invariants and emit cryptographically signed HMAC attestations. Merges are gated on passing attestations.
3. **Make every resolution compound**:  
   Instructive failures and resolved conflicts crystallize into durable markdown rules in `.git/learnings/` (epistemic memory) stored directly inside the repository.
4. **Compare-And-Swap (CAS) Protection**:  
   Guards against race conditions on mainline. If the target ref moved while an agent was running gates, merge returns `409 { code: "ref_moved" }` prompting a clean rebase and re-attestation.

---

## 🛠️ Repository Layout

```text
tributary/
├── docs/
│   ├── BUILD_PLAN.md               # Complete competition handoff and build plan
│   ├── decisions.md                # Architectural decisions log (1 line per decision)
│   ├── artifacts-notes.md          # Cloudflare Artifacts capabilities and verified behavior
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
│   │   └── learnings.ts            # Epistemic memory note generator
│   └── do/
│       └── change-proposal.ts      # ChangeProposal Durable Object (single-writer state)
├── test/
│   ├── overlap.test.ts             # Overlap detection tests
│   ├── attestation.test.ts         # Cryptographic signing tests
│   └── merge-gate.test.ts          # Merge gating and CAS tests
├── scripts/
│   └── run-demo-script.ts          # Rehearses the complete 6-act competition video demo
├── wrangler.jsonc                  # Cloudflare Workers + Artifacts configuration
├── LICENSE                         # MIT License
└── package.json
```

---

## 📦 Run Instructions (For Judges & Developers)

**Live deployment:** https://tributary.sokercap.workers.dev — radar UI + full `/v1` API on Workers + Artifacts + Durable Objects.

### Prerequisites

Node 24+, npm. No Docker, no Devbox, no Cloudflare account needed for the local path.

### 1. Run the test suite

```bash
npm install
npm test         # 23 tests: overlap detection, HMAC attestations, CAS merge gate,
                 # Z3 machine-checked invariants, CoordinatorDO (incl. the
                 # cross-isolate 409 regression test)
npm run typecheck
```

### 2. Run the worker locally

```bash
npm run dev      # Worker + radar UI at http://localhost:8787
```

Drive the API directly:

```bash
# Mint a proposal (real Artifacts fork when deployed with the binding)
curl -X POST localhost:8787/v1/proposals \
  -H 'Content-Type: application/json' \
  -d '{"baseline":"demo-shop","taskRef":"AUTH-101","agentId":"agent-a"}'

# Claim before you work — overlapping claims get HTTP 409 here,
# not a merge conflict three hours later
curl -X POST localhost:8787/v1/proposals/<id>/claims \
  -H 'Content-Type: application/json' \
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

## 🎬 The 6-Act Competition Demo

1. **Act 1 (Problem):** Two agents edit `src/session.ts` concurrently; standard Git discovers the conflict only at merge time.
2. **Act 2 (Prevention):** Agent A claims `src/auth/**` + `createSession`. Agent B claims `src/session.ts` → instant **HTTP 409**: *"conflicts with Agent A's claim on src/session.ts (symbol createSession)"*. The CoordinatorDO (single-writer Durable Object) makes this atomic across all Workers isolates — verified live. Zero compute wasted.
3. **Act 3 (Verification):** Agent B narrows its claim, runs gate `test`, and records an HMAC-signed attestation on the exact commit SHA.
4. **Act 4 (Memory):** The session-boundary invariant crystallizes into `.git/learnings/` via the API.
5. **Act 5 (Scale):** Fork-per-proposal in Artifacts — median **3.08s** end-to-end per fork (measured live, n=5). Parallelize the scale shot; 50 serial forks ≈ 2.5 min.
6. **Act 6 (Close):** *"GitHub coordinates humans. Tributary coordinates agents."*

---

## 📄 License

MIT License. Copyright (c) 2026 Ryan Guthrie.
