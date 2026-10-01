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

### 1. Devbox Container Launch

Tributary is pre-configured with Ryan's isolated Docker Devbox environment:

```bash
# Launch isolated Devbox container with port 8787 forwarded
devbox start tributary -p 8787:8787

# Connect to container shell
devbox shell tributary
```

### 2. Run Deterministic Unit Tests

```bash
# Run the pure logic test suite (overlap detection, HMAC attestations, CAS merge gate)
npm test
```

### 3. Run the Competition Demo Rehearsal

```bash
# Run the end-to-end 6-act simulation script matching Section 9 of the build plan
npm run simulate
```

### 4. Run Cloudflare Workers Dev Server

```bash
# Start local Hono worker and live Radar UI at http://localhost:8787
npm run dev
```

---

## 🎬 The 6-Act Competition Demo Summary

1. **Act 1 (Problem)**: Shows how standard Git fails when Agent A and Agent B concurrently edit `src/session.ts` and discover conflicts only at merge time.
2. **Act 2 (Prevention)**: Agent A claims `src/auth/**` + `createSession`. Agent B attempts to claim `src/session.ts` and receives instant **HTTP 409 Conflict**: *"conflicts with Agent A's claim on src/session.ts (symbol createSession)"*. Zero compute wasted!
3. **Act 3 (Verification)**: Agent B fixes a bug and runs gate `test`. Fails first, fixes, and passes with signed HMAC attestation.
4. **Act 4 (Memory)**: Invariant rule is crystallized directly into `.git/learnings/` in the repository.
5. **Act 5 (Scale)**: Rapid fork latency benchmark demonstrating that fork-per-task in Artifacts enables tens of thousands of concurrent agents.
6. **Act 6 (Close)**: Core thesis recap — *"GitHub coordinates humans. Tributary coordinates agents."*

---

## 📄 License

MIT License. Copyright (c) 2026 Ryan Guthrie.
