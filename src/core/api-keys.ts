/**
 * Agent API keys — Tributary-level identity for agent authentication.
 *
 * Keys are `trib_<base64url(32 random bytes)>`. Only the SHA-256 hash is
 * stored (KV `trib:key:<hex>`); the raw key is shown once at issuance and
 * never persisted. This is separate from the short-lived, repo-scoped
 * Artifacts git tokens minted per proposal.
 */

export interface ApiKeyRecord {
  agentId: string;
  name?: string;
  createdAt: string;
  revoked: boolean;
}

export function generateApiKey(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  // base64url without padding
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  const b64 = btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return `trib_${b64}`;
}

export async function sha256hex(s: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export const apiKeyKvKey = (hash: string): string => `trib:key:${hash}`;
