import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { Env } from './env';
import { ArtifactsClient } from './artifacts/client';
import { PolicyEngine } from './iam/policy';
import { T3RLVerificationGate } from './arbitration/t3rl-gate';
import { EpistemicCrystallizer } from './memory/crystallizer';

// Export the Durable Object class for Cloudflare Workers runtime
export { SwarmCoordinator } from './coordinator/swarm-room';

const app = new Hono<{ Bindings: Env }>();

app.use('*', cors());

// Health Check
app.get('/health', (c) => {
  return c.json({
    status: 'healthy',
    platform: 'OmniGit',
    version: '0.1.0',
    runtime: 'Cloudflare Workers (V8 Isolate)',
    timestamp: new Date().toISOString(),
  });
});

// 1. Programmatic Repository Creation (Artifacts)
app.post('/api/repos/create', async (c) => {
  const { name } = await c.req.json<{ name: string }>();
  if (!name) return c.json({ error: 'Repository name is required' }, 400);

  const client = new ArtifactsClient(c.env.ARTIFACTS);
  const repo = await client.ensureBaseRepo(name);
  const meta = await repo.getMetadata();

  return c.json({ success: true, repository: meta });
});

// 2. Instant Micro-Fork Spawning (Agent Task Workspace)
app.post('/api/forks/spawn', async (c) => {
  const { baseRepo, agentId, role } = await c.req.json<{
    baseRepo: string;
    agentId: string;
    role: string;
  }>();

  if (!baseRepo || !agentId || !role) {
    return c.json({ error: 'baseRepo, agentId, and role are required' }, 400);
  }

  // Load and check policy
  const policyYaml = await c.env.OMNIGIT_KV.get('policy:default');
  const policyEngine = new PolicyEngine(policyYaml || 'version: "1.0"\nplatform: "omnigit"\nroles: {}');
  const roleConfig = policyEngine.getRole(role);

  if (!roleConfig) {
    return c.json({ error: `Unauthorized or undefined role: ${role}` }, 403);
  }

  const client = new ArtifactsClient(c.env.ARTIFACTS);
  const fork = await client.spawnMicroFork(baseRepo, agentId, roleConfig.token_ttl_seconds);

  // Register agent in Swarm Coordinator Durable Object
  const id = c.env.SWARM_COORDINATOR.idFromName(baseRepo);
  const coordinator = c.env.SWARM_COORDINATOR.get(id);

  await coordinator.fetch(new Request('http://internal/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      agentId,
      role,
      forkName: fork.forkName,
      activeFiles: [],
      status: 'active',
    }),
  }));

  return c.json({
    success: true,
    fork: fork.forkName,
    remoteUrl: fork.remoteUrl,
    token: fork.token,
    expiresAt: fork.expiresAt,
    permittedPaths: roleConfig.allowed_paths,
  });
});

// 3. Pre-Commit Zero-Trust Audit (PRISM IAM)
app.post('/api/audit/commit', async (c) => {
  const { role, changedFiles, commitMessage, diffContent } = await c.req.json<{
    role: string;
    changedFiles: string[];
    commitMessage: string;
    diffContent?: string;
  }>();

  const policyYaml = await c.env.OMNIGIT_KV.get('policy:default');
  const policyEngine = new PolicyEngine(policyYaml || 'version: "1.0"\nplatform: "omnigit"\nroles: {}');

  // Verify path ACLs
  for (const file of changedFiles) {
    const check = policyEngine.isPathPermitted(role, file);
    if (!check.allowed) {
      return c.json({
        allowed: false,
        reason: check.reason,
        violatedFile: file,
      }, 403);
    }
  }

  // Epistemic Air Gap: Scan secrets in diff / commit message
  if (diffContent) {
    const scan = policyEngine.scanSecrets(diffContent + '\n' + commitMessage);
    if (!scan.safe) {
      return c.json({
        allowed: false,
        reason: 'Epistemic Air Gap violation: sensitive credential or secret pattern detected.',
        pattern: scan.detectedPattern,
      }, 400);
    }
  }

  return c.json({ allowed: true });
});

// 4. Test-Time Verification Gate (T³RL) & Knowledge Crystallization
app.post('/api/merge/verify-and-merge', async (c) => {
  const { forkName, baseRepo, learningRule } = await c.req.json<{
    forkName: string;
    baseRepo: string;
    learningRule?: { title: string; rule: string; insight: string };
  }>();

  const gate = new T3RLVerificationGate();
  const testResult = await gate.verifyFork(forkName);

  if (!testResult.passed) {
    return c.json({
      merged: false,
      error: 'T³RL Verification failed. Test invariants must be satisfied prior to merge.',
      details: testResult.output,
    }, 422);
  }

  // Crystallize learning if provided
  let noteText: string | undefined;
  if (learningRule) {
    const crystallizer = new EpistemicCrystallizer();
    noteText = crystallizer.formatLearningNote({
      title: learningRule.title,
      category: 'architecture',
      rule: learningRule.rule,
      insight: learningRule.insight,
      sourceForks: [forkName],
      crystallizedAt: new Date().toISOString(),
    });

    // In production, commits noteText to .git/learnings/ via Artifacts
  }

  return c.json({
    merged: true,
    verification: testResult,
    crystallizedNote: noteText,
  });
});

// 5. Real-Time Swarm WebSocket Ingress
app.get('/api/swarm/live/:repo', async (c) => {
  const repo = c.req.param('repo');
  const id = c.env.SWARM_COORDINATOR.idFromName(repo);
  const coordinator = c.env.SWARM_COORDINATOR.get(id);
  return coordinator.fetch(c.req.raw);
});

export default app;
