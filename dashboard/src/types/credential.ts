/**
 * Credential types and interfaces for the QuorumProof dashboard.
 *
 * CredentialType mirrors the ClaimType variants in
 * `dashboard/src/lib/contracts/types.ts` (which themselves map 1-to-1
 * to the on-chain `ClaimType` enum used by the `quorum_proof` and
 * `zk_verifier` contracts).  Any new variant added here MUST have a
 * corresponding ClaimType entry and a matching icon/label mapping in
 * both CredentialCard and AttestationPanel — the `satisfies` constraint
 * on those switch maps will catch a missing case at compile time.
 */

export type CredentialStatus = 'attested' | 'pending' | 'revoked'

/**
 * Supported credential categories.
 *
 * Mapping to on-chain ClaimType:
 *   degree      → ClaimType.HasDegree
 *   license     → ClaimType.HasLicense
 *   employment  → ClaimType.HasEmploymentHistory
 *   certification → ClaimType.HasCertification
 *   research    → ClaimType.HasResearchPublication
 *
 * 'achievement' has been removed — it has no on-chain ClaimType analog.
 */
export type CredentialType =
  | 'degree'
  | 'license'
  | 'employment'
  | 'certification'
  | 'research'

export interface Credential {
  /**
   * Unique identifier for the credential
   */
  id: string

  /**
   * Type of credential
   */
  type: CredentialType

  /**
   * Display name/title of the credential
   */
  title: string

  /**
   * Subject address (e.g., wallet address or email)
   */
  subjectAddress: string

  /**
   * Date when the credential was issued
   */
  issuanceDate: Date

  /**
   * Current status of the credential
   */
  status: CredentialStatus

  /**
   * Optional expiration date
   */
  expirationDate?: Date

  /**
   * Issuer information
   */
  issuer: {
    name: string
    icon?: string
  }

  /**
   * Optional revocation reason (if status is 'revoked')
   */
  revocationReason?: string
}
