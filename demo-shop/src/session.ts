export interface Session {
  id: string;
  userId: string;
  createdAt: number;
  expiresAt: number;
}

const activeSessions = new Map<string, Session>();

export function createSession(userId: string, ttlSeconds: number = 3600): Session {
  const session: Session = {
    id: `sess_${Math.random().toString(36).slice(2)}`,
    userId,
    createdAt: Date.now(),
    expiresAt: Date.now() + ttlSeconds * 1000,
  };
  activeSessions.set(session.id, session);
  return session;
}

export function validateSession(sessionId: string): boolean {
  const session = activeSessions.get(sessionId);
  if (!session) return false;
  return session.expiresAt > Date.now();
}

export function revokeSession(sessionId: string): void {
  activeSessions.delete(sessionId);
}
