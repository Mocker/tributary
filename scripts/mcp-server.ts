#!/usr/bin/env -S npx tsx
/**
 * Tributary Model Context Protocol (MCP) Server
 *
 * Exposes Tributary's agent coordination plane (claim declaration, verification
 * gates, in-Worker physical merges, epistemic memory) as standard MCP tools
 * over stdio for Claude Desktop, Cursor, Pi, Aider, and custom LLM agent harnesses.
 *
 * Usage:
 *   npx tsx scripts/mcp-server.ts
 *
 * Environment variables:
 *   TRIBUTARY_URL      Target Tributary Worker URL (default: https://tributary.sokercap.workers.dev)
 *   TRIBUTARY_API_KEY  Optional default Bearer API key
 */
import { runMcpServer } from '../src/mcp/server';

runMcpServer().catch((err) => {
  console.error('[tributary-mcp] Fatal error:', err);
  process.exit(1);
});
