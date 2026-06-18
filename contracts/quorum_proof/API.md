# QuorumProof Contract — API Reference

QuorumProof is a Soroban smart contract that implements a **Federated Byzantine Agreement (FBA)**
credential system on Stellar. Issuers mint verifiable credentials, quorum slices of weighted
attestors endorse them, and ZK proofs allow privacy-preserving verification.

---

## Table of Contents

1. [Contract Lifecycle](#1-contract-lifecycle)
2. [Rate Limiting](#2-rate-limiting)
3. [Proof of Work](#3-proof-of-work)
4. [Credentials](#4-credentials)
5. [Credential Metadata](#5-credential-metadata)
6. [Credential Transfers](#6-credential-transfers)
7. [Credential Revocation](#7-credential-revocation)
8. [Quorum Slices](#8-quorum-slices)
9. [Attestations](#9-attestations)
10. [ZK Verification](#10-zk-verification)
11. [Blacklist](#11-blacklist)
12. [Whitelist](#12-whitelist)
13. [Credential Types](#13-credential-types)
14. [Recovery](#14-recovery)
15. [Reputation & Activity](#15-reputation--activity)
16. [Governance — Disputes & Challenges](#16-governance--disputes--challenges)
17. [Delegation](#17-delegation)
18. [Consent Requests](#18-consent-requests)
19. [State Migration](#19-state-migration)
20. [Error Reference](#20-error-reference)

---

## 1. Contract Lifecycle

### `initialize(env, admin)`

Sets the admin address once after deployment. Panics if already initialized.

| Parameter | Type      | Description                        |
|-----------|-----------|------------------------------------|
| `admin`   | `Address` | The address that will own the contract. |

**Panics:** `"already initialized"` if called more than once.

**Example:**
```rust
client.initialize(&admin_address);
```

---

### `pause(env, admin)`

Halts all state-mutating operations. Only the admin may call this.

| Parameter | Type      | Description              |
|-----------|-----------|--------------------------|
| `admin`   | `Address` | Must match stored admin. |

**Panics:** `"unauthorized"` if `admin` does not match the stored admin.

---

### `unpause(env, admin)`

Re-enables all operations after a pause. Only the admin may call this.

| Parameter | Type      | Description              |
|-----------|-----------|--------------------------|
| `admin`   | `Address` | Must match stored admin. |

---

### `is_paused(env) → bool`

Returns `true` if the contract is currently paused.

**Example:**
```rust
let paused: bool = client.is_paused();
```

---

## 2. Rate Limiting

All write operations are subject to per-address rate limiting. The default limit is
**100 calls per hour**. The admin can reconfigure this at any time.

### `set_rate_limit_config(env, admin, max_calls, window_seconds)`

Configures the global rate limit. Admin only.

| Parameter        | Type      | Description                                      |
|------------------|-----------|--------------------------------------------------|
| `admin`          | `Address` | Must match stored admin.                         |
| `max_calls`      | `u32`     | Maximum calls allowed per window. Must be > 0.  |
| `window_seconds` | `u64`     | Duration of the rate-limit window in seconds.   |

**Panics:** `"max_calls must be greater than 0"` or `"window_seconds must be greater than 0"`.

---

### `get_rate_limit_config_pub(env) → RateLimitConfig`

Returns the current rate limit configuration.

**Returns:** `RateLimitConfig { max_calls: u32, window_seconds: u64 }`

---

### `get_rate_limit_state(env, address) → Option<RateLimitState>`

Returns the current rate limit tracking state for an address, or `None` if the address
has not made any calls yet.

| Parameter | Type      | Description              |
|-----------|-----------|--------------------------|
| `address` | `Address` | The address to inspect.  |

**Returns:** `Option<RateLimitState { call_count: u32, window_start: u64 }>`

---

## 3. Proof of Work

The contract optionally requires a Proof-of-Work (PoW) nonce on credential issuance to
rate-limit spam at the protocol level. Difficulty `0` (default) disables PoW entirely.

### `set_pow_difficulty(env, admin, difficulty)`

Sets the number of leading zero bits required in the SHA-256 hash of the issuance inputs.
Admin only. Set to `0` to disable.

| Parameter    | Type      | Description                                          |
|--------------|-----------|------------------------------------------------------|
| `admin`      | `Address` | Must match stored admin.                             |
| `difficulty` | `u32`     | Number of leading zero bits required (0 = disabled). |

---

### `get_pow_difficulty(env) → u32`

Returns the current PoW difficulty setting. Returns `0` if not configured.

**Example:**
```rust
let difficulty: u32 = client.get_pow_difficulty();
```

---

## 4. Credentials

### `issue_credential(env, issuer, subject, credential_type, metadata_hash, expires_at, nonce) → u64`

Issues a new credential to a subject. Returns the new credential ID (monotonically increasing).

| Parameter         | Type             | Description                                                                 |
|-------------------|------------------|-----------------------------------------------------------------------------|
| `issuer`          | `Address`        | The issuing party; must authorize this call.                                |
| `subject`         | `Address`        | The credential holder.                                                      |
| `credential_type` | `u32`            | Numeric type identifier. Must be > 0.                                       |
| `metadata_hash`   | `Bytes`          | Non-empty content-addressed hash (IPFS CID or similar). Max 256 bytes.     |
| `expires_at`      | `Option<u64>`    | Optional Unix timestamp after which the credential is considered expired.   |
| `nonce`           | `u64`            | PoW nonce. Pass `0` when PoW difficulty is disabled.                        |

**Panics:**
- Contract is paused
- `metadata_hash` is empty or exceeds 256 bytes
- `credential_type` is 0
- Duplicate credential (same issuer + subject + type already exists)
- Subject is blacklisted by issuer
- Rate limit exceeded
- PoW nonce is invalid (when difficulty > 0)

**Emits:** `CredentialIssued` event with `{ id, subject, credential_type }`.

**Example:**
```rust
let metadata_hash = Bytes::from_array(&env, &[1u8; 32]);
let cred_id = client.issue_credential(
    &issuer,
    &subject,
    &1u32,
    &metadata_hash,
    &None,   // no expiry
    &0u64,   // no PoW
);
```

---

### `batch_issue_credentials(env, issuer, subjects, credential_types, metadata_hashes, expires_at) → Vec<u64>`

Issues credentials to multiple subjects in one call. All three input vectors must have the
same length. Returns credential IDs in the same order as the input subjects.

| Parameter          | Type             | Description                                                  |
|--------------------|------------------|--------------------------------------------------------------|
| `issuer`           | `Address`        | The issuing party; must authorize this call.                 |
| `subjects`         | `Vec<Address>`   | Ordered list of recipient addresses.                         |
| `credential_types` | `Vec<u32>`       | Ordered list of credential type IDs, one per subject.        |
| `metadata_hashes`  | `Vec<Bytes>`     | Ordered list of metadata hashes, one per subject.            |
| `expires_at`       | `Option<u64>`    | Shared optional expiry applied to all credentials.           |

**Panics:** Input lengths mismatch, any individual credential violates duplicate/empty-hash rules,
or batch size exceeds 50.

---

### `issue_batch(env, issuer, credentials) → BatchResult`

Atomically validates and issues a batch of credentials. Unlike `batch_issue_credentials`,
this function validates **all** entries before writing any to storage. If any entry fails
validation, no credentials are issued and a `BatchError` is returned.

| Parameter     | Type                    | Description                                          |
|---------------|-------------------------|------------------------------------------------------|
| `issuer`      | `Address`               | The issuing party; must authorize this call.         |
| `credentials` | `Vec<CredentialInput>`  | Batch of credential inputs to issue.                 |

**`CredentialInput` fields:**

| Field             | Type          | Description                                      |
|-------------------|---------------|--------------------------------------------------|
| `subject`         | `Address`     | The credential holder.                           |
| `credential_type` | `u32`         | Numeric type identifier. Must be > 0.            |
| `metadata_hash`   | `Bytes`       | Non-empty content-addressed hash. Max 256 bytes. |
| `expires_at`      | `Option<u64>` | Optional expiry timestamp.                       |

**Returns:**
- `BatchResult::Ok(Vec<u64>)` — IDs of all issued credentials in input order.
- `BatchResult::Err(BatchError { failing_index: u32, reason: String })` — first validation failure.

**Example:**
```rust
let inputs = vec![&env,
    CredentialInput { subject: alice, credential_type: 1, metadata_hash: hash.clone(), expires_at: None },
    CredentialInput { subject: bob,   credential_type: 2, metadata_hash: hash.clone(), expires_at: None },
];
match client.issue_batch(&issuer, &inputs) {
    BatchResult::Ok(ids) => { /* use ids */ }
    BatchResult::Err(e)  => { /* handle e.failing_index, e.reason */ }
}
```

---

### `get_credential(env, credential_id) → Credential`

Retrieves a credential by ID.

| Parameter       | Type  | Description                  |
|-----------------|-------|------------------------------|
| `credential_id` | `u64` | The credential ID to fetch.  |

**Returns:** `Credential { id, subject, issuer, credential_type, metadata_hash, revoked, suspended, expires_at, version }`

**Panics:** `ContractError::CredentialNotFound` if no credential exists with that ID.
Also panics with `"credential has expired"` if `expires_at` has passed.

---

### `credential_exists(env, credential_id) → bool`

Returns `true` if a credential with the given ID exists in storage (including revoked ones).

---

### `get_credential_count(env) → u64`

Returns the total number of credentials ever issued on this contract.

---

### `get_credentials_by_subject(env, subject) → Vec<u64>`

Returns all active (non-revoked) credential IDs held by a subject.

| Parameter | Type      | Description                    |
|-----------|-----------|--------------------------------|
| `subject` | `Address` | The holder address to query.   |

---

### `get_credentials_by_type(env, credential_type) → Vec<u64>`

Returns all credential IDs of a given type (including active and revoked).

---

### `renew_credential(env, issuer, credential_id, new_expires_at)`

Extends the expiry of a credential. Only the original issuer may call this.

| Parameter        | Type      | Description                                          |
|------------------|-----------|------------------------------------------------------|
| `issuer`         | `Address` | Must be the original issuer; must authorize.         |
| `credential_id`  | `u64`     | The credential to renew.                             |
| `new_expires_at` | `u64`     | New Unix timestamp; must be in the future.           |

**Panics:** Credential not found, caller is not issuer, credential is revoked or suspended,
`new_expires_at` is not in the future.

**Emits:** `CredentialRenewed` event.

---

### `suspend_credential(env, issuer, credential_id)`

Temporarily suspends a credential. Suspended credentials fail `is_attested` checks.
Only the original issuer may call this.

---

### `resume_credential(env, issuer, credential_id)`

Lifts a suspension on a credential. Only the original issuer may call this.

---

### `is_revoked(env, credential_id) → bool`

Returns `true` if the credential has been revoked.

---

### `is_suspended(env, credential_id) → bool`

Returns `true` if the credential is currently suspended.

---

## 5. Credential Metadata

### `update_metadata(env, issuer, credential_id, new_metadata_hash)`

Replaces the metadata hash on a credential and increments its version counter.
Only the original issuer may call this.

| Parameter          | Type      | Description                                      |
|--------------------|-----------|--------------------------------------------------|
| `issuer`           | `Address` | Must be the original issuer; must authorize.     |
| `credential_id`    | `u64`     | The credential to update.                        |
| `new_metadata_hash`| `Bytes`   | New non-empty content-addressed hash.            |

**Panics:** Credential not found, caller is not issuer.

---

### `set_credential_metadata(env, issuer, credential_id, metadata)`

Stores arbitrary compressed metadata bytes on-chain for a credential.
Only the original issuer may call this.

| Parameter       | Type               | Description                                      |
|-----------------|--------------------|--------------------------------------------------|
| `issuer`        | `Address`          | Must be the original issuer; must authorize.     |
| `credential_id` | `u64`              | The credential to attach metadata to.            |
| `metadata`      | `CredentialMetadata` | `{ data: Bytes, compression: CompressionType }` |

---

### `get_credential_metadata(env, credential_id) → Option<CredentialMetadata>`

Returns the stored metadata for a credential, or `None` if none has been set.

---

### `validate_metadata_hash(env, credential_id, metadata_hash) → bool`

Checks whether `metadata_hash` matches the hash stored on the credential.
Results are cached for ~1 hour to reduce repeated storage reads.

| Parameter       | Type    | Description                          |
|-----------------|---------|--------------------------------------|
| `credential_id` | `u64`   | The credential to validate against.  |
| `metadata_hash` | `Bytes` | The hash to compare.                 |

---

### `set_encrypted_metadata(env, issuer, credential_id, ciphertext, encrypted_keys)`

Stores AES-256 encrypted credential metadata on-chain. Encryption and decryption are
performed off-chain; this contract only persists the ciphertext and per-party encrypted
data keys.

| Parameter        | Type                    | Description                                              |
|------------------|-------------------------|----------------------------------------------------------|
| `issuer`         | `Address`               | Must be the original issuer; must authorize.             |
| `credential_id`  | `u64`                   | The credential to attach encrypted metadata to.          |
| `ciphertext`     | `Bytes`                 | AES-256 ciphertext produced off-chain.                   |
| `encrypted_keys` | `Map<Address, Bytes>`   | Per-party data keys encrypted under each party's pubkey. |

---

### `grant_decryption_access(env, issuer, credential_id, party, encrypted_key)`

Grants an authorized party access to decrypt credential metadata by storing their
encrypted data key.

| Parameter       | Type      | Description                                          |
|-----------------|-----------|------------------------------------------------------|
| `issuer`        | `Address` | Must be the original issuer; must authorize.         |
| `credential_id` | `u64`     | The credential to grant access to.                   |
| `party`         | `Address` | The party being granted access.                      |
| `encrypted_key` | `Bytes`   | The data key encrypted under the party's public key. |

---

### `revoke_decryption_access(env, issuer, credential_id, party)`

Removes a party's encrypted data key, revoking their ability to decrypt the metadata.

---

### `get_encrypted_metadata(env, credential_id) → Option<EncryptedCredentialMetadata>`

Returns the encrypted metadata record for a credential, or `None` if not set.

---

### `get_credential_version(env, credential_id, version) → CredentialVersion`

Returns a specific version from the credential's metadata history.

| Parameter       | Type  | Description                          |
|-----------------|-------|--------------------------------------|
| `credential_id` | `u64` | The credential to query.             |
| `version`       | `u32` | The version number to retrieve.      |

**Panics:** `ContractError::CredentialVersionNotFound` if the version does not exist.

---

### `get_version_at(env, credential_id, timestamp) → CredentialVersion`

Returns the metadata version whose `updated_at` is closest to and not after `timestamp`.
Useful for point-in-time audits.

---

### `get_credential_version_history(env, credential_id) → Vec<CredentialVersion>`

Returns the full metadata version history for a credential in chronological order.

---
## 6. Credential Transfers

Credentials can be transferred between subjects via a two-step consent flow. The current
subject initiates the transfer; the recipient must explicitly accept it.

### `set_transfer_restriction(env, admin, credential_type, is_transferable)`

Configures whether credentials of a given type are transferable. Admin only.
By default all credential types are transferable.

| Parameter         | Type      | Description                                          |
|-------------------|-----------|------------------------------------------------------|
| `admin`           | `Address` | Must match stored admin.                             |
| `credential_type` | `u32`     | The credential type to configure.                    |
| `is_transferable` | `bool`    | `true` to allow transfers, `false` to block them.    |

---

### `get_transfer_restriction(env, credential_type) → Option<TransferRestriction>`

Returns the transfer restriction record for a credential type, or `None` if not configured.

**Returns:** `Option<TransferRestriction { credential_type, is_transferable, configured_at }>`

---

### `initiate_transfer(env, from, credential_id, to)`

Creates a pending transfer request. The current subject (`from`) initiates the transfer
to a new recipient (`to`). The recipient must call `accept_transfer` to complete it.

| Parameter       | Type      | Description                                                  |
|-----------------|-----------|--------------------------------------------------------------|
| `from`          | `Address` | Current credential subject; must authorize this call.        |
| `credential_id` | `u64`     | The credential to transfer.                                  |
| `to`            | `Address` | The intended new subject.                                    |

**Panics:**
- Credential not found
- Caller is not the current subject (`ContractError::UnauthorizedTransfer`)
- Credential type is not transferable (`ContractError::TransferNotAllowed`)

---

### `accept_transfer(env, to, credential_id)`

Completes a pending transfer. The intended recipient accepts and becomes the new subject.

| Parameter       | Type      | Description                                                  |
|-----------------|-----------|--------------------------------------------------------------|
| `to`            | `Address` | The recipient; must authorize this call.                     |
| `credential_id` | `u64`     | The credential being transferred.                            |

**Panics:**
- No pending transfer request exists (`ContractError::UnauthorizedTransfer`)
- Caller is not the intended recipient

**Emits:** `SbtTransferred` event.

---

## 7. Credential Revocation

There are four revocation paths: issuer registry requests with a time-lock, legacy immediate
issuer revocation, holder-initiated consent withdrawal, and a holder-request workflow where the
issuer approves or denies.

### Issuer Revocation Registry Workflow

The registry path is recommended for issuer operational revocations. Requests are reversible
during the configured time-lock window and become effective only after finalization.

State transition:

```text
pending -> finalized -> active
```

The default time-lock is **48 hours**. Admins may configure a different default with
`set_revocation_time_lock`. Callers may provide a per-request lock with
`initiate_revocation_with_lock` or `batch_initiate_revocations`; passing `0` uses the default.

Only the original credential issuer or an issuer-delegated revocation agent may initiate,
cancel, or finalize registry revocations. Emergency fast-track revocation bypasses the time-lock
and is admin-only.

### `set_revocation_time_lock(env, admin, seconds)`

Configures the default registry time-lock in seconds. Admin only.

### `get_revocation_time_lock(env) -> u64`

Returns the configured registry time-lock, or `172800` when unset.

### `add_revocation_agent(env, issuer, agent)`

Delegates revocation authority from an issuer to an operational agent.

### `remove_revocation_agent(env, issuer, agent)`

Removes delegated revocation authority for an agent.

### `is_revocation_agent(env, issuer, agent) -> bool`

Returns whether `agent` currently has issuer-delegated revocation authority.

### `get_revocation_agents(env, issuer) -> Vec<Address>`

Lists delegated revocation agents for an issuer.

### `initiate_revocation(env, actor, credential_id, reason) -> u64`

Creates a pending issuer-side revocation request using the default time-lock.

| Parameter       | Type      | Description                                         |
|-----------------|-----------|-----------------------------------------------------|
| `actor`         | `Address` | Credential issuer or delegated revocation agent.    |
| `credential_id` | `u64`     | Credential to revoke after the time-lock expires.   |
| `reason`        | `String`  | Immutable reason stored in the request audit trail. |

### `initiate_revocation_with_lock(env, actor, credential_id, reason, time_lock_seconds) -> u64`

Creates a pending issuer-side revocation request with a custom time-lock. A value of `0`
uses the configured default.

### `batch_initiate_revocations(env, actor, requests, time_lock_seconds) -> Vec<u64>`

Creates up to **128** pending revocation requests in one authorized call.

`RevocationInput` fields:

| Field           | Type     | Description                         |
|-----------------|----------|-------------------------------------|
| `credential_id` | `u64`    | Credential to revoke.               |
| `reason`        | `String` | Reason attached to the audit trail. |

### `cancel_revocation_request(env, actor, request_id, reason)`

Cancels a pending revocation request before its `unlocks_at` timestamp. This is the reversible
time-lock action. Once the lock has expired or the request is active, cancellation is rejected.

### `finalize_revocation_request(env, actor, request_id) -> RevocationRequest`

Finalizes an expired pending request and activates the credential revocation. The audit trail
records both `Finalized` and `Activated` actions.

### `batch_finalize_revocations(env, actor, request_ids) -> u32`

Finalizes up to **128** expired revocation requests in one call. Returns the number finalized.

### `emergency_revoke_credential(env, admin, credential_id, reason) -> u64`

Admin-only fast-track revocation for active security incidents. Creates an active registry
request immediately and records an `EmergencyActivated` audit action.

### `get_revocation_registry_request(env, request_id) -> Option<RevocationRequest>`

Returns a registry request by ID.

**Returns:** `Option<RevocationRequest { id, credential_id, issuer, requested_by, timestamp, unlocks_at, reason, status, finalized_at, activated_at }>`

### `get_credential_revocation_registry_request(env, credential_id) -> Option<RevocationRequest>`

Returns the latest registry request associated with a credential, if any.

### `get_revocation_registry_audit(env, request_id) -> Vec<RegistryRevocationAuditEntry>`

Returns the immutable audit trail for a registry request.

### `get_revocation_metrics(env) -> RevocationMetrics`

Returns aggregate registry counters: request, finalized, active, cancelled, and emergency counts.

### `revoke_credential(env, issuer, credential_id)`

Immediately revokes a credential. Only the original issuer may call this.

| Parameter       | Type      | Description                                      |
|-----------------|-----------|--------------------------------------------------|
| `issuer`        | `Address` | Must be the original issuer; must authorize.     |
| `credential_id` | `u64`     | The credential to revoke.                        |

**Panics:** Credential not found, caller is not issuer, credential already revoked,
or credential has expired.

**Emits:** `RevokeCredential` event.

---

### `revoke_consent(env, holder, credential_id)`

Allows the credential holder to revoke their own credential (withdraw consent).

| Parameter       | Type      | Description                                      |
|-----------------|-----------|--------------------------------------------------|
| `holder`        | `Address` | The credential subject; must authorize.          |
| `credential_id` | `u64`     | The credential to revoke.                        |

**Panics:** Credential not found, caller is not the holder, credential already revoked.

**Emits:** `ConsentRevoked` event.

---

### `request_revocation(env, holder, credential_id)`

Holder submits a pending revocation request. The issuer then approves or denies it via
`approve_revocation` / `deny_revocation`.

| Parameter       | Type            | Description                                      |
|-----------------|-----------------|--------------------------------------------------|
| `holder`        | `Address`       | The credential subject; must authorize.          |
| `credential_id` | `CredentialId`  | The credential for which revocation is requested.|

**Panics:** Credential not found, caller is not the holder, credential already revoked,
or a pending request already exists.

---

### `approve_revocation(env, issuer, credential_id)`

Approves a pending holder revocation request and immediately revokes the credential.

| Parameter       | Type            | Description                                      |
|-----------------|-----------------|--------------------------------------------------|
| `issuer`        | `Address`       | Must be the original issuer; must authorize.     |
| `credential_id` | `CredentialId`  | The credential with a pending revocation request.|

**Panics:** `ContractError::RevocationRequestNotFound` or `ContractError::RevocationNotPending`.

---

### `deny_revocation(env, issuer, credential_id)`

Denies a pending holder revocation request. The credential remains active.

---

### `get_revocation_request(env, credential_id) → Option<HolderRevocationRequest>`

Returns the current pending revocation request for a credential, or `None`.

**Returns:** `Option<HolderRevocationRequest { credential_id, holder, requested_at, requested_ledger, status }>`

---

### `get_revocation_audit_trail(env, credential_id) → Vec<RevocationAuditEntry>`

Returns the full audit trail of revocation lifecycle events for a credential.

**Returns:** `Vec<RevocationAuditEntry { action, actor, timestamp, ledger_sequence, status }>`

---

## 8. Quorum Slices

A **QuorumSlice** is a named set of weighted attestors that collectively endorse credentials.
This implements the Stellar FBA model: trust is proportional to weight, not headcount.

### `create_slice(env, creator, attestors, weights, threshold) → u64`

Creates a new quorum slice. Returns the new slice ID.

| Parameter   | Type            | Description                                                                 |
|-------------|-----------------|-----------------------------------------------------------------------------|
| `creator`   | `Address`       | The slice owner; must authorize this call.                                  |
| `attestors` | `Vec<Address>`  | List of attestor addresses. Must be non-empty, max 20.                      |
| `weights`   | `Vec<u32>`      | Weight for each attestor (same length as `attestors`). Each must be > 0.   |
| `threshold` | `u32`           | Minimum total weight required for a credential to be considered attested.   |

**Threshold semantics:** The threshold is in **weight units**, not attestor count.
With weights `[50, 30, 20]` and threshold `50`:
- One attestor with weight 50 satisfies the threshold.
- Two attestors with weights 30 + 20 also satisfy it.
- One attestor with weight 30 alone does not.

**Panics:**
- `attestors` is empty or exceeds 20
- `weights` length does not match `attestors` length
- `threshold` is 0 or exceeds the total weight sum

**Example:**
```rust
let attestors = vec![&env, alice.clone(), bob.clone()];
let weights   = vec![&env, 60u32, 40u32];
let slice_id  = client.create_slice(&creator, &attestors, &weights, &60u32);
// alice alone (weight 60) can satisfy the threshold
```

---

### `get_slice(env, slice_id) → QuorumSlice`

Retrieves a quorum slice by ID.

**Returns:** `QuorumSlice { id, creator, attestors, weights, threshold }`

**Panics:** `ContractError::SliceNotFound` if no slice exists with that ID.

---

### `slice_exists(env, slice_id) → bool`

Returns `true` if a slice with the given ID exists in storage.

---

### `get_slice_count(env) → u64`

Returns the total number of quorum slices created on this contract.

---

### `get_slice_creator(env, slice_id) → Address`

Returns the creator address of a slice.

**Panics:** `ContractError::SliceNotFound`.

---

### `add_attestor(env, creator, slice_id, attestor, weight)`

Adds a new attestor with a given weight to an existing slice. Only the slice creator may call this.

| Parameter   | Type      | Description                                      |
|-------------|-----------|--------------------------------------------------|
| `creator`   | `Address` | Must be the slice creator; must authorize.       |
| `slice_id`  | `u64`     | The slice to modify.                             |
| `attestor`  | `Address` | The new attestor address.                        |
| `weight`    | `u32`     | The attestor's weight. Must be > 0.              |

**Panics:** Slice not found, caller is not creator, slice already at max (20) attestors,
attestor already in slice (`ContractError::DuplicateAttestor`).

---

### `remove_attestor(env, creator, slice_id, attestor)`

Removes an attestor from a slice. If removal would make the threshold unreachable,
the threshold is automatically clamped to the new total weight. Only the slice creator may call this.

**Panics:** Slice not found, caller is not creator, attestor not in slice,
or removing the last attestor.

---

### `update_slice_threshold(env, creator, slice_id, new_threshold)`

Updates the quorum threshold for a slice. Only the slice creator may call this.

| Parameter       | Type      | Description                                              |
|-----------------|-----------|----------------------------------------------------------|
| `creator`       | `Address` | Must be the slice creator; must authorize.               |
| `slice_id`      | `u64`     | The slice to update.                                     |
| `new_threshold` | `u32`     | New threshold in weight units. Must be > 0 and ≤ total weight. |

**Emits:** `ThresholdChanged` event. Appends an entry to the threshold audit log.

---

### `get_slice_threshold_audit(env, slice_id) → Vec<ThresholdAuditEntry>`

Returns the full audit log of threshold changes for a slice in chronological order.

**Returns:** `Vec<ThresholdAuditEntry { slice_id, old_threshold, new_threshold, changed_by, timestamp }>`

---

### `suspend_attestor(env, creator, slice_id, attestor)`

Suspends an attestor within a slice. Suspended attestors cannot attest and their existing
weight is excluded from quorum calculations. Only the slice creator may call this.

---

### `resume_attestor(env, creator, slice_id, attestor)`

Lifts a suspension on an attestor within a slice. Only the slice creator may call this.

---

### `is_attestor_suspended(env, slice_id, attestor) → bool`

Returns `true` if the attestor is currently suspended in the given slice.

---

## 9. Attestations

### `attest(env, attestor, credential_id, slice_id, attestation_value, expires_at)`

Records an attestation for a credential by a slice member.

| Parameter           | Type          | Description                                                          |
|---------------------|---------------|----------------------------------------------------------------------|
| `attestor`          | `Address`     | Must be a member of the slice; must authorize this call.             |
| `credential_id`     | `u64`         | The credential being attested.                                       |
| `slice_id`          | `u64`         | The quorum slice the attestor belongs to.                            |
| `attestation_value` | `bool`        | `true` = valid attestation, `false` = invalid/negative attestation.  |
| `expires_at`        | `Option<u64>` | Optional Unix timestamp after which this attestation expires.        |

**Panics:**
- Contract is paused
- Credential not found or revoked
- Attestor is not a member of the slice (`ContractError::NotInSlice`)
- Attestor has already attested this credential (`ContractError::DuplicateAttestor`)
- Attestor is suspended in the slice
- Attestation window is configured and current time is outside it (`ContractError::AttestationWindowOutside`)

**Emits:** `attestation` event with `{ attestor, credential_id, slice_id }`.

**Example:**
```rust
client.attest(&attestor, &cred_id, &slice_id, &true, &None);
```

---

### `is_attested(env, credential_id, slice_id) → bool`

Returns `true` if the total weight of valid attestors meets or exceeds the slice threshold.

Also returns `false` if the credential is revoked, suspended, expired, or if the
condition-based attestation expiry has passed. Results are cached for 60 seconds.

| Parameter       | Type  | Description                          |
|-----------------|-------|--------------------------------------|
| `credential_id` | `u64` | The credential to check.             |
| `slice_id`      | `u64` | The quorum slice to evaluate against.|

**Panics:** `ContractError::CredentialNotFound` if the credential does not exist.

---

### `get_attestors(env, credential_id) → Vec<Address>`

Returns the addresses of all attestors that have signed a credential.

---

### `get_attestation_records(env, credential_id) → Vec<AttestationRecord>`

Returns full attestation records including expiry and attestation value.

**Returns:** `Vec<AttestationRecord { attestor, attested_at, expires_at, attestation_value, metadata }>`

---

### `get_attestation_count(env, credential_id) → u32`

Returns the number of attestations recorded for a credential.

---

### `get_slice_attestation_status(env, credential_id, slice_id) → Vec<(Address, bool)>`

Returns the attestation status of each attestor in a slice for a given credential.
Useful for progress tracking (e.g. "2 of 3 attestors have signed").

**Returns:** `Vec<(Address, bool)>` — one entry per slice attestor; `bool` is `true` if signed.

---

### `verify_attestations_batch(env, credential_ids, slice_ids) → Vec<bool>`

Checks multiple (credential, slice) pairs in a single call. Gas-optimized: each credential
and slice is read from storage at most once.

| Parameter        | Type        | Description                                                  |
|------------------|-------------|--------------------------------------------------------------|
| `credential_ids` | `Vec<u64>`  | Ordered list of credential IDs. Max 50.                      |
| `slice_ids`      | `Vec<u64>`  | Ordered list of slice IDs, one per credential.               |

**Returns:** `Vec<bool>` — `results[i]` corresponds to `is_attested(credential_ids[i], slice_ids[i])`.

**Panics:** Lists have different lengths, or either list is empty or exceeds 50.

---

### `renew_attestation(env, attestor, credential_id, new_expires_at)`

Extends the expiry of an existing attestation. Only the original attestor may call this.

| Parameter        | Type      | Description                                      |
|------------------|-----------|--------------------------------------------------|
| `attestor`       | `Address` | Must be the original attestor; must authorize.   |
| `credential_id`  | `u64`     | The credential whose attestation to renew.       |
| `new_expires_at` | `u64`     | New Unix timestamp; must be in the future.       |

**Emits:** `AttestationRenewed` event.

---

### `is_single_attestation_expired(env, credential_id, attestor) → bool`

Returns `true` if the specific attestor's attestation on a credential has expired.
Returns `false` if the attestation has no expiry or has not yet expired.

**Panics:** Credential not found, or attestor has not attested this credential.

---

### `set_attestation_expiry(env, issuer, credential_id, expires_at)`

Sets a condition-based expiry timestamp for all attestations on a credential.
After this timestamp, `is_attestation_expired` returns `true` and `is_attested` treats
the credential as not attested. Only the credential issuer may call this.

| Parameter       | Type      | Description                                      |
|-----------------|-----------|--------------------------------------------------|
| `issuer`        | `Address` | Must be the original issuer; must authorize.     |
| `credential_id` | `u64`     | The credential to configure.                     |
| `expires_at`    | `u64`     | Unix timestamp; must be in the future.           |

---

### `is_attestation_expired(env, credential_id) → bool`

Returns `true` if a condition-based attestation expiry has been set and the current
ledger timestamp has passed it. Returns `false` if no expiry is configured.

---

### `set_attestation_window(env, issuer, credential_id, start, end)`

Configures a time window during which attestations are allowed for a credential.
Attestation attempts outside this window are rejected. Only the issuer may call this.

| Parameter       | Type      | Description                                      |
|-----------------|-----------|--------------------------------------------------|
| `issuer`        | `Address` | Must be the original issuer; must authorize.     |
| `credential_id` | `u64`     | The credential to configure.                     |
| `start`         | `u64`     | Unix timestamp when the window opens.            |
| `end`           | `u64`     | Unix timestamp when the window closes. Must be > `start`. |

---

### `get_attestation_window(env, credential_id) → Option<AttestationTimeWindow>`

Returns the configured attestation time window, or `None` if not set.

**Returns:** `Option<AttestationTimeWindow { start: u64, end: u64 }>`

---

### `get_attestor_reputation(env, attestor) → u64`

Returns the total number of credentials an attestor has signed across all credentials.

---

## 10. ZK Verification

### `verify_engineer(env, sbt_registry_id, zk_verifier_id, zk_admin, subject, credential_id, claim_type, proof, verifier) → bool`

Unified verification entry point. Checks that the subject holds an SBT linked to the
credential, then delegates ZK claim verification to the `zk_verifier` contract.

| Parameter        | Type              | Description                                                                    |
|------------------|-------------------|--------------------------------------------------------------------------------|
| `sbt_registry_id`| `Address`         | Address of the deployed SBT registry contract.                                 |
| `zk_verifier_id` | `Address`         | Address of the deployed ZK verifier contract.                                  |
| `zk_admin`       | `Address`         | Admin address forwarded to the ZK verifier.                                    |
| `subject`        | `Address`         | The engineer whose credential is being verified.                               |
| `credential_id`  | `u64`             | The credential to verify.                                                      |
| `claim_type`     | `ClaimType`       | The specific claim to verify (`Degree`, `License`, `Employment`, `Age`, etc.). |
| `proof`          | `Bytes`           | The ZK proof bytes for the claim.                                              |
| `verifier`       | `Option<Address>` | Optional caller address. If `Some`, must be the subject or an active delegate. |

**Returns:** `false` if the subject has no matching SBT or the proof fails; does not panic.

---

### `verify_engineer_anonymous(env, zk_verifier_id, credential_id, claim_type, holder_commitment, proof) → bool`

Verifies a credential anonymously using a ZK proof and holder commitment, without
revealing the subject's public address on-chain.

| Parameter          | Type        | Description                                      |
|--------------------|-------------|--------------------------------------------------|
| `zk_verifier_id`   | `Address`   | Address of the deployed ZK verifier contract.    |
| `credential_id`    | `u64`       | The credential to verify.                        |
| `claim_type`       | `ClaimType` | The claim type to verify.                        |
| `holder_commitment`| `Bytes`     | Cryptographic commitment to the holder's identity.|
| `proof`            | `Bytes`     | The ZK proof bytes.                              |

---

### `verify_claim_batch(env, zk_verifier_id, zk_admin, quorum_proof_id, credential_id, claim_types, proofs) → Vec<bool>`

Verifies multiple ZK claims for a credential in a single call.

| Parameter        | Type                | Description                                                  |
|------------------|---------------------|--------------------------------------------------------------|
| `zk_verifier_id` | `Address`           | Address of the deployed ZK verifier contract.                |
| `zk_admin`       | `Address`           | Admin address forwarded to the ZK verifier.                  |
| `quorum_proof_id`| `Address`           | Address of this contract (forwarded to ZK verifier).         |
| `credential_id`  | `u64`               | The credential to verify claims against.                     |
| `claim_types`    | `Vec<ClaimType>`    | Ordered list of claim types to verify. Max 50.               |
| `proofs`         | `Vec<Bytes>`        | Ordered list of ZK proofs, one per claim type.               |

**Returns:** `Vec<bool>` — `results[i]` is `true` if `claim_types[i]` was verified successfully.

**Panics:** `claim_types` and `proofs` have different lengths.

---

### `is_claim_type_supported(env, claim_type) → bool`

Returns `true` if the given claim type is supported by this contract.

Supported types: `Degree`, `License`, `Employment`, `Age`, `Citizenship`, `Custom`.

---

### `get_supported_claim_types(env) → Vec<ClaimType>`

Returns the list of all supported ZK claim types (6 total).

---

### `validate_claim_types(env, claim_types) → bool`

Returns `true` if all claim types in the provided list are supported.

---

## 11. Blacklist

Issuers can blacklist holders to prevent them from receiving new credentials.

### `add_holder_to_blacklist(env, issuer, holder, reason)`

Adds a holder to an issuer's blacklist.

| Parameter | Type      | Description                                      |
|-----------|-----------|--------------------------------------------------|
| `issuer`  | `Address` | The issuer adding to blacklist; must authorize.  |
| `holder`  | `Address` | The holder address to blacklist.                 |
| `reason`  | `String`  | Reason for blacklisting (stored in the record).  |

**Panics:** Contract paused, `ContractError::AlreadyBlacklisted` if already on the list.

**Emits:** `HolderBlacklisted` event.

---

### `remove_holder_from_blacklist(env, issuer, holder)`

Removes a holder from an issuer's blacklist.

**Panics:** Contract paused, `ContractError::NotBlacklisted` if not on the list.

**Emits:** `HolderUnblacklisted` event.

---

### `is_holder_blacklisted(env, issuer, holder) → bool`

Returns `true` if the holder is currently blacklisted by the issuer.

---

### `get_blacklisted_by_issuer(env, issuer) → Vec<Address>`

Returns all holder addresses blacklisted by a given issuer.

---

### `get_blacklist_entries_for_holder(env, holder) → Vec<Address>`

Returns all issuer addresses that have blacklisted a given holder.

---

### `get_blacklist_entry(env, issuer, holder) → Option<BlacklistEntry>`

Returns the full blacklist record for an issuer-holder pair, or `None` if not blacklisted.

**Returns:** `Option<BlacklistEntry { issuer, holder, reason, blacklisted_at }>`

---

## 12. Whitelist

Issuers can maintain an explicit whitelist of approved holders.

### `add_holder_to_whitelist(env, issuer, holder)`

Adds a holder to an issuer's whitelist. Only the issuer may call this.

---

### `remove_holder_from_whitelist(env, issuer, holder)`

Removes a holder from an issuer's whitelist. Only the issuer may call this.

---

### `is_holder_whitelisted(env, issuer, holder) → bool`

Returns `true` if the holder is on the issuer's whitelist.

---

## 13. Credential Types

Credential types provide a human-readable registry with optional parent-child hierarchy
for inheritance and rule composition.

### `register_credential_type(env, admin, type_id, name, description, parent_type)`

Registers or overwrites a credential type definition. Admin only.

| Parameter     | Type            | Description                                                                  |
|---------------|-----------------|------------------------------------------------------------------------------|
| `admin`       | `Address`       | Must match stored admin.                                                     |
| `type_id`     | `u32`           | Numeric identifier for the type.                                             |
| `name`        | `String`        | Human-readable name (e.g. `"Mechanical Engineering Degree"`).                |
| `description` | `String`        | Longer description of what the credential type represents.                   |
| `parent_type` | `Option<u32>`   | Optional parent type ID for hierarchy. Enables inheritance.                  |

**Panics:**
- `ContractError::InvalidParentType` if `parent_type` is provided but not registered.
- `ContractError::CircularHierarchy` if setting `parent_type` would create a cycle.

**Example:**
```rust
// Register a base type
client.register_credential_type(&admin, &1u32,
    &String::from_str(&env, "Engineering Degree"),
    &String::from_str(&env, "Any accredited engineering degree"),
    &None,
);
// Register a child type
client.register_credential_type(&admin, &2u32,
    &String::from_str(&env, "Mechanical Engineering Degree"),
    &String::from_str(&env, "Accredited mechanical engineering degree"),
    &Some(1u32),  // inherits from type 1
);
```

---

### `get_credential_type(env, type_id) → CredentialTypeDef`

Returns the definition for a registered credential type.

**Returns:** `CredentialTypeDef { type_id, name, description, parent_type }`

**Panics:** `ContractError::CredentialTypeNotFound` if not registered.

---

### `get_credential_type_children(env, type_id) → Vec<u32>`

Returns the direct child type IDs of a given credential type.

---

### `search_credentials(env, subject, issuer, credential_type, revoked, suspended, page, page_size) → Vec<u64>`

Searches credentials with optional filters and pagination.

| Parameter         | Type              | Description                                              |
|-------------------|-------------------|----------------------------------------------------------|
| `subject`         | `Option<Address>` | Filter by holder address.                                |
| `issuer`          | `Option<Address>` | Filter by issuer address.                                |
| `credential_type` | `Option<u32>`     | Filter by credential type.                               |
| `revoked`         | `Option<bool>`    | Filter by revocation status.                             |
| `suspended`       | `Option<bool>`    | Filter by suspension status.                             |
| `page`            | `u32`             | 1-based page number.                                     |
| `page_size`       | `u32`             | Number of results per page.                              |

**Returns:** `Vec<u64>` of matching credential IDs for the requested page.

**Example:**
```rust
// Get page 1 of subject's type-1 credentials, 10 per page
let ids = client.search_credentials(
    &Some(subject.clone()), &None, &Some(1u32), &None, &None, &1u32, &10u32,
);
```

---

### `count_credentials(env, subject, issuer, credential_type) → u64`

Returns the total count of credentials matching the given filters (no pagination).

---

## 14. Recovery

Credential recovery allows an issuer to transfer a credential to a new subject address
(e.g. after a key compromise) via a multi-approver workflow.

### `initiate_recovery(env, issuer, credential_id, new_subject, approvers, threshold) → u64`

Initiates a credential recovery request. Returns the recovery request ID.

| Parameter       | Type            | Description                                                        |
|-----------------|-----------------|--------------------------------------------------------------------|
| `issuer`        | `Address`       | Must be the original issuer; must authorize.                       |
| `credential_id` | `u64`           | The credential to recover.                                         |
| `new_subject`   | `Address`       | The new subject address after recovery.                            |
| `approvers`     | `Vec<Address>`  | Addresses that can approve the recovery.                           |
| `threshold`     | `u32`           | Number of approvals required to execute the recovery.              |

**Panics:** Credential not found, caller is not issuer, a pending recovery already exists
(`ContractError::RecoveryAlreadyExists`).

**Emits:** `RecoveryInitiated` event.

---

### `approve_recovery(env, approver, recovery_id)`

Approves a pending recovery request. Once the threshold is met, the recovery can be executed.

| Parameter     | Type      | Description                                          |
|---------------|-----------|------------------------------------------------------|
| `approver`    | `Address` | Must be in the recovery's approver list; must authorize. |
| `recovery_id` | `u64`     | The recovery request to approve.                     |

**Panics:** `ContractError::RecoveryNotFound`, `ContractError::RecoveryNotPending`,
`ContractError::NotRecoveryApprover`, `ContractError::DuplicateRecoveryApproval`.

**Emits:** `RecoveryApproved` event.

---

### `execute_recovery(env, issuer, recovery_id)`

Executes an approved recovery, transferring the credential to the new subject.
Requires the approval threshold to have been met.

| Parameter     | Type      | Description                                      |
|---------------|-----------|--------------------------------------------------|
| `issuer`      | `Address` | Must be the original issuer; must authorize.     |
| `recovery_id` | `u64`     | The recovery request to execute.                 |

**Panics:** `ContractError::RecoveryThresholdNotMet` if not enough approvals.

**Emits:** `RecoveryExecuted` event.

---

### `get_recovery_request(env, recovery_id) → RecoveryRequest`

Returns a recovery request by ID.

**Returns:** `RecoveryRequest { id, credential_id, issuer, new_subject, status, created_at, executed_at, approvers, threshold }`

---

### `initiate_reputation_recovery(env, attestor, slice_id)`

Initiates a reputation recovery process for a slice member (e.g. after a slashing event).

---

### `complete_reputation_recovery(env, admin, attestor)`

Completes a reputation recovery for an attestor. Admin only.

---

## 15. Reputation & Activity

### `get_holder_reputation(env, holder) → HolderReputation`

Returns the computed reputation score for a credential holder.

**Returns:** `HolderReputation { credentials_held, successful_verifications, attestation_count, attestation_age_seconds, score }`

The score is calculated as:
```
score = (attestation_count × attestation_weight)
      + (attestation_age_seconds / age_divisor_seconds × age_weight)
```

---

### `get_holder_activity(env, holder) → Vec<ActivityRecord>`

Returns the full activity history for a credential holder.

**Returns:** `Vec<ActivityRecord { activity_type, credential_id, timestamp, actor, slice_id }>`

Activity types: `CredentialIssued`, `CredentialRevoked`, `CredentialRenewed`,
`CredentialAttested`, `AttestationExpired`, `CredentialRecovered`.

---

### `get_verification_stats(env) → VerificationStats`

Returns aggregate verification statistics for the contract.

**Returns:** `VerificationStats { total_verifications, successful_verifications, failed_verifications }`

---

### `is_proof_expired(env, credential_id, proof_expires_at) → bool`

Returns `true` if the current ledger timestamp is at or past `proof_expires_at`.

| Parameter         | Type  | Description                                      |
|-------------------|-------|--------------------------------------------------|
| `credential_id`   | `u64` | The credential to check (must exist).            |
| `proof_expires_at`| `u64` | The proof expiry timestamp to evaluate against.  |

---

### `renew_proof(env, issuer, credential_id, new_expires_at) → u64`

Renews the proof expiry for a credential. Only the original issuer may call this.
Returns the new expiry timestamp.

---

### `batch_verify_proofs(env, credential_ids, slice_ids, proof_expires_at_list) → Vec<(u64, bool, bool)>`

Verifies multiple credentials in one call, checking both attestation status and proof expiry.

| Parameter              | Type        | Description                                                  |
|------------------------|-------------|--------------------------------------------------------------|
| `credential_ids`       | `Vec<u64>`  | Ordered list of credential IDs.                              |
| `slice_ids`            | `Vec<u64>`  | Ordered list of slice IDs, one per credential.               |
| `proof_expires_at_list`| `Vec<u64>`  | Ordered list of proof expiry timestamps, one per credential. |

**Returns:** `Vec<(credential_id: u64, is_valid: bool, is_expired: bool)>`

---

### `get_slice_consensus_history(env, slice_id) → Vec<ConsensusDecision>`

Returns the history of consensus decisions recorded for a slice.

**Returns:** `Vec<ConsensusDecision { decision_id, slice_id, credential_id, timestamp, required_weight_threshold, achieved_weight, total_weight }>`

---

### `send_slice_message(env, sender, slice_id, content, expires_at)`

Sends a message to all members of a quorum slice. Only slice members may send.

| Parameter   | Type      | Description                                      |
|-------------|-----------|--------------------------------------------------|
| `sender`    | `Address` | Must be a slice member; must authorize.          |
| `slice_id`  | `u64`     | The slice to send the message to.                |
| `content`   | `String`  | The message content.                             |
| `expires_at`| `u64`     | Unix timestamp after which the message expires.  |

---

### `get_slice_messages(env, slice_id) → Vec<SliceMessage>`

Returns all non-expired messages for a slice.

**Returns:** `Vec<SliceMessage { sender, content, sent_at, expires_at }>`

---

## 16. Governance — Disputes & Challenges

### `initiate_dispute(env, initiator, slice_id, accused, reason) → u64`

Opens a dispute between two slice members. Returns the dispute ID.

| Parameter   | Type      | Description                                      |
|-------------|-----------|--------------------------------------------------|
| `initiator` | `Address` | The member raising the dispute; must authorize.  |
| `slice_id`  | `u64`     | The slice in which the dispute occurs.           |
| `accused`   | `Address` | The member being accused.                        |
| `reason`    | `String`  | Description of the dispute.                      |

---

### `vote_on_dispute(env, voter, dispute_id, resolution)`

Casts a vote on an active dispute.

| Parameter    | Type      | Description                                                          |
|--------------|-----------|----------------------------------------------------------------------|
| `voter`      | `Address` | A slice member; must authorize. The accused cannot vote.             |
| `dispute_id` | `u64`     | The dispute to vote on.                                              |
| `resolution` | `u32`     | `1` = favor initiator, `2` = favor accused.                          |

**Panics:** `ContractError::AccusedCannotVote`, `ContractError::AlreadyVoted`.

---

### `resolve_dispute(env, admin, dispute_id)`

Resolves a dispute based on the current vote tally. Admin only.

---

### `get_dispute(env, dispute_id) → Dispute`

Returns a dispute by ID.

**Returns:** `Dispute { id, slice_id, initiator, accused, reason, status, created_at, votes }`

---

### `challenge_attestation(env, challenger, credential_id, slice_id, accused) → u64`

Opens a challenge against a specific attestor's attestation. Returns the challenge ID.

| Parameter       | Type      | Description                                      |
|-----------------|-----------|--------------------------------------------------|
| `challenger`    | `Address` | The member raising the challenge; must authorize.|
| `credential_id` | `u64`     | The credential whose attestation is challenged.  |
| `slice_id`      | `u64`     | The slice containing the accused attestor.       |
| `accused`       | `Address` | The attestor being challenged.                   |

**Panics:** `ContractError::AlreadyChallenged` if a challenge already exists for this pair.

---

### `vote_on_challenge(env, voter, challenge_id, uphold)`

Casts a vote on an open challenge.

| Parameter      | Type      | Description                                          |
|----------------|-----------|------------------------------------------------------|
| `voter`        | `Address` | A slice member; must authorize.                      |
| `challenge_id` | `u64`     | The challenge to vote on.                            |
| `uphold`       | `bool`    | `true` to uphold the challenge, `false` to dismiss.  |

**Panics:** `ContractError::AlreadyVoted`.

---

### `resolve_challenge(env, admin, challenge_id)`

Resolves a challenge based on the current vote tally. Admin only.

---

### `get_challenge(env, challenge_id) → Challenge`

Returns a challenge by ID.

**Returns:** `Challenge { id, credential_id, slice_id, accused, challenger, status, uphold_votes, dismiss_votes }`

---

### `detect_fork(env, credential_id, slice_id) → bool`

Checks whether conflicting attestations (a fork) exist for a credential in a slice.
Returns `true` if a fork is detected.

---

### `resolve_fork(env, admin, credential_id, slice_id, resolution)`

Resolves a detected fork. Admin only.

| Parameter       | Type      | Description                                      |
|-----------------|-----------|--------------------------------------------------|
| `admin`         | `Address` | Must match stored admin.                         |
| `credential_id` | `u64`     | The credential with the fork.                    |
| `slice_id`      | `u64`     | The slice where the fork was detected.           |
| `resolution`    | `String`  | Description of how the fork was resolved.        |

**Emits:** `ForkResolved` event.

---

### `get_fork_info(env, credential_id, slice_id) → Option<ForkInfo>`

Returns fork information for a credential-slice pair, or `None` if no fork exists.

**Returns:** `Option<ForkInfo { credential_id, slice_id, conflicting_attestors, attested_values, detected_at }>`

---

## 17. Delegation

Delegation allows a credential holder to authorize a third party to verify their credential
on their behalf, without transferring ownership.

### `grant_delegation(env, holder, credential_id, delegate, expiry)`

Grants a delegate the ability to verify a credential on behalf of the holder.

| Parameter       | Type      | Description                                          |
|-----------------|-----------|------------------------------------------------------|
| `holder`        | `Address` | The credential subject; must authorize.              |
| `credential_id` | `u64`     | The credential to delegate verification for.         |
| `delegate`      | `Address` | The address being granted delegation.                |
| `expiry`        | `u64`     | Unix timestamp until which the delegation is valid.  |

**Emits:** `DelegationGranted` event.

**Example:**
```rust
// Allow `verifier` to verify credential 1 on behalf of `holder` until timestamp 9999
client.grant_delegation(&holder, &1u64, &verifier, &9999u64);
```

---

### `revoke_delegation(env, holder, credential_id, delegate)`

Revokes a previously granted delegation.

| Parameter       | Type      | Description                                      |
|-----------------|-----------|--------------------------------------------------|
| `holder`        | `Address` | The credential subject; must authorize.          |
| `credential_id` | `u64`     | The credential whose delegation to revoke.       |
| `delegate`      | `Address` | The delegate whose access is being revoked.      |

---

### `get_delegation(env, credential_id, delegate) → Option<Delegation>`

Returns the delegation record for a credential-delegate pair, or `None` if not delegated.

**Returns:** `Option<Delegation { delegate, credential_id, expiry, granted_at }>`

---

### `get_delegation_audit_log(env, credential_id) → Vec<DelegationAuditEntry>`

Returns the full audit log of delegation grants for a credential.

**Returns:** `Vec<DelegationAuditEntry { delegate, credential_id, expiry, granted_at }>`

---

## 18. Consent Requests

Consent requests allow an issuer to request a subject's explicit approval before issuing
a credential. Requests expire after 7 days if not approved.

### `request_consent(env, issuer, subject, credential_type, metadata_hash) → u64`

Creates a pending consent request. Returns the consent request ID.

| Parameter         | Type      | Description                                      |
|-------------------|-----------|--------------------------------------------------|
| `issuer`          | `Address` | The issuing party; must authorize.               |
| `subject`         | `Address` | The intended credential holder.                  |
| `credential_type` | `u32`     | The credential type to be issued.                |
| `metadata_hash`   | `Bytes`   | The metadata hash of the credential to be issued.|

---

### `approve_consent(env, subject, consent_id)`

Subject approves a pending consent request, triggering credential issuance.

| Parameter    | Type      | Description                                      |
|--------------|-----------|--------------------------------------------------|
| `subject`    | `Address` | Must be the intended subject; must authorize.    |
| `consent_id` | `u64`     | The consent request to approve.                  |

**Panics:** Request not found, already approved, or expired.

---

### `get_consent_request(env, consent_id) → ConsentRequest`

Returns a consent request by ID.

**Returns:** `ConsentRequest { id, issuer, subject, credential_type, metadata_hash, expires_at_ts, approved }`

---

## 19. State Migration

### `get_state_version(env) → u32`

Returns the current state schema version. Returns `0` if no version has been set
(pre-versioning state).

---

### `migrate_state(env, admin, from_version, to_version)`

Migrates contract state from one schema version to the next. Admin only.
Versions must be sequential (`to_version == from_version + 1`).

| Parameter      | Type      | Description                                          |
|----------------|-----------|------------------------------------------------------|
| `admin`        | `Address` | Must match stored admin.                             |
| `from_version` | `u32`     | The current schema version to migrate from.          |
| `to_version`   | `u32`     | The target schema version (must be `from_version + 1`). |

**Panics:**
- `"unauthorized"` if caller is not admin
- `"versions must be sequential"` if `to_version != from_version + 1`
- `"current version mismatch"` if the stored version does not equal `from_version`
- `"no migration defined for this version"` if no migration logic exists for the given version

**Example:**
```rust
// Migrate from v0 to v1
client.migrate_state(&admin, &0u32, &1u32);
```

---

### `validate_upgrade(env, new_wasm_hash)`

Validates that a new WASM hash is acceptable for an upgrade (non-zero, contract not paused).

| Parameter        | Type          | Description                                      |
|------------------|---------------|--------------------------------------------------|
| `new_wasm_hash`  | `BytesN<32>`  | The SHA-256 hash of the new WASM binary.         |

**Panics:** Hash is all zeros, or contract is paused.

---

### `upgrade(env, admin, new_wasm_hash)`

Upgrades the contract WASM. Admin only. Validates the hash before applying.

| Parameter       | Type          | Description                                      |
|-----------------|---------------|--------------------------------------------------|
| `admin`         | `Address`     | Must match stored admin; must authorize.         |
| `new_wasm_hash` | `BytesN<32>`  | The SHA-256 hash of the new WASM binary.         |

---

## 20. Error Reference

| Code | Name                        | Description                                                        |
|------|-----------------------------|--------------------------------------------------------------------|
| 1    | `CredentialNotFound`        | No credential exists with the given ID.                            |
| 2    | `SliceNotFound`             | No quorum slice exists with the given ID.                          |
| 3    | `ContractPaused`            | The contract is paused; all writes are blocked.                    |
| 4    | `DuplicateCredential`       | Same issuer has already issued this credential type to this subject.|
| 5    | `DuplicateAttestor`         | Attestor has already attested this credential.                     |
| 6    | `AttestationExpired`        | The attestation has passed its expiry timestamp.                   |
| 7    | `InvalidInput`              | A parameter failed validation (e.g. empty hash, zero type).        |
| 8    | `InvalidAddress`            | An address parameter is invalid.                                   |
| 11   | `UnauthorizedAction`        | Caller is not authorized for this operation.                       |
| 16   | `NotAttested`               | Credential has not been attested.                                  |
| 17   | `NotInSlice`                | Attestor is not a member of the specified slice.                   |
| 18   | `AccusedCannotVote`         | The accused party cannot vote on their own dispute.                |
| 19   | `AlreadyVoted`              | Caller has already voted on this dispute or challenge.             |
| 20   | `AttestationWindowOutside`  | Attestation attempted outside the configured time window.          |
| 21   | `RecoveryNotFound`          | No recovery request exists with the given ID.                      |
| 22   | `RecoveryAlreadyExists`     | A pending recovery already exists for this credential.             |
| 23   | `RecoveryNotPending`        | Recovery request is not in pending state.                          |
| 25   | `RecoveryThresholdNotMet`   | Not enough approvals to execute the recovery.                      |
| 28   | `InvalidParentType`         | Parent credential type is not registered.                          |
| 29   | `CircularHierarchy`         | Setting this parent would create a circular type dependency.       |
| 30   | `CredentialTypeNotFound`    | Credential type is not registered.                                 |
| 31   | `HolderBlacklisted`         | Holder is blacklisted by this issuer.                              |
| 32   | `AlreadyBlacklisted`        | Holder is already on this issuer's blacklist.                      |
| 33   | `NotBlacklisted`            | Holder is not on this issuer's blacklist.                          |
| 34   | `ForkDetected`              | Conflicting attestations detected for the same slice.              |
| 35   | `ForkAlreadyResolved`       | Fork has already been resolved for this slice.                     |
| 36   | `NoForkExists`              | No fork exists for this credential-slice pair.                     |
| 37   | `TransactionSizeExceeded`   | Metadata hash or bytes exceed the maximum allowed size.            |
| 38   | `InvalidTimestamp`          | Timestamp is outside the allowed range (±10 years from now).       |
| 39   | `TransferNotAllowed`        | Credential type is configured as non-transferable.                 |
| 40   | `UnauthorizedTransfer`      | Caller is not authorized to initiate or accept this transfer.      |
| 41   | `RateLimitExceeded`         | Address has exceeded the configured rate limit.                    |
| 42   | `NumericOverflow`           | An arithmetic operation would overflow.                            |
| 44   | `PermissionDenied`          | General permission check failed.                                   |
| 45   | `RevocationRequestNotFound` | No revocation request exists for this credential.                  |
| 46   | `RevocationNotPending`      | Revocation request is not in pending state.                        |
| 47   | `CredentialVersionNotFound` | The requested credential version does not exist.                   |
| 48   | `DecryptionKeyNotFound`     | No decryption key entry exists for this party and credential.      |

---

## Constants

| Constant                        | Value     | Description                                          |
|---------------------------------|-----------|------------------------------------------------------|
| `MAX_ATTESTORS_PER_SLICE`       | 20        | Maximum attestors allowed in a single quorum slice.  |
| `MAX_BATCH_SIZE`                | 50        | Maximum items in any batch operation.                |
| `MAX_METADATA_SIZE`             | 256 bytes | Maximum size of a metadata hash.                     |
| `MAX_METADATA_BYTES_SIZE`       | 1024 bytes| Maximum size of attestation metadata bytes.          |
| `MAX_TIMESTAMP_FUTURE_OFFSET`   | ~10 years | Maximum allowed future offset for timestamps.        |
| `DEFAULT_RATE_LIMIT_MAX_CALLS`  | 100       | Default maximum calls per rate-limit window.         |
| `DEFAULT_RATE_LIMIT_WINDOW`     | 3600 s    | Default rate-limit window duration (1 hour).         |
| `CONSENT_REQUEST_TIMEOUT`       | 604800 s  | Consent request expiry (7 days).                     |
