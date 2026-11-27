# QuorumProof — Error Code Reference

All contract errors surface as `Error(Contract, #N)` in Soroban transaction results. This guide covers every error code across the three contracts, with the scenario that triggers it and how to recover.

---

## QuorumProof Contract

### #1 — `CredentialNotFound`
**Trigger:** A function was called with a `credential_id` that does not exist in storage.

```rust
// Example: querying a credential that was never issued
client.get_credential(&999u64); // panics with Error(Contract, #1)
```

**Recovery:** Verify the credential ID with `credential_exists(credential_id)` before calling. If issuing, ensure `issue_credential` completed successfully and store the returned ID.

---

### #2 — `SliceNotFound`
**Trigger:** A function was called with a `slice_id` that does not exist.

```rust
client.attest(&attestor, &cred_id, &999u64, &true, &None); // Error(Contract, #2)
```

**Recovery:** Use `slice_exists(slice_id)` to check before attesting. Retrieve valid slice IDs from `get_slice_count` or store them at creation time.

---

### #3 — `ContractPaused`
**Trigger:** A state-mutating function was called while the contract is paused by the admin.

```rust
client.pause(&admin);
client.issue_credential(...); // Error(Contract, #3)
```

**Recovery:** Wait for the admin to call `unpause`. Check current state with `is_paused()` before submitting transactions.

---

### #4 — `DuplicateCredential`
**Trigger:** Attempting to issue a credential for a `(subject, issuer, credential_type)` combination that already exists.

```rust
client.issue_credential(&issuer, &subject, &1u32, &hash, &None);
client.issue_credential(&issuer, &subject, &1u32, &hash, &None); // Error(Contract, #4)
```

**Recovery:** Check for an existing credential with `get_credentials_by_subject` before issuing. To update a credential, use `update_metadata` instead.

---

### #5 — `DuplicateAttestor`
**Trigger:** An attestor attempts to attest a credential they have already attested.

```rust
client.attest(&attestor, &cred_id, &slice_id, &true, &None);
client.attest(&attestor, &cred_id, &slice_id, &true, &None); // Error(Contract, #5)
```

**Recovery:** Check `get_attestors(credential_id)` to see who has already attested before submitting.

---

### #6 — `AttestationExpired`
**Trigger:** An operation references an attestation that has passed its `expires_at` timestamp.

**Recovery:** Call `renew_attestation(attestor, credential_id, new_expires_at)` to extend the expiry before it lapses, or re-attest after the old record is cleared.

---

### #7 — `InvalidInput`
**Trigger:** A function received an argument that fails validation (e.g. empty array, mismatched lengths, value out of allowed range).

```rust
// Example: threshold exceeds number of attestors
client.create_slice(&creator, &attestors_len_2, &weights, &5u32); // Error(Contract, #7)
```

**Recovery:** Review the function's documented constraints. Common causes: `threshold > attestors.len()`, batch arrays of different lengths, page size of zero.

---

### #8 — `InvalidAddress`
**Trigger:** A zero/default address was passed where a real account address is required.

**Recovery:** Ensure all `Address` arguments are generated from real Stellar keypairs, not default-constructed.

---

### #9 — `OnboardingNotFound`
**Trigger:** An operation referenced an onboarding request ID that does not exist.

**Recovery:** Retrieve active onboarding request IDs before operating on them.

---

### #10 — `DisputeNotFound`
**Trigger:** An operation referenced a dispute ID that does not exist.

**Recovery:** Retrieve active dispute IDs before voting or resolving.

---

### #11 — `UnauthorizedAction`
**Trigger:** The caller does not have permission for the requested operation (e.g. non-admin calling an admin function, non-issuer revoking a credential).

```rust
// Example: non-admin trying to pause
client.pause(&non_admin); // Error(Contract, #11)
```

**Recovery:** Ensure the correct authority signs the transaction. Admin functions require the address passed to `initialize`. Credential operations require the original issuer.

---

### #12 — `InvalidApprovalWorkflow`
**Trigger:** An approval step was attempted out of sequence or in an invalid state.

**Recovery:** Follow the correct workflow order: initiate → approve (N times) → execute.

---

### #13 — `AlreadyChallenged`
**Trigger:** A challenge was submitted for a `(credential_id, accused)` pair that already has an active challenge.

