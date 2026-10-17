import { Keypair, StrKey } from '@stellar/stellar-sdk';

const SIGNATURE_HEX_PATTERN = /^[0-9a-fA-F]{128}$/;

export function buildBatchAttestationMessage(
  attestorAddress: string,
  sliceId: string,
  credentialIds: string[],
): string {
  return [
    'QuorumProof Batch Attestation',
    `attestor:${attestorAddress}`,
    `sliceId:${sliceId}`,
    `credentialIds:${credentialIds.join(',')}`,
  ].join('\n');
}

export function verifyBatchAttestationSignature(
  attestorAddress: string,
  sliceId: string,
  credentialIds: string[],
  signatureHex: string,
): { valid: boolean; reason?: string } {
  if (!StrKey.isValidEd25519PublicKey(attestorAddress)) {
    return { valid: false, reason: 'attestor is not a valid Stellar ed25519 public key' };
  }
  if (!SIGNATURE_HEX_PATTERN.test(signatureHex)) {
    return { valid: false, reason: 'signature must be a 128-character hex-encoded 64-byte ed25519 signature' };
  }

  const message = Buffer.from(
    buildBatchAttestationMessage(attestorAddress, sliceId, credentialIds),
    'utf8',
  );

  try {
    return Keypair.fromPublicKey(attestorAddress).verify(message, Buffer.from(signatureHex, 'hex'))
      ? { valid: true }
      : { valid: false, reason: 'signature verification failed' };
  } catch {
    return { valid: false, reason: 'signature verification failed' };
  }
}
