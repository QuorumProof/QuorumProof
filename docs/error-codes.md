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

## See Also

- [Architecture Overview](architecture.md)
- [Threat Model & Security](threat-model.md)
- [Trust Slice Model](trust-slices.md)