**Recovery:** Resolve or wait for the existing challenge to complete before opening a new one.

---

### #14 — `ChallengeNotFound`
**Trigger:** An operation referenced a challenge ID that does not exist.

**Recovery:** Verify the challenge ID exists before voting or resolving.

---

### #15 — `ChallengeResolved`
**Trigger:** An attempt was made to vote on or interact with a challenge that has already been resolved.

**Recovery:** No action needed — the challenge is closed. Query the result to see the outcome.

---

### #16 — `NotAttested`
**Trigger:** An operation requires the credential to be attested (quorum met) but it is not.

**Recovery:** Ensure all required attestors in the slice have called `attest` and the threshold is met. Use `is_attested(credential_id, slice_id)` to check.

---

### #17 — `NotInSlice`
**Trigger:** An address attempted to attest but is not a member of the specified quorum slice.

```rust
// attestor2 is not in the slice
client.attest(&attestor2, &cred_id, &slice_id, &true, &None); // Error(Contract, #17)
```

**Recovery:** Add the attestor to the slice with `add_attestor(slice_id, attestor)` (requires slice creator auth), or use a slice they belong to.

---

### #18 — `AccusedCannotVote`
**Trigger:** The accused party in a challenge attempted to vote on their own challenge.

**Recovery:** The accused must recuse themselves; only other slice members may vote.

---

### #19 — `AlreadyVoted`
**Trigger:** An address attempted to vote on a challenge or dispute they have already voted on.

**Recovery:** Each address may only vote once per challenge/dispute. No further action needed.

---

### #20 — `AttestationWindowOutside`
**Trigger:** `attest` was called outside the configured time window for a credential.

```rust
// Window is [1000, 2000]; current timestamp is 500
client.attest(...); // Error(Contract, #20)
```

**Recovery:** Call `get_attestation_window(credential_id)` to check the allowed range, then submit the attestation within that window. The issuer can update the window with `set_attestation_window`.

---

### #21 — `RecoveryNotFound`
**Trigger:** An operation referenced a recovery request ID that does not exist.

**Recovery:** Initiate a recovery first with `initiate_recovery`, then use the returned ID.

---

### #22 — `RecoveryAlreadyExists`
**Trigger:** A recovery was initiated for a credential that already has an active recovery in progress.

**Recovery:** Wait for the existing recovery to be executed or cancelled before initiating a new one.

---

### #23 — `RecoveryNotPending`
**Trigger:** An approval or execution was attempted on a recovery that is no longer in `Pending` state.

**Recovery:** Check recovery status before approving. If already executed or cancelled, no further action is needed.

---

### #24 — `RecoveryAlreadyApproved`
**Trigger:** An approver attempted to approve a recovery they have already approved.

**Recovery:** Each approver may only approve once. Check existing approvals with `get_recovery_approvals(recovery_id)`.

---

### #25 — `RecoveryThresholdNotMet`
**Trigger:** `execute_recovery` was called before enough approvers have signed off.

**Recovery:** Gather the required number of approvals first. Check progress with `get_recovery_approvals(recovery_id)`.

---

### #26 — `NotRecoveryApprover`
**Trigger:** An address that is not a designated recovery approver attempted to approve a recovery.

**Recovery:** Only addresses listed as approvers at recovery initiation may approve. Verify with `get_recovery_request(recovery_id)`.

---

### #27 — `DuplicateRecoveryApproval`
**Trigger:** The same approver submitted a second approval for the same recovery.

**Recovery:** Each approver signs once. No further action needed.

---

### #28 — `InvalidParentType`
**Trigger:** `register_credential_type` was called with a `parent_type` that does not exist in the registry.

```rust
client.register_credential_type(&admin, &5u32, &name, &desc, &Some(999u32)); // Error(Contract, #28)
```

**Recovery:** Register the parent type first, or omit `parent_type` (`None`) for a root type.

---

### #29 — `CircularHierarchy`
**Trigger:** Registering a credential type would create a cycle in the type hierarchy (e.g. A → B → A).

**Recovery:** Review the intended hierarchy. A type cannot be its own ancestor. Restructure the parent chain to be acyclic.

---

