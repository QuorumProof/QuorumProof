/**
 * Deterministic Stellar account addresses for test fixtures (Issue #1677).
 *
 * Addresses are derived from a counter, so the same sequence of factory calls
 * always yields the same addresses, and every address is a valid `G...`
 * ed25519 public key that passes StrKey validation.
 */

import { Keypair } from '@stellar/stellar-sdk';

let addressSeq = 0;

/** Derive a valid Stellar public key for the given index. */
export function stellarAddressFor(index: number): string {
  const seed = Buffer.alloc(32);
  seed.writeUInt32BE(index >>> 0, 28);
  return Keypair.fromRawEd25519Seed(seed).publicKey();
}

/** Return the next unique address in the factory sequence. */
export function nextStellarAddress(): string {
  addressSeq += 1;
  return stellarAddressFor(addressSeq);
}

/** Reset the address sequence. Called by `resetFactorySequences()`. */
export function resetStellarAddressSequence(): void {
  addressSeq = 0;
}
