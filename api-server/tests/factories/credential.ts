/**
 * Credential factory (Issue #1677).
 *
 * Produces JSON-shaped credential records matching the `Credential` struct in
 * `contracts/quorum_proof/src/lib.rs`. Enum fields use the contract's numeric
 * discriminants.
 */

import { nextStellarAddress } from './stellar.js';

/** Contract `CredentialStatus` discriminants (`Active = 1`, `ExpiringSoon = 2`, `Expired = 3`). */
export const CREDENTIAL_STATUS = { Active: 1, ExpiringSoon: 2, Expired: 3 } as const;

/** Contract `RenewalStatus` discriminants (`Active = 0`, `Renewed = 1`, `Expired = 2`). */
export const RENEWAL_STATUS = { Active: 0, Renewed: 1, Expired: 2 } as const;

export interface CredentialFixture {
  id: number;
  subject: string;
  issuer: string;
  credential_type: number;
  /** Hex-encoded SHA-256 of the off-chain metadata. */
  metadata_hash: string;
  revoked: boolean;
  suspended: boolean;
  status: number;
  /** Unix seconds, or null for a credential that never expires. */
  expires_at: number | null;
  version: number;
  renewal_status: number;
  required_attestations: number;
  metadata_schema_version: number;
}

let credentialSeq = 0;

/** Build one credential. Overrides replace any default field. */
export function buildCredential(overrides: Partial<CredentialFixture> = {}): CredentialFixture {
  credentialSeq += 1;
  const defaults: CredentialFixture = {
    id: credentialSeq,
    subject: nextStellarAddress(),
    issuer: nextStellarAddress(),
    credential_type: 1,
    metadata_hash: credentialSeq.toString(16).padStart(64, '0'),
    revoked: false,
    suspended: false,
    status: CREDENTIAL_STATUS.Active,
    expires_at: null,
    version: 1,
    renewal_status: RENEWAL_STATUS.Active,
    required_attestations: 1,
    metadata_schema_version: 1,
  };
  const credential = { ...defaults, ...overrides };
  if (credential.required_attestations < 1) {
    throw new Error('credential factory: required_attestations must be at least 1');
  }
  if (credential.version < 1) {
    throw new Error('credential factory: version must be at least 1');
  }
  return credential;
}

/** Build `count` credentials, each with its own id and addresses. */
export function buildCredentials(count: number, overrides: Partial<CredentialFixture> = {}): CredentialFixture[] {
  return Array.from({ length: count }, () => buildCredential(overrides));
}

/** Reset the credential id sequence. */
export function resetCredentialSequence(): void {
  credentialSeq = 0;
}