### #30 — `CredentialTypeNotFound`
**Trigger:** `issue_credential` or a hierarchy function was called with an unregistered `credential_type`.

**Recovery:** Register the type with `register_credential_type` before issuing credentials of that type.

---

### #31 — `HolderBlacklisted`
**Trigger:** An issuer attempted to issue a credential to a holder they have blacklisted.

**Recovery:** Remove the holder from the blacklist with `remove_holder_from_blacklist(issuer, holder)` if appropriate, then re-issue.

---

### #32 — `AlreadyBlacklisted`
**Trigger:** `add_holder_to_blacklist` was called for a holder already on the issuer's blacklist.

**Recovery:** No action needed — the holder is already blacklisted. Use `is_holder_blacklisted` to check before calling.

---

### #33 — `NotBlacklisted`
**Trigger:** `remove_holder_from_blacklist` was called for a holder not on the issuer's blacklist.

**Recovery:** Use `is_holder_blacklisted(issuer, holder)` to verify before attempting removal.

---

### #34 — `ForkDetected`
**Trigger:** `attest` was called with a value that conflicts with an existing attestation in the same slice (Byzantine behaviour detected).

```rust
client.attest(&attestor1, &cred_id, &slice_id, &true,  &None);
client.attest(&attestor2, &cred_id, &slice_id, &false, &None); // Error(Contract, #34)
```

**Recovery:** Investigate the conflicting attestors via `get_slice_attestation_status`. Resolve the fork through the challenge mechanism (`challenge_attestation`) or governance before further attestations are accepted.

---

### #35 — `ForkAlreadyResolved`
**Trigger:** An attempt was made to resolve a fork that has already been resolved.

**Recovery:** No action needed — query the current fork status to confirm resolution.

---

### #36 — `NoForkExists`
**Trigger:** A fork-resolution function was called for a `(credential_id, slice_id)` pair with no detected fork.

**Recovery:** Use `detect_fork` to confirm a fork exists before attempting resolution.

---

### #96 — `SubjectIsAttestor` *(Issue #1510)*
**Trigger:** `attest()` was called by the credential's own **subject** while attestor-independence
enforcement is enabled (`is_attestor_independence_enabled() == true`). A credential holder cannot
independently verify their own credential — doing so would defeat the purpose of a quorum.

```rust
// Example: subject tries to attest their own credential — blocked when flag is enabled
client.attest(&subject, &credential_id, &slice_id, &true, &None); // Error(Contract, #96)
```

**Recovery:** Use a genuine third-party attestor who has no identity overlap with the credential's
subject or issuer. If this error occurs unexpectedly, confirm that `is_attestor_independence_enabled()`
returns `true` and that the attesting address does not match the credential subject.

---

### #97 — `IssuerIsAttestor` *(Issue #1510)*
**Trigger:** `attest()` was called by the credential's own **issuer** while attestor-independence
enforcement is enabled. An issuer self-attesting would allow unilateral credential validation with
no independent oversight.

```rust
// Example: issuer tries to attest a credential they issued — blocked when flag is enabled
client.attest(&issuer, &credential_id, &slice_id, &true, &None); // Error(Contract, #97)
```

**Recovery:** Use a genuine third-party attestor. If the issuer must participate in attestation
for a legitimate reason, an admin may temporarily disable enforcement with
`disable_attestor_independence` — document the rationale in the audit log before doing so.

---

## SBT Registry Contract

### #1 — `SoulboundNonTransferable`
**Trigger:** A direct token transfer was attempted on a soulbound token.

```rust
client.transfer(&owner, &recipient, &token_id); // Error(Contract, #1)
```

**Recovery:** SBTs are non-transferable by design. Use `admin_transfer_sbt` (admin only) for exceptional cases such as wallet recovery, or initiate the guardian recovery flow.

---

### #2 — `TokenNotFound`
**Trigger:** An operation referenced a token ID that does not exist or has been burned.

**Recovery:** Verify the token exists with `get_token(token_id)` or look up tokens by owner with `get_tokens_by_owner(owner)`.

---

### #3 — `RecoveryNotFound` *(SBT Registry)*
**Trigger:** An SBT recovery operation referenced a recovery request that does not exist.

**Recovery:** Initiate a recovery with `initiate_recovery` first.

