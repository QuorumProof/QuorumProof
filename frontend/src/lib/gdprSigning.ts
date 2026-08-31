/**
 * GDPR request signing utilities
 * Signs challenges and payload to prove ownership of a credential subject address
 */

import { signMessage } from '@stellar/freighter-api';

/**
 * Generate a challenge nonce for GDPR requests (ISO timestamp + random suffix)
 */
export function generateChallenge(): string {
  const timestamp = new Date().toISOString();
  const random = Math.random().toString(36).substring(2, 15);
  return `${timestamp}:${random}`;
}

/**
 * Sign a GDPR request payload with the connected wallet
 * Proves the signer controls the credential subject address
 */
export async function signGdprRequest(
  credentialId: number,
  challenge: string,
  subjectAddress: string
): Promise<string> {
  const message = `GDPR_REQUEST:${credentialId}:${challenge}:${subjectAddress}`;
  
  // Use Freighter's signMessage API
  const result = await signMessage(message);
  
  if ('error' in result && result.error) {
    throw new Error(`Failed to sign GDPR request: ${result.error}`);
  }
  
  return result.signedMessage;
}

/**
 * Verify that a signature matches the expected message format
 * This is a client-side check; server performs cryptographic verification
 */
export function validateSignatureFormat(signature: string): boolean {
  // Signature should be non-empty and base64-like
  return signature.length > 0 && /^[A-Za-z0-9+/=]+$/.test(signature);
}

/**
 * Extract the signer address from a signed message (client-side verification)
 * Server-side will perform cryptographic verification
 */
export async function extractSignerAddress(message: string, signature: string): Promise<string | null> {
  try {
    // This is a placeholder for actual cryptographic verification
    // In production, the server should verify the signature and extract the signer address
    // For now, we return null to indicate the server must verify
    return null;
  } catch {
    return null;
  }
}

/**
 * Create a signed GDPR request payload
 */
export interface SignedGdprRequestPayload {
  credentialId: number;
  challenge: string;
  signature: string;
  subjectAddress: string;
}

export async function createSignedGdprRequest(
  credentialId: number,
  subjectAddress: string
): Promise<SignedGdprRequestPayload> {
  const challenge = generateChallenge();
  const signature = await signGdprRequest(credentialId, challenge, subjectAddress);
  
  if (!validateSignatureFormat(signature)) {
    throw new Error('Invalid signature format from wallet');
  }
  
  return {
    credentialId,
    challenge,
    signature,
    subjectAddress,
  };
}
