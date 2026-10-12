import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type Tool,
} from '@modelcontextprotocol/sdk/types.js';

export interface McpServerOptions {
  baseUrl?: string;
  defaultApiKey?: string;
}

export function createTributaryMcpServer(options: McpServerOptions = {}) {
  const baseUrl = (options.baseUrl || process.env.TRIBUTARY_URL || 'https://tributary.sokercap.workers.dev').replace(/\/$/, '');
  let defaultApiKey = options.defaultApiKey || process.env.TRIBUTARY_API_KEY || '';

  const server = new Server(
    {
      name: 'tributary',
      version: '0.1.0',
    },
    {
      capabilities: {
        tools: {},
      },
    }
  );

  const tools: Tool[] = [
    {
      name: 'tributary_mint_key',
      description: 'Mint an authorized agent API key on Tributary. Keys are SHA-256 hashed in Cloudflare KV. Mutating routes require an API key.',
      inputSchema: {
        type: 'object',
        properties: {
          agentId: {
            type: 'string',
            description: 'Unique agent identifier (e.g. agent-alpha, cursor-agent, pi-1)',
          },
          name: {
            type: 'string',
            description: 'Optional human-readable name for the key',
          },
        },
        required: ['agentId'],
      },
    },
    {
      name: 'tributary_create_proposal',
      description: 'Request an isolated task workspace on Cloudflare Artifacts. Forks baseline repo and mints a short-lived scoped git write token.',
      inputSchema: {
        type: 'object',
        properties: {
          taskRef: {
            type: 'string',
            description: 'Task reference or issue ticket (e.g. AUTH-101, BILL-402)',
          },
          baseline: {
            type: 'string',
            description: 'Baseline repository name in Cloudflare Artifacts (defaults to demo-shop)',
          },
          apiKey: {
            type: 'string',
            description: 'Optional agent API key (defaults to active key or TRIBUTARY_API_KEY)',
          },
        },
        required: ['taskRef'],
      },
    },
    {
      name: 'tributary_declare_claim',
      description: 'Declare intent on files and symbols BEFORE drafting code. Tributary performs atomic overlap detection via CoordinatorDO. Returns 201 on success or HTTP 409 if another agent holds a conflicting lease.',
      inputSchema: {
        type: 'object',
        properties: {
          proposalId: {
            type: 'string',
            description: 'The proposal ID received from tributary_create_proposal',
          },
          paths: {
            type: 'array',
            items: { type: 'string' },
            description: 'List of file paths or glob patterns (e.g. ["src/auth/**"], ["src/session.ts"])',
          },
          symbols: {
            type: 'array',
            items: { type: 'string' },
            description: 'Optional AST symbols to claim (e.g. ["createSession"])',
          },
          rationale: {
            type: 'string',
            description: 'Brief explanation of why the agent needs these files',
          },
          apiKey: {
            type: 'string',
            description: 'Optional agent API key',
          },
        },
        required: ['proposalId', 'paths'],
      },
    },
    {
      name: 'tributary_heartbeat_claim',
      description: 'Renew an active claim lease by 30 minutes to prevent lease expiration while working.',
      inputSchema: {
        type: 'object',
        properties: {
          proposalId: { type: 'string', description: 'Proposal ID' },
          claimId: { type: 'string', description: 'Claim ID to renew' },
          apiKey: { type: 'string', description: 'Optional agent API key' },
        },
        required: ['proposalId', 'claimId'],
      },
    },
    {
      name: 'tributary_release_claim',
      description: 'Voluntarily release a claim early if changes on those files are complete or if yielding.',
      inputSchema: {
        type: 'object',
        properties: {
          proposalId: { type: 'string', description: 'Proposal ID' },
          claimId: { type: 'string', description: 'Claim ID to release' },
          apiKey: { type: 'string', description: 'Optional agent API key' },
        },
        required: ['proposalId', 'claimId'],
      },
    },
    {
      name: 'tributary_run_gate',
      description: 'Execute verification gate (test invariants) against a specific git commit SHA. Emits a cryptographically signed HMAC attestation required for merge.',
      inputSchema: {
        type: 'object',
        properties: {
          proposalId: { type: 'string', description: 'Proposal ID' },
          commitSha: { type: 'string', description: 'The exact git commit SHA pushed to the Artifacts fork' },
          gateId: { type: 'string', description: 'Gate identifier (default: test)' },
          simulateFailure: { type: 'boolean', description: 'Simulate gate invariant failure for testing' },
          failureReason: { type: 'string', description: 'Simulated failure reason' },
          apiKey: { type: 'string', description: 'Optional agent API key' },
        },
        required: ['proposalId', 'commitSha'],
      },
    },
    {
      name: 'tributary_merge',
      description: 'Trigger CAS-protected in-Worker physical merge via isomorphic-git. Checks active claims, passing gate attestations, and mainline CAS match. Optionally commits epistemic memory to learnings/.',
      inputSchema: {
        type: 'object',
        properties: {
          proposalId: { type: 'string', description: 'Proposal ID' },
          commitSha: { type: 'string', description: 'The attested commit SHA to merge into mainline' },
          learning: {
            type: 'object',
            properties: {
              title: { type: 'string', description: 'Title of the learned invariant rule' },
              whatHappened: { type: 'string', description: 'What failure or collision occurred' },
              rule: { type: 'string', description: 'The durable rule for future agent runs' },
            },
            required: ['title', 'whatHappened', 'rule'],
            description: 'Optional epistemic learning rule committed directly into the baseline repository',
          },
          apiKey: { type: 'string', description: 'Optional agent API key' },
        },
        required: ['proposalId', 'commitSha'],
      },
    },
    {
      name: 'tributary_get_learnings',
      description: 'Retrieve all durable rules and invariants synthesized into git history (learnings/).',
      inputSchema: {
        type: 'object',
        properties: {},
      },
    },
    {
      name: 'tributary_list_claims',
      description: 'List all currently active file and symbol claims across the entire repository.',
      inputSchema: {
        type: 'object',
        properties: {},
      },
    },
    {
      name: 'tributary_simulate',
      description: 'Trigger the complete 6-act swarm collision simulation through the live CoordinatorDO.',
      inputSchema: {
        type: 'object',
        properties: {},
      },
    },
  ];

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return { tools };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args = {} } = request.params;
    const key = (args.apiKey as string) || defaultApiKey;

    const authHeaders: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (key) {
      authHeaders['Authorization'] = `Bearer ${key}`;
    }

    try {
      switch (name) {
        case 'tributary_mint_key': {
          const res = await fetch(`${baseUrl}/v1/admin/keys`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ agentId: args.agentId, name: args.name }),
          });
          const data = (await res.json()) as any;
          if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
          // Remember as default key if none was set
          if (!defaultApiKey) defaultApiKey = data.apiKey;
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify(
                  {
                    success: true,
                    message: `Agent API key minted for ${data.agentId}. Automatically stored for subsequent calls.`,
                    agentId: data.agentId,
                    apiKey: data.apiKey,
                    createdAt: data.createdAt,
                  },
                  null,
                  2
                ),
              },
            ],
          };
        }

        case 'tributary_create_proposal': {
          const res = await fetch(`${baseUrl}/v1/proposals`, {
            method: 'POST',
            headers: authHeaders,
            body: JSON.stringify({
              taskRef: args.taskRef,
              baseline: args.baseline || 'demo-shop',
            }),
          });
          const data = (await res.json()) as any;
          if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify(
                  {
                    success: true,
                    proposalId: data.proposalId,
                    forkRepo: data.forkRepo,
                    forkRemote: data.forkRemote,
                    gitCloneCommand: `git -c http.extraHeader="Authorization: Bearer ${data.token}" clone ${data.forkRemote}`,
                    tokenExpiresAt: data.tokenExpiresAt,
                    status: data.proposal?.status,
                  },
                  null,
                  2
                ),
              },
            ],
          };
        }

        case 'tributary_declare_claim': {
          const res = await fetch(`${baseUrl}/v1/proposals/${args.proposalId}/claims`, {
            method: 'POST',
            headers: authHeaders,
            body: JSON.stringify({
              paths: args.paths,
              symbols: args.symbols || [],
              rationale: args.rationale || 'Agent implementation',
            }),
          });
          const data = (await res.json()) as any;
          if (res.status === 409) {
            return {
              isError: true,
              content: [
                {
                  type: 'text',
                  text: `🚨 CLAIM OVERLAP REJECTED (HTTP 409)\nReason: "${data.reason}"\nConflicted with: ${data.conflictingClaim?.agentId} on ${data.conflictingClaim?.paths?.join(', ')}\n\nAction required: Zero compute wasted! Narrow your claim paths/symbols or yield before writing code.`,
                },
              ],
            };
          }
          if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify(
                  {
                    success: true,
                    claimId: data.claim?.id,
                    paths: data.claim?.paths,
                    symbols: data.claim?.symbols,
                    leaseExpiresAt: data.claim?.leaseExpiresAt,
                    status: data.claim?.status,
                  },
                  null,
                  2
                ),
              },
            ],
          };
        }

        case 'tributary_heartbeat_claim': {
          const res = await fetch(
            `${baseUrl}/v1/proposals/${args.proposalId}/claims/${args.claimId}/heartbeat`,
            {
              method: 'POST',
              headers: authHeaders,
            }
          );
          const data = (await res.json()) as any;
          if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({ success: true, leaseExpiresAt: data.leaseExpiresAt }, null, 2),
              },
            ],
          };
        }

        case 'tributary_release_claim': {
          const res = await fetch(
            `${baseUrl}/v1/proposals/${args.proposalId}/claims/${args.claimId}/release`,
            {
              method: 'POST',
              headers: authHeaders,
            }
          );
          const data = (await res.json()) as any;
          if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
          return {
            content: [{ type: 'text', text: JSON.stringify({ success: true, released: data.claimId }, null, 2) }],
          };
        }

        case 'tributary_run_gate': {
          const gateId = (args.gateId as string) || 'test';
          const res = await fetch(
            `${baseUrl}/v1/proposals/${args.proposalId}/gates/${gateId}/run`,
            {
              method: 'POST',
              headers: authHeaders,
              body: JSON.stringify({
                commitSha: args.commitSha,
                simulateFailure: args.simulateFailure,
                failureReason: args.failureReason,
              }),
            }
          );
          const data = (await res.json()) as any;
          const attestation = data.attestation;
          return {
            isError: attestation?.verdict !== 'pass',
            content: [
              {
                type: 'text',
                text: JSON.stringify(
                  {
                    success: attestation?.verdict === 'pass',
                    gateId: attestation?.gateId,
                    commitSha: attestation?.commitSha,
                    verdict: attestation?.verdict,
                    summary: attestation?.summary,
                    signature: attestation?.signature,
                  },
                  null,
                  2
                ),
              },
            ],
          };
        }

        case 'tributary_merge': {
          const res = await fetch(`${baseUrl}/v1/proposals/${args.proposalId}/merge`, {
            method: 'POST',
            headers: authHeaders,
            body: JSON.stringify({
              commitSha: args.commitSha,
              learning: args.learning,
            }),
          });
          const data = (await res.json()) as any;
          if (!res.ok) {
            return {
              isError: true,
              content: [
                {
                  type: 'text',
                  text: `Merge blocked (${res.status}): ${data.error || 'Unknown error'}\nCode: ${data.code || ''}\nDetails: ${data.details || ''}`,
                },
              ],
            };
          }
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify(
                  {
                    merged: true,
                    proposalId: data.proposalId,
                    mergedSha: data.mergedSha,
                    fastForward: data.fastForward,
                    crystallizedLearning: data.crystallizedLearning,
                  },
                  null,
                  2
                ),
              },
            ],
          };
        }

        case 'tributary_get_learnings': {
          const res = await fetch(`${baseUrl}/v1/learnings`);
          const data = (await res.json()) as any;
          return {
            content: [{ type: 'text', text: JSON.stringify(data.learnings || [], null, 2) }],
          };
        }

        case 'tributary_list_claims': {
          const res = await fetch(`${baseUrl}/v1/claims`);
          const data = (await res.json()) as any;
          return {
            content: [{ type: 'text', text: JSON.stringify(data.claims || [], null, 2) }],
          };
        }

        case 'tributary_simulate': {
          const res = await fetch(`${baseUrl}/v1/admin/simulate`, { method: 'POST' });
          const data = (await res.json()) as any;
          return {
            content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
          };
        }

        default:
          throw new Error(`Unknown tool: ${name}`);
      }
    } catch (err: any) {
      return {
        isError: true,
        content: [{ type: 'text', text: `Error executing ${name}: ${err.message}` }],
      };
    }
  });

  return server;
}

export async function runMcpServer(options: McpServerOptions = {}) {
  const server = createTributaryMcpServer(options);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('[tributary-mcp] MCP server running on stdio');
}