---

### #4 — `RecoveryAlreadyExists` *(SBT Registry)*
**Trigger:** A recovery was initiated for an owner who already has an active recovery in progress.

**Recovery:** Wait for the existing recovery to complete or be finalized before starting a new one.

---

### #5 — `UnauthorizedRecovery`
**Trigger:** An address that is not a designated guardian attempted to approve an SBT recovery.

**Recovery:** Only guardians registered via `setup_recovery_guardians` may approve. Verify the guardian list before submitting.

---

### #6 — `InsufficientApprovals`
**Trigger:** `finalize_recovery` was called before the required number of guardian approvals was reached.

**Recovery:** Collect the required guardian approvals first. Check progress with `get_recovery_approvals`.

---

### #7 — `InvalidGuardian`
**Trigger:** `setup_recovery_guardians` was called with an invalid guardian address (e.g. the owner themselves).

**Recovery:** Guardians must be distinct addresses that are not the token owner. Use trusted third-party addresses.

---

---

## See Also

- [Architecture Overview](architecture.md)
- [Threat Model & Security](threat-model.md)
- [Trust Slice Model](trust-slices.md)

---

## New Error Codes — Issue #1951

The following codes were introduced to replace raw `panic!` string messages with
typed `ContractError` values. Clients that parse Soroban `Error(Contract, #N)`
results can now handle all contract error paths programmatically.

### #99 — `TransactionExpired`
**Trigger:** `advance_phase` was called on a transaction whose `expires_at` timestamp has already passed.

**Recovery:** Begin a new atomic transaction with `init_atomic_operations` and replay the operation.

---

### #100 — `TransactionNotFound`
**Trigger:** A transaction ID was supplied to `advance_phase`, `commit_transaction`, `initiate_rollback`, or `complete_rollback` that does not exist in storage.

**Recovery:** Confirm the `txn_id` returned from `begin_transaction`. The transaction may have already been committed or rolled back and evicted.

---

### #101 — `CannotCommitTransaction`
**Trigger:** `commit_transaction` was called but the transaction has not yet reached `Phase3_ZkVerifier`.

**Recovery:** Advance through all three phases before committing.

---

### #102 — `CannotRollbackTransaction`
**Trigger:** `initiate_rollback` was called on a transaction that is already Committed, RolledBack, or RollingBack; or `complete_rollback` was called on a transaction not in the RollingBack state.

**Recovery:** Check the current transaction phase before attempting rollback.

---

### #103 — `VetoRequestNotFound`
**Trigger:** `cancel_veto` or `execute_veto` was called with a `veto_id` that does not exist in storage.

**Recovery:** Verify the `veto_id` returned from `request_veto`.

---

### #104 — `VetoNotAuthorized`
**Trigger:** `request_veto`, `cancel_veto`, or `execute_veto` was called by an address that is not a registered veto authority.

**Recovery:** Only addresses registered via `add_veto_authority` / `init_veto_authorities` may perform veto operations.

---

### #105 — `VetoInvalidState`
**Trigger:** `cancel_veto` was called on a veto that is already Executed or Cancelled; or `execute_veto` was called on a veto not in Pending or Ready state.

**Recovery:** Check the current `VetoStatus` before calling.

---

### #106 — `MigrationNotInitialized`
**Trigger:** A migration operation was attempted before the migration state was stored in instance storage.

**Recovery:** Call the migration initialization entry point first.

---

### #107 — `MigrationNotSupported`
**Trigger:** `migrate_to_v2` detected a source schema version other than V1.

**Recovery:** Only the V1 → V2 migration path is supported. Ensure the contract is on schema version 1 before migrating.

---

### #108 — `MigrationInvalidState`
**Trigger:** A migration step was called when the migration is in an incompatible state (e.g. already completed, not yet started, or already committed).

**Recovery:** Check the current `MigrationStatus` before calling. Resume or restart migration as appropriate.

---

### #109 — `MigrationCheckpointNotFound`
**Trigger:** A chunked migration step attempted to read a checkpoint that does not exist.

**Recovery:** Ensure the checkpoint was written before resuming a chunked migration.

---

### #110 — `RevocationAccumulatorNotInitialized`
**Trigger:** `store_non_revocation_proof` was called before the BBS+ revocation accumulator was initialized.

