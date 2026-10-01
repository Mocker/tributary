/**
 * Tributary Demo Script Runner
 * Rehearses the exact 6-act competition demonstration scenario from Section 9.
 */

import { detectOverlap } from '../src/core/overlap';
import { signAttestation } from '../src/core/attestation';
import { evaluateMergeGate } from '../src/core/merge-gate';
import { generateLearningMarkdown, generateLearningFilename } from '../src/core/learnings';
import { Claim, ChangeProposal, SymbolIndex } from '../src/types';

const SECRET = 'tributary-demo-secret-2026';

const symbolIndex: SymbolIndex = {
  symbols: {
    createSession: 'src/session.ts',
    validateSession: 'src/session.ts',
    revokeSession: 'src/session.ts',
    authenticate: 'src/auth/login.ts',
    processPayment: 'src/billing/checkout.ts',
  },
};

async function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runDemo() {
  console.log('='.repeat(70));
  console.log('🌊 TRIBUTARY — AGENT-NATIVE CODE COLLABORATION PLANE');
  console.log('   "GitHub coordinates humans. Tributary coordinates agents."');
  console.log('='.repeat(70));
  console.log('Demo Victim Repo: demo-shop (shared module: src/session.ts)\n');

  await sleep(1000);

  // -------------------------------------------------------------
  // ACT 1: The Problem (Git discovers at merge time)
  // -------------------------------------------------------------
  console.log('🎬 ACT 1: THE PROBLEM (Plain Git vs. Agent Swarms)');
  console.log('--------------------------------------------------');
  console.log('• Traditional Git: Agent A and Agent B both fork and work for 20 minutes.');
  console.log('• Agent A edits src/session.ts (auth session overhaul).');
  console.log('• Agent B edits src/session.ts (billing timeout fix).');
  console.log('• Git discovers conflict AFTER all compute is spent: <<<<<<< HEAD\n');

  await sleep(1500);

  // -------------------------------------------------------------
  // ACT 2: Prevention (Tributary discovers at claim time)
  // -------------------------------------------------------------
  console.log('🎬 ACT 2: CLAIM-TIME CONFLICT PREVENTION');
  console.log('--------------------------------------------------');

  const liveClaims: Claim[] = [];

  // Step 2a: Agent A claims auth + symbol createSession
  console.log('1. [Agent A] POST /v1/proposals/prop_auth/claims');
  console.log('   Payload: paths=["src/auth/**"], symbols=["createSession"]');

  const claimA: Claim = {
    id: 'claim_auth_01',
    proposalId: 'prop_auth',
    agentId: 'Agent A (Auth)',
    paths: ['src/auth/**'],
    symbols: ['createSession'],
    rationale: 'Refactor login auth token lifecycle',
    leaseExpiresAt: Date.now() + 1800000,
    status: 'active',
    createdAt: Date.now(),
  };
  liveClaims.push(claimA);
  console.log('   ✅ Claim accepted with 30m lease.\n');

  await sleep(1500);

  // Step 2b: Agent B attempts to claim billing + src/session.ts
  console.log('2. [Agent B] POST /v1/proposals/prop_billing/claims');
  console.log('   Payload: paths=["src/billing/**", "src/session.ts"]');

  const overlapCheckB = detectOverlap(
    { agentId: 'Agent B (Billing)', paths: ['src/billing/**', 'src/session.ts'] },
    liveClaims,
    symbolIndex
  );

  if (overlapCheckB.hasOverlap) {
    console.log('\n   🚨 HTTP 409 CONFLICT DETECTED AT CLAIM TIME:');
    console.log(`   👉 "${overlapCheckB.reason}"`);
    console.log('   💡 ZERO COMPUTE WASTED on redundant drafting!\n');
  }

  await sleep(1500);

  // Step 2c: Agent B narrows claim to src/billing/** and succeeds
  console.log('3. [Agent B] Retrying with narrowed claim: paths=["src/billing/**"]');
  const narrowedOverlap = detectOverlap(
    { agentId: 'Agent B (Billing)', paths: ['src/billing/**'] },
    liveClaims,
    symbolIndex
  );
  if (!narrowedOverlap.hasOverlap) {
    const claimB: Claim = {
      id: 'claim_bill_02',
      proposalId: 'prop_billing',
      agentId: 'Agent B (Billing)',
      paths: ['src/billing/**'],
      symbols: ['processPayment'],
      rationale: 'Payment webhook handler update',
      leaseExpiresAt: Date.now() + 1800000,
      status: 'active',
      createdAt: Date.now(),
    };
    liveClaims.push(claimB);
    console.log('   ✅ Narrowed claim accepted cleanly. Both agents working in parallel!\n');
  }

  await sleep(1500);

  // -------------------------------------------------------------
  // ACT 3: Verification (Attestation-gated merge)
  // -------------------------------------------------------------
  console.log('🎬 ACT 3: ATTESTATION-GATED VERIFICATION');
  console.log('--------------------------------------------------');

  // Agent C claims docs/** concurrently
  console.log('1. [Agent C] Concurrently claims docs/** -> Works and merges cleanly.');

  // Agent B pushes a change that breaks a test
  const commitShaB_bad = 'bad_commit_b101';
  console.log(`2. [Agent B] Runs gate on broken commit ${commitShaB_bad}...`);
  const attestationFail = await signAttestation(
    'test',
    commitShaB_bad,
    'fail',
    'FAIL: test/session.test.ts (AssertionError: expected session TTL 3600 but got 60)',
    SECRET
  );
  console.log(`   ❌ Gate 'test' emitted signed attestation: [VERDICT: FAIL]`);
  console.log(`   🔒 POST /v1/proposals/prop_billing/merge -> HTTP 422: Gate 'test' failed.`);

  await sleep(1500);

  // Agent B fixes the bug and re-attests
  const commitShaB_good = 'good_commit_b202';
  console.log(`\n3. [Agent B] Pushes fix commit ${commitShaB_good}. Re-running gate...`);
  const attestationPass = await signAttestation(
    'test',
    commitShaB_good,
    'pass',
    'PASS: All 12 unit and session invariants satisfied.',
    SECRET
  );
  console.log(`   ✅ Gate 'test' emitted signed attestation: [VERDICT: PASS]`);

  // Gated merge succeeds with CAS
  const proposalB: ChangeProposal = {
    id: 'prop_billing',
    baselineRepo: 'demo-shop',
    forkRepo: 'demo-shop__p_billing',
    agentId: 'Agent B (Billing)',
    taskRef: 'BILL-402',
    status: 'gating',
    claims: [liveClaims.find((c) => c.agentId.includes('Billing'))!],
    attestations: [attestationPass],
    baselineParentSha: 'mainline_sha_v1',
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };

  const mergeResult = evaluateMergeGate(proposalB, commitShaB_good, 'mainline_sha_v1');
  if (mergeResult.canMerge) {
    console.log(`   🚀 Merge accepted: CAS matched, gate attested pass. Merged into mainline!\n`);
  }

  await sleep(1500);

  // -------------------------------------------------------------
  // ACT 4: Epistemic Memory Crystallization
  // -------------------------------------------------------------
  console.log('🎬 ACT 4: EPISTEMIC MEMORY (.git/learnings/)');
  console.log('--------------------------------------------------');
  const today = '2026-10-01';
  const slug = 'session-shared-module';
  const learningRule = {
    date: today,
    slug,
    title: 'Shared Session Module Boundary Invariant',
    whatHappened:
      'Agent B attempted to alter session timeout parameters during billing refactor while Agent A was migrating auth tokens.',
    rule:
      'src/session.ts is a shared module between auth and billing. Always claim src/session.ts explicitly; never implicitly mutate session contracts inside billing PRs.',
    filePath: generateLearningFilename(today, slug),
  };

  const md = generateLearningMarkdown(learningRule);
  console.log(`• Crystallizing rule to ${learningRule.filePath}:`);
  console.log(md);

  await sleep(1500);

  // -------------------------------------------------------------
  // ACT 5: Scale — Measured Fork Latency
  // -------------------------------------------------------------
  console.log('🎬 ACT 5: SCALE BENCHMARK (Artifacts Fork Latency)');
  console.log('--------------------------------------------------');
  console.log('Simulating 10 rapid micro-forks on Cloudflare Artifacts:');

  const latencies: number[] = [];
  for (let i = 1; i <= 10; i++) {
    const start = Date.now();
    // Simulate measured edge fork delay (80-150ms per Phase 0 spike)
    await sleep(Math.floor(80 + Math.random() * 40));
    const elapsed = Date.now() - start;
    latencies.push(elapsed);
    process.stdout.write(`  Fork #${i} (fork://demo-shop__p_${i}): ${elapsed}ms\n`);
  }

  const avg = Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length);
  console.log(`\n⚡ Average fork provisioning time: ${avg}ms!`);
  console.log(
    '👉 "Fork-per-task is cheap enough that ten thousand agents is an addressing problem, not a storage problem."\n'
  );

  console.log('='.repeat(70));
  console.log('🎉 DEMO REHEARSAL COMPLETE — READY FOR CLOUDFLARE CONNECT');
  console.log('='.repeat(70));
}

runDemo().catch(console.error);
