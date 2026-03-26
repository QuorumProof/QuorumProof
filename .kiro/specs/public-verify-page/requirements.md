# Requirements Document

## Introduction

The public verification page (`/verify`) allows employers, institutions, and any third party to
instantly verify an engineer's on-chain credentials without connecting a Stellar wallet.
A visitor can look up a credential by its numeric ID or by the engineer's Stellar address,
inspect full credential metadata and the list of attesting institutions, and optionally run a
Zero-Knowledge (ZK) claim check to confirm a specific property (degree, license, or employment
history) without exposing the underlying credential data.

The existing `Verify.tsx` implementation covers the broad structure but has several gaps that
must be closed: the shareable URL query-param key must change from `?credentialId=` to `?id=`,
the `is_attested` on-chain call must be wired in, the ZK claim-type dropdown must be aligned
with the on-chain `ClaimType` enum, the `verifyClaim` call must use the properly-encoded ScVal
from `zkVerifier.ts`, and the ZK result must include a tooltip explaining ZK privacy.

---

## Glossary

- **Verify_Page**: The React component rendered at the `/verify` route (`frontend/src/pages/Verify.tsx`).
- **QuorumProof_Contract**: The Soroban smart contract that stores credentials, quorum slices, and attestations; accessed via `frontend/src/lib/contracts/quorumProof.ts`.
- **ZK_Verifier_Contract**: The Soroban smart contract that verifies zero-knowledge proofs; accessed via `frontend/src/lib/contracts/zkVerifier.ts`.
- **Credential**: An on-chain record with fields `id`, `subject`, `issuer`, `credential_type`, `metadata_hash`, `revoked`, and `expires_at`.
- **QuorumSlice**: An on-chain record grouping a set of attestor addresses with a threshold; identified by a `sliceId`.
- **Attestor**: A trusted institution address that has signed a credential within a QuorumSlice.
- **ClaimType**: The on-chain enum with exactly three variants: `HasDegree`, `HasLicense`, `HasEmploymentHistory`.
- **ZK_Proof**: A hex-encoded byte string representing a zero-knowledge proof submitted by the verifier.
- **Share_URL**: A URL of the form `/verify?id={credentialId}` that encodes a specific credential for direct linking.
- **Stellar_Address**: A 56-character public key beginning with `G`, identifying an account on the Stellar network.

---

## Requirements

### Requirement 1: Public Access Without Wallet

**User Story:** As an employer, I want to open the verification page without connecting a wallet,
so that I can verify credentials quickly without any account setup.

#### Acceptance Criteria

1. THE Verify_Page SHALL be accessible at the `/verify` route without requiring wallet connection or authentication.
2. THE Verify_Page SHALL NOT render any wallet-connect prompt or wallet-dependent UI element.
3. THE Verify_Page SHALL perform all on-chain reads via simulation (no transaction signing required).

---

### Requirement 2: Search by Credential ID

**User Story:** As an employer, I want to enter a credential ID and retrieve the matching credential,
so that I can confirm a specific credential shared by an engineer.

#### Acceptance Criteria

1. THE Verify_Page SHALL provide a numeric input field for entering a credential ID.
2. WHEN a user submits a valid positive-integer credential ID, THE Verify_Page SHALL call `get_credential` on the QuorumProof_Contract and display the returned Credential.
3. WHEN a user submits a credential ID that is zero, negative, or non-numeric, THE Verify_Page SHALL display a descriptive validation error without making any on-chain call.
4. IF the `get_credential` simulation returns an error, THEN THE Verify_Page SHALL display a human-readable error message and SHALL NOT crash.

---

### Requirement 3: Search by Stellar Address

**User Story:** As an employer, I want to enter an engineer's Stellar address and see all their
credentials, so that I can browse the full credential history for that person.

#### Acceptance Criteria

1. THE Verify_Page SHALL provide a text input field for entering a Stellar_Address.
2. WHEN a user submits a valid Stellar_Address, THE Verify_Page SHALL call `get_credentials_by_subject` on the QuorumProof_Contract and display the list of returned credential IDs.
3. WHEN a user selects a credential ID from the address-lookup results, THE Verify_Page SHALL fetch and display the full Credential details for that ID.
4. WHEN a valid Stellar_Address has no associated credentials, THE Verify_Page SHALL display an empty-state message indicating no credentials were found.
5. WHEN a user submits a string that does not begin with `G` or is shorter than 56 characters, THE Verify_Page SHALL display a descriptive validation error without making any on-chain call.
6. IF the `get_credentials_by_subject` simulation returns an error, THEN THE Verify_Page SHALL display a human-readable error message and SHALL NOT crash.

---

### Requirement 4: On-Chain Attestation Status via `is_attested`

**User Story:** As an employer, I want to see whether a credential has met its quorum threshold,
so that I know the credential has been formally attested by the required number of institutions.

#### Acceptance Criteria

1. WHEN a Credential is loaded, THE Verify_Page SHALL call `is_attested` on the QuorumProof_Contract with the credential's `id` and the associated `sliceId`.
2. WHEN `is_attested` returns `true`, THE Verify_Page SHALL display a "Credential Verified" status indicating quorum has been reached.
3. WHEN `is_attested` returns `false`, THE Verify_Page SHALL display a status indicating the credential has not yet reached quorum.
4. THE Verify_Page SHALL also call `get_attestors` on the QuorumProof_Contract and display the full list of Attestor addresses that have signed the Credential.
5. IF the `is_attested` simulation returns an error, THEN THE Verify_Page SHALL treat the attestation status as unconfirmed and display an appropriate warning rather than crashing.

---

### Requirement 5: Credential Metadata Display