**Recovery:** Call `add_to_revocation_accumulator` to initialize the accumulator before submitting proofs.

---

### #111 — `AttestorAlreadyAttested`
**Trigger:** An attestor attempted to attest a credential in `batch_attest` that they have already attested.

**Recovery:** Each attestor may attest a given credential only once per slice. Query existing attestation records before batching.

---

### #112 — `PostconditionViolated`
**Trigger:** An internal postcondition invariant failed after a state mutation. This indicates a contract bug.

**Recovery:** File a bug report. Do not retry; the transaction will have been reverted.

---

### #113 — `CredentialAttributesTooLarge`
**Trigger:** Setting a credential attribute would push the total serialized attribute size over 5 120 bytes.

**Recovery:** Remove unused attributes or reduce attribute value sizes before setting a new one.

---

### #114 — `AttestorNotResolvable`
**Trigger:** The attestor is neither a direct member of the slice nor a valid delegate of any member.

**Recovery:** Ensure the attestor is added to the slice or granted a delegation before attesting.

---

### #115 — `AttestorSuspended`
**Trigger:** An attestation was attempted by or for an attestor whose account is currently suspended.

**Recovery:** Lift the suspension before the attestor may participate in new attestations.

---

### #116 — `AttestationNotFound`
**Trigger:** A query for an attestation record returned no match for the supplied `(credential_id, attestor)` pair.

**Recovery:** Verify that the attestor has attested the credential using `get_attestors`.

---

### #117 — `InvalidAtomicPhase`
**Trigger:** `advance_atomic_phase` or `record_atomic_phase_result` was called with a phase discriminant outside the valid range (1–4 or 1–3 respectively).

**Recovery:** Use only the values 1 (`Phase1_QuorumProof`), 2 (`Phase2_SbtRegistry`), or 3 (`Phase3_ZkVerifier`).

---

### #118 — `InvalidDerivativeType`
**Trigger:** `create_credential_derivative` was called with a type discriminant other than 0 (Call), 1 (Put), or 2 (Future).

**Recovery:** Pass a valid derivative type value.

---

### #119 — `DerivativeNotFound`
**Trigger:** `exercise_credential_derivative` was called with a derivative ID that does not exist.

**Recovery:** Verify the derivative ID returned from `create_credential_derivative`.

---

### #120 — `StakeNotFound`
**Trigger:** `liquidate_credential_stake` was called with a stake ID that does not exist.

**Recovery:** Verify the stake ID returned from the staking entry point.

---

### #121 — `SubjectMismatch`
**Trigger:** `merge_credentials` was called with credential IDs that belong to different subjects.

**Recovery:** Only credentials held by the same subject can be merged.

---

### #122 — `CredentialNotFoundLocal`
**Trigger:** A cross-chain wrap or fractional-transfer operation referenced a credential ID that does not exist in the local contract storage.

**Recovery:** Verify the credential ID against `get_credential` before wrapping or fractionalizing.

---

### #123 — `IssuerOnlyAction`
**Trigger:** `enable_fractional_transfer` was called by an address other than the credential's issuer.

**Recovery:** Only the original issuer may enable fractional transfer on a credential.

---

### #124 — `NotFractionalized`
**Trigger:** `transfer_credential_fraction` was called on a credential that has not been fractionalized.

**Recovery:** Call `enable_fractional_transfer` first.

---

### #125 — `BranchNotFound`
**Trigger:** `commit_to_branch` or `merge_credential_branches` was called with a branch ID that does not exist.

**Recovery:** Verify the branch ID returned from `create_credential_branch`.

---

### #126 — `BranchCredentialMismatch`
**Trigger:** `merge_credential_branches` was called with branches that belong to different credentials.

**Recovery:** Only branches of the same credential can be merged.

---

### #127 — `NoMigrationForVersion`
**Trigger:** The generic migration dispatcher encountered a source schema version that has no migration arm defined.

**Recovery:** This version transition is unsupported. Consult the upgrade guide for the supported migration path.

---

## See Also

- [Architecture Overview](architecture.md)
- [Threat Model & Security](threat-model.md)
- [Trust Slice Model](quorum-slice-guide.md)
