import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateApiKey, sha256hex, apiKeyKvKey } from '../src/core/api-keys';

test('api-keys: generateApiKey produces unique trib_-prefixed keys', () => {
  const a = generateApiKey();
  const b = generateApiKey();
  assert.ok(a.startsWith('trib_'));
  assert.ok(b.startsWith('trib_'));
  assert.notEqual(a, b);
  assert.ok(a.length > 40);
});

test('api-keys: sha256hex is deterministic and 64 hex chars', async () => {
  const h1 = await sha256hex('trib_test');
  const h2 = await sha256hex('trib_test');
  const h3 = await sha256hex('trib_other');
  assert.equal(h1, h2);
  assert.notEqual(h1, h3);
  assert.match(h1, /^[0-9a-f]{64}$/);
});

test('api-keys: apiKeyKvKey namespaces by hash', () => {
  assert.equal(apiKeyKvKey('abc123'), 'trib:key:abc123');
});
