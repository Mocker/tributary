import { createSession } from '../session';

export function authenticate(username: string, passwordHash: string) {
  // Simple auth logic
  if (username && passwordHash) {
    const session = createSession(username, 3600);
    return { success: true, sessionId: session.id };
  }
  return { success: false, error: 'Invalid credentials' };
}
