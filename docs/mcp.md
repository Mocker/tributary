# 🔌 Tributary Model Context Protocol (MCP) Integration

Tributary includes a native **Model Context Protocol (MCP)** server that exposes Tributary's agent-native coordination plane to any MCP-compliant coding agent (such as **Claude Desktop**, **Cursor**, **Pi**, **Aider**, or custom agent swarms).

---

## 🚀 Quick Setup for Claude Desktop & Cursor

Add the following to your `claude_desktop_config.json` or Cursor MCP settings:

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

Or run directly via npm:
```bash
npm run mcp
```

---

## 🛠️ Available MCP Tools

The Tributary MCP server registers 10 tools that allow an LLM to navigate the entire proposal, claim, gate, and merge lifecycle:

| Tool | Description |
| :--- | :--- |
| `tributary_mint_key` | Mints an authorized agent API key (`trib_...`) hashed in Cloudflare KV. |
| `tributary_create_proposal` | Forks a baseline repo on Cloudflare Artifacts and returns an ephemeral git write token. |
| `tributary_declare_claim` | Declares intent on paths/symbols before writing code. Checks overlap atomically; returns HTTP 409 if another agent holds a conflicting lease. |
| `tributary_heartbeat_claim` | Renews an active claim lease by 30 minutes. |
| `tributary_release_claim` | Releases an active claim early when work on those files completes. |
| `tributary_run_gate` | Runs verification gate (`test`) on a commit SHA, returning an HMAC-signed attestation. |
| `tributary_merge` | Triggers CAS-protected physical merge in the Worker (isomorphic-git on MemoryFS) and commits learnings to git. |
| `tributary_get_learnings` | Retrieves durable rules and invariants stored in the repo history (`learnings/`). |
| `tributary_list_claims` | Lists currently active file and symbol claims across the repository. |
| `tributary_simulate` | Triggers the complete 6-act swarm collision scenario through the live CoordinatorDO. |

---

## 💡 How LLM Agents Handle Claim Conflicts (HTTP 409)

When an agent invokes `tributary_declare_claim` on a file currently claimed by another agent, the MCP server returns an explicit error structure:

```text
🚨 CLAIM OVERLAP REJECTED (HTTP 409)
Reason: "conflicts with Agent A (Auth)'s claim on src/session.ts (symbol createSession)"
Conflicted with: Agent A (Auth) on src/auth/**, src/session.ts

Action required: Zero compute wasted! Narrow your claim paths/symbols or yield before writing code.
```

This allows the agent's LLM reasoning loop to immediately recognize the boundary collision and narrow its scope or work on other files **before writing code or spending tokens**.
