# OmniGit — Autonomous Multi-Agent Git Platform

> **The next-generation version control platform built for the era of AI agents.**  
> Built natively on **Cloudflare Workers** and **Cloudflare Artifacts**, powered by **PRISM Zero-Trust Agent IAM** and **Anna AGI $T^3RL$ Test-Time Verification**.

---

## ⚡ The Core Problem

Traditional Git platforms (like GitHub and GitLab) were architected for **asynchronous human developers**:
- **Line-based diffs** lead to merge conflict thrashing when dozens of agents touch the same files.
- **Binary access controls** (read/write) allow any agent with push access to hallucinate changes into critical infrastructure (`wrangler.jsonc`, CI workflows, database schemas).
- **Context blindness** causes agents working concurrently to drift out of sync with each other's changes.
- **Amnesia**: Traditional commit history discards the agent's intent, prompt, thought process, and verification proofs.

---

## 🚀 The OmniGit Solution

OmniGit re-architects version control as an **agent-first coordination plane**:

1. **Instant Micro-Forks via Cloudflare Artifacts**:  
   Instead of polluting branches or cloning massive repos, OmniGit spins up isolated, zero-copy programmable micro-forks (`artifacts://repo-task-XYZ`) for every agent task in milliseconds.

2. **PRISM Zero-Trust Agent IAM**:  
   Every agent micro-fork is minted with fine-grained, path-level access control (e.g., UI agents can only touch `src/ui/**`; schema agents can only modify data models). Any attempt to write to forbidden files or leak secrets is blocked before touching Git.

3. **Anna-Style $T^3RL$ Test-Time Verification Gate**:  
   No code is merged into `main` without passing automated test proofs. If tests fail, the gate orchestrates automated self-remediation turns.

4. **Real-Time Swarm Presence & Invalidation (Durable Objects)**:  
   When an agent modifies an exported interface or type contract, the Swarm Coordinator broadcasts real-time invalidation events over WebSockets, preventing peer agents from drifting mid-flight.

5. **Epistemic Memory Crystallization (`.git/learnings/`)**:  
   Resolved conflicts and verified architectural patterns are automatically crystallized into `.git/learnings/` notes and embedded via Cloudflare Vectorize to guide future agents.

---

## 🛠️ Repository Layout

```text
omnigit/
├── policies/
│   └── default_agent_policy.yaml   # PRISM Zero-Trust YAML policy definitions
├── src/
│   ├── index.ts                     # Edge Hono Worker API & Git HTTP proxy
│   ├── env.d.ts                     # Cloudflare Workers & Artifacts typings
│   ├── iam/
│   │   ├── policy.ts                # Policy engine & path ACL validator
│   │   └── rules.ts                 # Role definitions & secret scanners
│   ├── artifacts/
│   │   └── client.ts                # Cloudflare Artifacts SDK client wrapper
│   ├── coordinator/
│   │   ├── swarm-room.ts            # Durable Object managing WebSocket presence
│   │   └── context-bus.ts           # Real-time AST change broadcaster
│   ├── arbitration/
│   │   ├── t3rl-gate.ts             # Test-time verification gate
│   │   └── ast-merger.ts            # Semantic AST collision resolution
│   └── memory/
│       └── crystallizer.ts          # Knowledge note generator (.git/learnings/)
├── test/
│   └── iam.test.ts                  # Deterministic unit tests
├── scripts/
│   └── simulate-swarm.ts            # 5-agent concurrent swarm simulation
├── wrangler.jsonc                   # Cloudflare Workers configuration
└── LICENSE                          # Apache-2.0 License
```

---

## 📦 Getting Started

### 1. Devbox Container Launch
OmniGit is integrated with Ryan's isolated Devbox container environment:

```bash
# Launch dedicated isolated devbox container
devbox start omnigit -p 8787:8787

# Connect to interactive container shell
devbox shell omnigit
```

### 2. Local Development (Cloudflare Workers)

Inside the workspace:

```bash
# Install dependencies
npm install

# Run unit tests
npm test

# Run the 5-agent swarm simulation
npm run simulate

# Start local Cloudflare Workers dev server
npm run dev
```

---

## 📄 License

Apache License 2.0. Copyright 2026 Ryan Guthrie.
