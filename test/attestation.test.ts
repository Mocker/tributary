import test from 'node:test';
import assert from 'node:assert';
import { signAttestation, verifyAttestation } from '../src/core/attestation';

const SECRET = 'test-secret-key-12345';

test('attestation: signs and cryptographically verifies attestation payload', async () => {
  const attestation = await signAttestation(
    'test',
    'abc123def456',
    'pass',
    'All 14 test invariants passed cleanly.',
    SECRET
  );

  assert.strictEqual(attestation.verdict, 'pass');
  assert.ok(attestation.signature.length > 20);

  const isValid = await verifyAttestation(attestation, SECRET);
  assert.strictEqual(isValid, true);
});

test('attestation: fails verification when secret is incorrect', async () => {
  const attestation = await signAttestation(
    'test',
    'abc123def456',
    'pass',
    'All tests passed.',
    SECRET
  );

  const isValid = await verifyAttestation(attestation, 'wrong-secret');
  assert.strictEqual(isValid, false);
});

test('attestation: detects tampering with verdict or commitSha', async () => {
  const attestation = await signAttestation(
    'test',
    'abc123def456',
    'pass',
    'All tests passed.',
    SECRET
  );

  // Attacker attempts to change commitSha while preserving signature
  const tampered = { ...attestation, commitSha: 'evil999sha888' };
  const isValid = await verifyAttestation(tampered, SECRET);
  assert.strictEqual(isValid, false);
});
