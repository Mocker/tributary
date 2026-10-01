import test from 'node:test';
import assert from 'node:assert';
import { detectOverlap } from '../src/core/overlap';
import { Claim, SymbolIndex } from '../src/types';

const symbolIndex: SymbolIndex = {
  symbols: {
    createSession: 'src/session.ts',
    validateSession: 'src/session.ts',
    authenticate: 'src/auth/login.ts',
    processPayment: 'src/billing/checkout.ts',
  },
};

test('overlap: rejects exact overlapping path with 1-sentence reason', () => {
  const liveClaims: Claim[] = [
    {
      id: 'claim_1',
      proposalId: 'prop_1',
      agentId: 'Agent A',
      paths: ['src/session.ts'],
      symbols: [],
      rationale: 'Refactor session store',
      leaseExpiresAt: Date.now() + 1800000,
      status: 'active',
      createdAt: Date.now(),
    },
  ];

  const result = detectOverlap(
    { agentId: 'Agent B', paths: ['src/session.ts'] },
    liveClaims,
    symbolIndex
  );

  assert.strictEqual(result.hasOverlap, true);
  assert.match(result.reason || '', /conflicts with Agent A's claim on src\/session\.ts/);
});

test('overlap: rejects prefix/glob overlapping paths', () => {
  const liveClaims: Claim[] = [
    {
      id: 'claim_1',
      proposalId: 'prop_1',
      agentId: 'Agent A',
      paths: ['src/auth/**'],
      symbols: [],
      rationale: 'Auth hardening',
      leaseExpiresAt: Date.now() + 1800000,
      status: 'active',
      createdAt: Date.now(),
    },
  ];

  const result = detectOverlap(
    { agentId: 'Agent B', paths: ['src/auth/login.ts'] },
    liveClaims,
    symbolIndex
  );

  assert.strictEqual(result.hasOverlap, true);
  assert.match(result.reason || '', /conflicts with Agent A's claim on src\/auth\/\*\*/);
});

test('overlap: rejects when claimed symbol resolves to a claimed file', () => {
  const liveClaims: Claim[] = [
    {
      id: 'claim_1',
      proposalId: 'prop_1',
      agentId: 'Agent A',
      paths: ['src/session.ts'],
      symbols: ['createSession'],
      rationale: 'Session timeout overhaul',
      leaseExpiresAt: Date.now() + 1800000,
      status: 'active',
      createdAt: Date.now(),
    },
  ];

  // Agent B claims billing files plus symbol createSession
  const result = detectOverlap(
    { agentId: 'Agent B', paths: ['src/billing/**'], symbols: ['createSession'] },
    liveClaims,
    symbolIndex
  );

  assert.strictEqual(result.hasOverlap, true);
  assert.match(result.reason || '', /conflicts with Agent A's claim on src\/session\.ts \(symbol createSession\)/);
});

test('overlap: accepts disjoint claims concurrently', () => {
  const liveClaims: Claim[] = [
    {
      id: 'claim_1',
      proposalId: 'prop_1',
      agentId: 'Agent A',
      paths: ['src/auth/**'],
      symbols: [],
      rationale: 'Auth refactor',
      leaseExpiresAt: Date.now() + 1800000,
      status: 'active',
      createdAt: Date.now(),
    },
  ];

  const result = detectOverlap(
    { agentId: 'Agent C', paths: ['docs/**'] },
    liveClaims,
    symbolIndex
  );

  assert.strictEqual(result.hasOverlap, false);
});
