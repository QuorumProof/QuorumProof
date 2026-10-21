import { Keypair, StrKey } from '@stellar/stellar-sdk';
import { randomBytes } from 'crypto';

/**
 * Authorization helpers for threshold-encrypted credentials.
 *
 * Issues #1742 / #1743: decryption authorization must be granted by the key
 * custodians, and decryption requests must be bound to a verified Stellar
 * identity. Both rely on ed25519 signatures over canonical messages that
 * bind the credential, the requester, and a freshness marker, so a signature
 * collected for one request cannot be replayed against another.
 */

const SIGNATURE_HEX_PATTERN = /^[0-9a-fA-F]{128}$/; // 64-byte ed25519 signature, hex-encoded

/** How long a custodian approval remains usable after it was signed. */
export const APPROVAL_MAX_AGE_MS = 10 * 60 * 1000;
/** Tolerated clock skew for approvals signed slightly in the future. */
export const APPROVAL_CLOCK_SKEW_MS = 60 * 1000;
/** How long a decryption challenge nonce stays valid. */
export const CHALLENGE_TTL_MS = 5 * 60 * 1000;

export function buildDecryptionApprovalMessage(
  credentialId: string,
  requesterAddress: string,
  issuedAt: number,
): string {
  return `QuorumProof Decryption Approval\ncredentialId:${credentialId}\nrequester:${requesterAddress}\nissuedAt:${issuedAt}`;
}

export function buildDecryptionChallengeMessage(
  credentialId: string,
  requesterAddress: string,
  nonce: string,
): string {
  return `QuorumProof Decryption Request\ncredentialId:${credentialId}\nrequester:${requesterAddress}\nnonce:${nonce}`;
}

/**
 * Returns true only when `signatureHex` is a valid ed25519 signature by the
 * private key behind the Stellar public key `address` over `message`.
 */
export function verifyEd25519Signature(address: string, message: string, signatureHex: unknown): boolean {
  if (!StrKey.isValidEd25519PublicKey(address)) return false;
  if (typeof signatureHex !== 'string' || !SIGNATURE_HEX_PATTERN.test(signatureHex)) return false;

  try {
    return Keypair.fromPublicKey(address).verify(
      Buffer.from(message, 'utf8'),
      Buffer.from(signatureHex, 'hex'),
    );
  } catch {
    return false;
  }
}

export interface CustodianApproval {
  custodian: string;
  issued_at: number;
  signature: string;
}

/**
 * Returns the distinct custodians whose approvals are valid for this
 * credential and requester. An approval counts only if its signer is one of
 * the credential's configured key custodians, it is fresh, and its signature
 * verifies over the canonical approval message.
 */
export function collectValidApprovals(
  credentialId: string,
  requesterAddress: string,
  keyCustodians: string[],
  approvals: unknown[],
  now: number,
): string[] {
  const custodians = new Set(keyCustodians);
  const valid = new Set<string>();

  for (const item of approvals) {
    if (!item || typeof item !== 'object') continue;
    const { custodian, issued_at, signature } = item as Partial<CustodianApproval>;

    if (typeof custodian !== 'string' || !custodians.has(custodian) || valid.has(custodian)) continue;
    if (typeof issued_at !== 'number' || !Number.isFinite(issued_at)) continue;
    if (now - issued_at > APPROVAL_MAX_AGE_MS) continue;
    if (issued_at - now > APPROVAL_CLOCK_SKEW_MS) continue;

    const message = buildDecryptionApprovalMessage(credentialId, requesterAddress, issued_at);
    if (verifyEd25519Signature(custodian, message, signature)) {
      valid.add(custodian);
    }
  }

  return [...valid];
}

export interface DecryptionChallenge {
  nonce: string;
  credentialId: string;
  requesterAddress: string;
  expiresAt: number;
}

/**
 * Single-use challenge nonces for decryption requests. A nonce is consumed on
 * first use, so a captured signed request cannot be replayed.
 *
 * State is held in process memory. Multi-replica deployments need sticky
 * routing for the challenge and decrypt calls, or a shared store.
 */
export class DecryptionChallengeStore {
  private readonly challenges = new Map<string, DecryptionChallenge>();

  constructor(private readonly now: () => number = Date.now) {}

  issue(credentialId: string, requesterAddress: string): DecryptionChallenge {
    this.prune();
    const challenge: DecryptionChallenge = {
      nonce: randomBytes(16).toString('hex'),
      credentialId,
      requesterAddress,
      expiresAt: this.now() + CHALLENGE_TTL_MS,
    };
    this.challenges.set(challenge.nonce, challenge);
    return challenge;
  }

  /**
   * Removes and returns the challenge for `nonce`, or null when it is unknown
   * or expired. The nonce is removed whether or not the caller's later checks
   * succeed.
   */
  consume(nonce: string): DecryptionChallenge | null {
    const challenge = this.challenges.get(nonce);
    if (!challenge) return null;
    this.challenges.delete(nonce);
    return challenge.expiresAt > this.now() ? challenge : null;
  }

  private prune(): void {
    const now = this.now();
    for (const [nonce, challenge] of this.challenges) {
      if (challenge.expiresAt <= now) this.challenges.delete(nonce);
    }
  }
}
