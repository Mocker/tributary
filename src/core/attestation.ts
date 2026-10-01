import { Attestation } from '../types';

/**
 * Creates canonical string representation of an attestation payload for signing
 */
export function canonicalizePayload(
  gateId: string,
  commitSha: string,
  verdict: 'pass' | 'fail',
  signedAt: number
): string {
  return `${gateId}:${commitSha}:${verdict}:${signedAt}`;
}

/**
 * Signs an attestation payload using HMAC-SHA256 via Web Crypto API
 */
export async function signAttestation(
  gateId: string,
  commitSha: string,
  verdict: 'pass' | 'fail',
  summary: string,
  secret: string,
  detailsUri?: string
): Promise<Attestation> {
  const signedAt = Date.now();
  const canonical = canonicalizePayload(gateId, commitSha, verdict, signedAt);

  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );

  const signatureBytes = await crypto.subtle.sign('HMAC', key, enc.encode(canonical));
  const signatureHex = Array.from(new Uint8Array(signatureBytes))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');

  return {
    gateId,
    commitSha,
    verdict,
    summary,
    detailsUri,
    signedAt,
    signature: signatureHex,
  };
}

/**
 * Verifies the HMAC-SHA256 signature of an attestation
 */
export async function verifyAttestation(
  attestation: Attestation,
  secret: string
): Promise<boolean> {
  const canonical = canonicalizePayload(
    attestation.gateId,
    attestation.commitSha,
    attestation.verdict,
    attestation.signedAt
  );

  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['verify']
  );

  // Convert hex back to bytes
  const signatureBytes = new Uint8Array(
    attestation.signature.match(/.{1,2}/g)?.map((byte) => parseInt(byte, 16)) || []
  );

  return await crypto.subtle.verify('HMAC', key, signatureBytes, enc.encode(canonical));
}
