/**
 * GDPR request signing utilities
 * Prepares wallet-signed payloads for server-side ownership verification.
 * No client-side signer recovery or authentication is performed here.
 * See docs/gdpr-compliance.md for the verification contract.
 */

import { signMessage } from '@stellar/freighter-api';

/**
 * Generate a challenge nonce for GDPR requests (ISO timestamp + random suffix)
 */
export function generateChallenge(): string {
  const timestamp = new Date().toISOString();
  const randomBytes = globalThis.crypto.getRandomValues(new Uint8Array(16));
  const random = Array.from(randomBytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${timestamp}:${random}`;
}

/**
 * Sign a GDPR request payload with the connected wallet
 * The supplied subject address is a claim until the server verifies the
 * signature against the credential subject; signing alone does not authorize it.
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
 * Check only that the wallet result is non-empty and base64-like.
 * This does not verify a signature or identify its signer. Cryptographic
 * verification and credential ownership checks belong on the server.
 */
export function validateSignatureFormat(signature: string): boolean {
  // Signature should be non-empty and base64-like
  return signature.length > 0 && /^[A-Za-z0-9+/=]+$/.test(signature);
}

/**
 * Payload sent to POST /api/gdpr/request for server-side verification.
 * subjectAddress is caller-supplied, not a recovered or authenticated signer.
 */
export interface SignedGdprRequestPayload {
  credentialId: number;
  challenge: string;
  signature: string;
  subjectAddress: string;
}

/**
 * Build the payload to submit to the API, checking signature format only.
 * Callers must not treat successful creation as proof of credential ownership.
 */
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
