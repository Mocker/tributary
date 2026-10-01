import test from 'node:test';
import assert from 'node:assert';
import { PolicyEngine } from '../src/iam/policy';

const samplePolicy = `
version: "1.0"
platform: "omnigit"
invariants:
  epistemic_air_gap:
    block_patterns:
      - "(?i)(cf_access_client_secret|ghp_|github_pat_)"
      - "(?i)(sk-[a-zA-Z0-9]{32,})"

roles:
  ui_specialist:
    allowed_paths:
      - "src/ui/**"
      - "public/**"
    forbidden_paths:
      - "src/server/**"
      - "wrangler.jsonc"

  backend_architect:
    allowed_paths:
      - "src/server/**"
    forbidden_paths:
      - "wrangler.jsonc"
`;

test('PRISM IAM: permits authorized UI paths for ui_specialist', () => {
  const engine = new PolicyEngine(samplePolicy);
  const result = engine.isPathPermitted('ui_specialist', 'src/ui/Button.tsx');
  assert.strictEqual(result.allowed, true);
});

test('PRISM IAM: blocks forbidden server paths for ui_specialist', () => {
  const engine = new PolicyEngine(samplePolicy);
  const result = engine.isPathPermitted('ui_specialist', 'src/server/auth.ts');
  assert.strictEqual(result.allowed, false);
});

test('PRISM IAM: blocks unauthorized config paths for all agents', () => {
  const engine = new PolicyEngine(samplePolicy);
  const r1 = engine.isPathPermitted('ui_specialist', 'wrangler.jsonc');
  const r2 = engine.isPathPermitted('backend_architect', 'wrangler.jsonc');
  assert.strictEqual(r1.allowed, false);
  assert.strictEqual(r2.allowed, false);
});

test('PRISM IAM: catches secret leakage via Epistemic Air Gap scanner', () => {
  const engine = new PolicyEngine(samplePolicy);
  const leakCheck = engine.scanSecrets('const key = "github_pat_11AABBCCDDEEFF";');
  assert.strictEqual(leakCheck.safe, false);

  const cleanCheck = engine.scanSecrets('const port = 8787;');
  assert.strictEqual(cleanCheck.safe, true);
});
