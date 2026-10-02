# Tributary — Architectural & Product Decisions Log

One line per significant decision with date, adhering to the project working agreements.

- **2026-10-01**: Project renamed from OmniGit to **Tributary**; licensed under **MIT** per competition handoff plan.
- **2026-10-01**: Thesis locked: "GitHub coordinates humans. Tributary coordinates agents." Focusing on: (1) claim-time conflict prevention, (2) attestation-based verification, and (3) epistemic memory crystallization.
- **2026-10-01**: Technology stack pinned to Cloudflare Workers (TypeScript + Hono), Cloudflare Artifacts (`ARTIFACTS` binding), and Durable Objects (`ChangeProposal` DO).
- **2026-10-01**: Scope guardrails enforced: excluded full AST semantic merger, full IAM broker, and multi-gate complexity in v1; prioritizing single `test` gate, claims, and CAS merge.
- **2026-10-01**: Gate execution strategy: implemented HMAC-signed attestation verification protocol; simulated in Node unit test suite pending Cloudflare API token.
- **2026-10-01**: Demo victim repository chosen: `demo-shop` with `src/session.ts` shared between `src/auth/` and `src/billing/` as the collision trap.
- **2026-10-02**: Public GitHub repository connected (`Mocker/tributary`) and branch `main` pushed to remote origin.
- **2026-10-02**: Added global claims & proposals registry endpoints (`GET /v1/claims`, `GET /v1/proposals`) to support real-time reactive Radar UI polling.
- **2026-10-02**: Embedded 1-click interactive simulation runner (`POST /v1/admin/simulate`) directly into the Radar dashboard header for judge self-service walkthroughs.
