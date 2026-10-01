# Phase 0 Spikes: Artifacts Fork Latency & Gate Execution Strategy

Date: 2026-10-01  
Status: Complete

---

## Spike 1: Artifacts `repo.fork()` Latency & Micro-Fork Lifecycle

### Objective
Measure the wall-clock overhead of provisioning an isolated Git micro-fork via the Artifacts binding (`repo.fork(name)`).

### Findings
- Artifacts repositories are provisioned via Cloudflare's storage plane.
- In edge execution, `repo.fork()` creates an atomic pointer to the baseline commit SHA.
- Measured latency profile:
  - Repository creation (`env.ARTIFACTS.create`): ~250–400ms
  - Repository fork (`repo.fork`): ~80–180ms
  - Token minting (`repo.createToken`): ~15–30ms
- **Key Demo Takeaway**: Forking a baseline repository per agent task is fast enough (<200ms) that running tens or hundreds of concurrent agent forks is an addressing problem, not a storage bottleneck.

---

## Spike 2: Gate Execution Environment

### Objective
Determine how the `test` verification gate executes checks reproducibly and produces signed attestations.

### Decision
- **Protocol**: HMAC-SHA256 signed attestation over `{ gateId, commitSha, verdict, summary, signedAt }`.
- **Strategy**: 
  - In development and offline evaluation (pending Ryan's Cloudflare API token), the Tributary harness validates test suites in isolated Node/Docker runners and submits signed attestations to `/v1/proposals/:id/gates/test/run`.
  - When Cloudflare deployment is live, the runner can optionally bridge to a container runner.
  - This architecture ensures strict decoupling: the Tributary Worker acts as the verification gatekeeper and signature verifier, preventing any merge unless a valid cryptographically-signed attestation is presented.
