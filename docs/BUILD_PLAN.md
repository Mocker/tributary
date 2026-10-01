# Tributary — build plan (handoff to coding agent)

**Competition:** Cloudflare Challenge "Build the next GitHub" — submit by **Oct 14, 2026, 11:59 PM PDT**.
**Internal target:** code-complete Oct 11, submitted Oct 12 (48h buffer).
**Name:** Tributary. **License:** MIT (LICENSE file in repo root from day one).

---

## 1. What this is (memorize before writing code)

Tributary is an **agent-native code collaboration plane**. It is NOT a git host, NOT a prettier PR UI, NOT "GitHub with a chatbot."

**Thesis:** Git's collaboration primitives — branches, textual merges, human PR review — assume human speed and human judgment. Coding agents violate all three assumptions: they work concurrently at machine speed, they lose shared context between runs, and they generate review volume no human can clear. Tributary is the coordination + verification plane that sits in front of git:

1. **Prevent conflicts before compute is spent** (claim-based intent declaration with semantic overlap detection at claim time — not a merge conflict after the fact).
2. **Verify by attestation, not human review** (typed verification gates emit signed attestations; merge happens when gates attest).
3. **Make every resolution compound** (conflicts and failures crystallize into durable rules stored in the repo itself).

**Positioning line for the demo:** "GitHub coordinates humans. Tributary coordinates agents."

---

## 2. Hard constraints (from the official competition rules — do not violate)

- **Must use Cloudflare Workers AND Cloudflare Artifacts.** Both, not one.
- Repo must be public with an **MIT, Apache-2.0, or BSD license** and a LICENSE file. We chose MIT.
- **Original work.** Do not copy another entry or an existing product's core.
- Submission = **5–10 min demo video** + open-source code + **run instructions** a judge can follow.
- Solo entry is eligible. One submission per entrant.
- **IP caution:** submissions are non-confidential and Cloudflare receives a broad license to submitted materials. Never commit secrets, tokens, personal data, or anything that must stay private. Assume everything in the repo is public forever.

---

## 3. Architecture

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
