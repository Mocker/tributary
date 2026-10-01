import { validateSession } from '../session';

export function processPayment(sessionId: string, amountCents: number) {
  const isValid = validateSession(sessionId);
  if (!isValid) {
    throw new Error('Unauthorized checkout: invalid or expired session.');
  }
  return { status: 'paid', amountCents, transactionId: `txn_${Date.now()}` };
}
