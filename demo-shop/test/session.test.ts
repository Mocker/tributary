import test from 'node:test';
import assert from 'node:assert';
import { createSession, validateSession, revokeSession } from '../src/session';

test('session: creates active session with TTL', () => {
  const session = createSession('user123', 3600);
  assert.strictEqual(session.userId, 'user123');
  assert.strictEqual(validateSession(session.id), true);
});

test('session: revokes session immediately', () => {
  const session = createSession('user456', 3600);
  revokeSession(session.id);
  assert.strictEqual(validateSession(session.id), false);
});
