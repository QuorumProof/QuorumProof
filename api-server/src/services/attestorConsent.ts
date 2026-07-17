import { Keypair, StrKey } from '@stellar/stellar-sdk';

const SIGNATURE_HEX_PATTERN = /^[0-9a-fA-F]{128}$/; // 64-byte ed25519 signature, hex-encoded

/**
 * Canonical message an attestor signs to consent to a GDPR erasure request.
 * Binding requestId + credentialId + the attestor's own address prevents a
 * signature collected for one request (or one attestor) from being replayed
 * against another.
 */
export function buildConsentMessage(requestId: string, credentialId: number, attestorAddress: string): string {
  return `QuorumProof GDPR Erasure Consent\nrequestId:${requestId}\ncredentialId:${credentialId}\nattestor:${attestorAddress}`;
}

export interface ConsentVerificationResult {
  valid: boolean;
  reason?: string;
}

/**
 * Verifies that `signatureHex` is a genuine ed25519 signature, by the holder
 * of `attestorAddress`'s private key, over the canonical consent message for
 * this request. This is the cryptographic binding required for a "consent" —
 * without it, any caller could POST an arbitrary address string and have it
 * counted, regardless of whether that party ever agreed to anything.
 */
export function verifyAttestorConsentSignature(
  attestorAddress: string,
  requestId: string,
  credentialId: number,
  signatureHex: string,
): ConsentVerificationResult {
  if (!StrKey.isValidEd25519PublicKey(attestorAddress)) {
    return { valid: false, reason: 'attestorAddress is not a valid Stellar ed25519 public key' };
  }
  if (typeof signatureHex !== 'string' || !SIGNATURE_HEX_PATTERN.test(signatureHex)) {
    return { valid: false, reason: 'signature must be a 128-character hex-encoded 64-byte ed25519 signature' };
  }

  const message = Buffer.from(buildConsentMessage(requestId, credentialId, attestorAddress), 'utf8');
  const signature = Buffer.from(signatureHex, 'hex');

  try {
    const keypair = Keypair.fromPublicKey(attestorAddress);
    return keypair.verify(message, signature)
      ? { valid: true }
      : { valid: false, reason: 'signature verification failed' };
  } catch {
    return { valid: false, reason: 'signature verification failed' };
  }
}
