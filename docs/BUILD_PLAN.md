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

---

## 4. Guard gate: decision-model choice (from the 2026-10-03 "Guard Gate" brief)

Tributary's verification gate decides merges by signed attestation today. A future
*decision gate* — triaging ambiguous interventions (overlapping claims neither agent
yields) — needs a decision model. The October 2026 decision-model wave tripled the
options; the brief's verdict:

- **OpenAI Decisions API — disqualified for the demo.** Preview-gated to selected
  customers; building an Oct 14 demo on access you may never get is a non-starter.
- **AWS Decider 2B — the independence pick.** Went fully open Oct 1: weights,
  training recipe, evals, all public under Apache 2.0; small enough to run on a
  local GPU. The demo works regardless of vendor previews or Cloudflare account state.
- **Cloudflare Clef flash — the politics pick.** 39ms medians, Jev-API compatible
  (vendor numbers, as stated in the brief), and Cloudflare-native: since this entry
  is explicitly a bid for Cloudflare's attention, a Cloudflare-native decision layer
  is part of the demo's argument.

Brief's call: **Clef for the story, Decider for the safety, never Decisions for the demo.**

Caveat (from the brief): vendor benchmark numbers come from the ecosystems that
launched the models — one third-party check of OpenAI's Luna found 99%-confidence
claims landing at 68% real accuracy. Validate any decision threshold on Tributary's
own gate data either way.

**v1 scope is unchanged** (single deterministic `test` gate). The decision model is
documented here as the extension point for a future intervention-triage decision gate,
not a v1 build item.

### Agent Access Model vocabulary (Cloudflare, Oct 2026)

Tributary's security framing uses the Agent Access Model vocabulary
(https://blog.cloudflare.com/the-agent-access-model/):

- **Task-scoped, short-lived credentials**: per-proposal Artifacts tokens (TTL 1h)
  are Tributary's version — a credential minted for the task, expiring with it.
- **Mediation in the harness, not the prompt**: overlap detection and merge gating
  are enforced by the Worker/DO at the point of action, never by asking the agent nicely.
- **Trust Ratchet (capability only narrows)**: expired/superseded claims release
  paths; after the mainline moves, a rebase + re-attest cycle is required — authority
  is never silently restored.
- **Agent Identity Broker**: `agentId` + `taskRef` on every proposal; every claim,
  attestation, and merge is attributable to a task-scoped agent run.

This vocabulary belongs in the demo narrative (Acts 2–3) and the submission README.
