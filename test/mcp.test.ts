import test from 'node:test';
import assert from 'node:assert';
import { createTributaryMcpServer } from '../src/mcp/server';
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

test('mcp: server registers all 10 Tributary agent coordination tools', async () => {
  const server = createTributaryMcpServer({ baseUrl: 'http://localhost:8787' });
  const handler = (server as any)._requestHandlers.get(ListToolsRequestSchema.shape.method.value);
  assert.ok(handler, 'ListTools handler should be registered');

  const res = await handler({ method: 'tools/list', params: {} });
  assert.ok(Array.isArray(res.tools), 'Should return tools array');
  assert.equal(res.tools.length, 10);

  const toolNames = res.tools.map((t: any) => t.name);
  assert.ok(toolNames.includes('tributary_mint_key'));
  assert.ok(toolNames.includes('tributary_create_proposal'));
  assert.ok(toolNames.includes('tributary_declare_claim'));
  assert.ok(toolNames.includes('tributary_heartbeat_claim'));
  assert.ok(toolNames.includes('tributary_release_claim'));
  assert.ok(toolNames.includes('tributary_run_gate'));
  assert.ok(toolNames.includes('tributary_merge'));
  assert.ok(toolNames.includes('tributary_get_learnings'));
  assert.ok(toolNames.includes('tributary_list_claims'));
  assert.ok(toolNames.includes('tributary_simulate'));
});

test('mcp: tool call formats 409 conflict rejection with actionable LLM guidance', async () => {
  // Stub global fetch to return 409 for claims overlap
  const origFetch = globalThis.fetch;
  globalThis.fetch = async (url: any) => {
    if (String(url).includes('/claims')) {
      return new Response(
        JSON.stringify({
          error: 'Claim conflict detected',
          reason: 'conflicts with Agent A (Auth) on src/session.ts (symbol createSession)',
          conflictingClaim: {
            agentId: 'Agent A (Auth)',
            paths: ['src/session.ts'],
          },
        }),
        { status: 409, headers: { 'Content-Type': 'application/json' } }
      );
    }
    return new Response('{}', { status: 200 });
  };

  try {
    const server = createTributaryMcpServer({ baseUrl: 'http://mock-tributary.local' });
    const handler = (server as any)._requestHandlers.get(CallToolRequestSchema.shape.method.value);
    assert.ok(handler, 'CallTool handler should be registered');

    const result = await handler({
      method: 'tools/call',
      params: {
        name: 'tributary_declare_claim',
        arguments: {
          proposalId: 'prop_test',
          paths: ['src/session.ts'],
          apiKey: 'trib_test123',
        },
      },
    });

    assert.equal(result.isError, true);
    assert.ok(result.content[0].text.includes('🚨 CLAIM OVERLAP REJECTED (HTTP 409)'));
    assert.ok(result.content[0].text.includes('Zero compute wasted!'));
    assert.ok(result.content[0].text.includes('conflicts with Agent A (Auth)'));
  } finally {
    globalThis.fetch = origFetch;
  }
});