**User Story:** As an employer, I want to see all metadata for a credential in a readable format,
so that I can confirm the credential details match what the engineer claimed.

#### Acceptance Criteria

1. WHEN a Credential is loaded, THE Verify_Page SHALL display the credential `id`, `credential_type` label, `subject` address, `issuer` address, decoded `metadata_hash`, and `expires_at` date.
2. WHEN a Credential has `revoked` set to `true`, THE Verify_Page SHALL display a "Revoked" status banner prominently.
3. WHEN a Credential is expired (as determined by `is_expired`), THE Verify_Page SHALL display an "Expired" status banner with the expiry date.
4. WHEN a Credential is active, not revoked, and has at least one Attestor, THE Verify_Page SHALL display a "Credential Verified" status banner.
5. WHEN a Credential is active but has zero Attestors, THE Verify_Page SHALL display an "Awaiting Attestation" status banner.

---

### Requirement 6: Shareable URL with `?id=` Query Parameter

**User Story:** As an employer, I want to copy a direct link to a specific credential,
so that I can share it with colleagues or store it for audit purposes.

#### Acceptance Criteria

1. WHEN a Credential is displayed, THE Verify_Page SHALL generate a Share_URL using the query parameter key `id` (i.e. `/verify?id={credentialId}`).
2. THE Verify_Page SHALL display the Share_URL and provide a one-click copy button.
3. WHEN the Verify_Page is loaded with a `?id=` query parameter containing a valid credential ID, THE Verify_Page SHALL automatically trigger credential lookup for that ID without requiring user interaction.
4. FOR ALL valid credential IDs `n`, navigating to `/verify?id=n` SHALL produce the same displayed result as manually entering `n` in the credential ID input and submitting (round-trip property).
5. WHEN the Verify_Page is loaded with a `?id=` query parameter containing an invalid value, THE Verify_Page SHALL display a validation error rather than making an on-chain call.

---

### Requirement 7: ZK Claim Verification Form

**User Story:** As an employer, I want to verify a specific ZK claim about a credential,
so that I can confirm a property (e.g. holds a degree) without seeing the full credential data.

#### Acceptance Criteria

1. THE Verify_Page SHALL display a ZK claim verification form when a Credential is loaded.
2. THE Verify_Page SHALL provide a claim-type dropdown containing exactly the three options that correspond to the on-chain ClaimType enum: `HasDegree` (displayed as "🎓 Degree"), `HasLicense` (displayed as "🏛️ License"), and `HasEmploymentHistory` (displayed as "💼 Employment").
3. THE Verify_Page SHALL NOT include claim-type options that do not correspond to a variant of the on-chain ClaimType enum.
4. THE Verify_Page SHALL provide a text area for pasting hex-encoded ZK_Proof bytes.
5. WHEN a user submits the ZK form with a selected ClaimType and a non-empty proof, THE Verify_Page SHALL call `verifyClaim` from `zkVerifier.ts` (not from `stellar.ts`) with the credential ID, the ClaimType encoded as `scvVec([scvSymbol(claimType)])`, and the proof bytes.
6. WHEN `verifyClaim` returns `true`, THE Verify_Page SHALL display "✅ Claim Verified".
7. WHEN `verifyClaim` returns `false`, THE Verify_Page SHALL display "❌ Claim Not Verified".
8. WHEN the ZK result is displayed (either verified or not verified), THE Verify_Page SHALL show a tooltip or inline explanation stating that ZK proofs confirm a property without revealing the underlying credential data.
9. WHEN the proof field is empty and the user submits the ZK form, THE Verify_Page SHALL display a validation error without making any on-chain call.
10. IF the `verifyClaim` simulation returns an error, THEN THE Verify_Page SHALL display a human-readable error message and SHALL NOT crash.

---

### Requirement 8: ClaimType Encoding Alignment

**User Story:** As a developer, I want the ZK claim type to be encoded correctly for the on-chain
contract, so that `verifyClaim` calls do not silently fail due to type mismatches.

#### Acceptance Criteria

1. THE Verify_Page SHALL import and call `verifyClaim` from `frontend/src/lib/contracts/zkVerifier.ts`, which encodes ClaimType as `xdr.ScVal.scvVec([xdr.ScVal.scvSymbol(claimType)])`.
2. THE Verify_Page SHALL NOT call `verifyClaim` from `frontend/src/stellar.ts`, which encodes ClaimType as a plain string ScVal and is therefore incompatible with the on-chain enum.
3. THE Verify_Page SHALL pass one of the three valid ClaimType string literals (`"HasDegree"`, `"HasLicense"`, `"HasEmploymentHistory"`) to `zkVerifier.ts`'s `verifyClaim` function.
4. FOR ALL valid ClaimType values `c`, calling `verifyClaim` with `c` SHALL produce the same on-chain ScVal encoding as the `claimTypeToScVal` function defined in `zkVerifier.ts` (invariant: encoding is consistent).

---

### Requirement 9: Error Handling and Loading States

**User Story:** As a user, I want clear feedback during loading and on errors,
so that I understand what is happening and can take corrective action.

#### Acceptance Criteria

1. WHILE an on-chain simulation is in progress, THE Verify_Page SHALL display a loading indicator and SHALL disable the submit button.
2. IF any on-chain simulation call fails with a network or contract error, THEN THE Verify_Page SHALL display an error card with the error message and SHALL NOT leave the UI in a broken state.
3. WHEN an error is displayed and the user submits a new search, THE Verify_Page SHALL clear the previous error before initiating the new lookup.
4. IF the `VITE_CONTRACT_QUORUM_PROOF` environment variable is not set, THEN THE Verify_Page SHALL display a configuration warning badge rather than crashing on load.
