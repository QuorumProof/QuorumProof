/**
 * Soulbound token (SBT) factory (Issue #1677).
 *
 * Produces JSON-shaped SBTs matching the `SoulboundToken` struct in
 * `contracts/sbt_registry/src/lib.rs`. An SBT is non-transferable, so the
 * factory has no transfer helper; ownership changes are expressed by
 * building a new fixture.
 */

import { nextStellarAddress } from './stellar.js';

export interface SbtFixture {
  id: number;
  owner: string;
  credential_id: number;
  metadata_uri: string;
  /** Starts at 1 on mint and increments on each metadata update. */
  version: number;
  /** Set when this SBT has been upgraded to another SBT id (Issue #992). */
  upgraded_to: number | null;
  /** Optional co-owner for jointly issued credentials (Issue #1275). */
  co_owner: string | null;
}

let sbtSeq = 0;

/** Build one SBT. Overrides replace any default field. */
export function buildSbt(overrides: Partial<SbtFixture> = {}): SbtFixture {
  sbtSeq += 1;
  const sbt: SbtFixture = {
    id: sbtSeq,
    owner: nextStellarAddress(),
    credential_id: sbtSeq,
    metadata_uri: `ipfs://bafy-test-${sbtSeq}`,
    version: 1,
    upgraded_to: null,
    co_owner: null,
    ...overrides,
  };
  if (sbt.version < 1) {
    throw new Error('sbt factory: version must be at least 1');
  }
  if (sbt.co_owner !== null && sbt.co_owner === sbt.owner) {
    throw new Error('sbt factory: co_owner must differ from owner');
  }
  if (sbt.upgraded_to === sbt.id) {
    throw new Error('sbt factory: an SBT cannot be upgraded to itself');
  }
  return sbt;
}

/** Build `count` SBTs, each with its own id, owner and credential id. */
export function buildSbts(count: number, overrides: Partial<SbtFixture> = {}): SbtFixture[] {
  return Array.from({ length: count }, () => buildSbt(overrides));
}

/** Reset the SBT id sequence. */
export function resetSbtSequence(): void {
  sbtSeq = 0;
}
