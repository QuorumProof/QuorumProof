# Migration Invariants

## Purpose

This document defines the **formal invariant set** that every contract migration (upgrade + state migration) must preserve. These invariants guard against common upgrade failures: dropped storage keys, orphaned cross-contract references, stale caches, and silent data corruption.

## Invariant Definitions

### I1 — No Orphaned SBT-to-Credential References

Every `SoulboundToken` in `sbt_registry` must reference an existing, un-revoked `Credential` in `quorum_proof`.

```rust
∀ token_id ∈ sbt_registry.Tokens:
    ∃ credential ∈ quorum_proof.Credentials
    where credential.id == token.credential_id
```

**Check**: Enumerate all SBTs via `sbt_registry.sbt_count()` + `sbt_registry.owner_of()`. For each, call `quorum_proof.credential_exists(token.credential_id)`.

**Rationale**: The cross-contract call map (`docs/architecture.md`) shows `sbt_registry` calls `quorum_proof.get_credential` during mint. An upgrade that renumbers credential IDs or drops credentials without updating SBTs produces unreachable SBTs — tokens that can never be verified.

---

### I2 — Slice Weight Caches Match Live Attestor-Weight Sums

For every `QuorumSlice`, the on-chain weight cache `DataKey2::SliceTotalWeight(slice_id)` must equal the sum of the slice's individual attestor `weights`.

```
∀ slice_id ∈ [1..SliceCount]:
    stored_total_weight(slice_id) == Σ weights[0..n]
```

**Check**: Read each slice via `quorum_proof.get_slice(id)`, sum `weights`, compare to the pre-migration value (captured before migration). After migration, re-read each slice and confirm the sum equals the pre-migration sum.

**Rationale**: A migration that accidentally drops or resets the `SliceTotalWeight` cache breaks any code that relies on it (e.g., threshold enforcement, weight-based voting). The observable invariant is that the weights remain correct; the cache is an implementation detail.

---

### I3 — No ID Collisions Post-Migration

Credential IDs, Slice IDs, and Token IDs are assigned sequentially by monotonic counters (`CredentialCount`, `SliceCount`, `TokenCount`). After migration:

- `∀ id ∈ [1..CredentialCount] : credential_exists(id) == true`
- `∀ id ∈ [1..SliceCount] : slice_exists(id) == true`
- `∀ id ∈ [1..TokenCount] : owner_of(id) != error`

No duplicate or gap-skipping IDs may be introduced.

**Check**: Iterate all IDs from 1 to each count and confirm existence. Confirm `count` is unchanged from pre-migration.

**Rationale**: A migration that resets counters or re-assigns IDs breaks off-chain indexing, audit trails, and any external references to specific credential/SBT IDs.

---

### I4 — Revocation and Expiry State Preserved

For every credential that existed before migration, after migration:

- `revoked` flag is identical
- `suspended` flag is identical (if applicable)
- `expires_at` timestamp is identical
- `is_revoked()` returns the same value

```rust
∀ credential ∈ Credentials_before:
    revoked_after(credential.id) == revoked_before(credential.id) &&
    expires_at_after(credential.id) == expires_at_before(credential.id)
```

**Check**: Before migration, iterate all credentials and capture `revoked`, `suspended`, `expires_at`. After migration, compare field-by-field.

**Rationale**: A migration that accidentally clears revocation state permits revoked credentials to pass verification, which is a security vulnerability.

---

### I5 — Cross-Contract Credential Cache Consistency

`sbt_registry` may cache credential revocation status per `CredentialCache(credential_id)`. After migration, every cache entry must match `quorum_proof.is_revoked(credential_id)`.

```rust
∀ (credential_id, cached_revoked) ∈ sbt_registry.CredentialCache:
    cached_revoked == quorum_proof.is_revoked(credential_id)
```

**Check**: For each credential referenced by an SBT, compare the cached value against the live revocation state in `quorum_proof`.

**Rationale**: A stale cache can allow minting SBTs against newly revoked credentials, or falsely prevent minting against reinstated ones.

---

### I6 — Admin Identity Preserved

The `DataKey::Admin` address must be unchanged after migration.

```
admin_after == admin_before
```

**Check**: Verify that the original admin address can still perform admin-only operations (`pause`, `unpause`, `migrate_state`) after upgrade.

**Rationale**: An upgrade that drops or resets the admin storage key locks the contract permanently.

---

### I7 — Paused State Preserved

If the contract was paused before migration began, it must remain paused after migration completes. If unpaused, it must remain unpaused.

```
paused_after == paused_before
```

**Check**: `quorum_proof.is_paused()` returns same value before and after migration.

**Rationale**: An unexpected state change could allow operations during a maintenance window or block operations after a routine upgrade.

---

### I8 — StateVersion Is Monotonically Non-Decreasing

The `StateVersion` stored at `DataKey::StateVersion` must never regress across a migration.

```
state_version_after >= state_version_before
```

**Check**: `quorum_proof.get_state_version()`.

**Rationale**: Version regressions indicate a migration was applied out of order or a rollback happened incorrectly, which can confuse lazy-migration logic that checks the current version.

---

## Invariant Enforcement Matrix

| ID | Invariant | Scope | Enforced by |
|---|---|---|---|
| I1 | No orphaned SBT-to-credential references | Cross-contract | Migration harness |
| I2 | Slice weight cache matches live weights | quorum_proof | Migration harness |
| I3 | No ID collisions post-migration | quorum_proof + sbt_registry | Migration harness |
| I4 | Revocation/expiry state preserved | quorum_proof | Migration harness |
| I5 | Cross-contract credential cache consistent | quorum_proof ↔ sbt_registry | Migration harness |
| I6 | Admin identity preserved | quorum_proof | Migration harness |
| I7 | Paused state preserved | quorum_proof | Migration harness |
| I8 | StateVersion monotonically non-decreasing | quorum_proof | Migration harness |

## What the Harness Guarantees

The migration verification harness (see `contracts/integration_tests/src/migration_verification.rs`) guarantees:

1. **Before/after semantic equivalence**: All observable contract state captured through the public API is preserved across a migration.
2. **Cross-contract reference integrity**: No orphaned links exist between `sbt_registry` and `quorum_proof` after migration.
3. **Cache/state consistency**: Cached values have not drifted from their source-of-truth values.
4. **Administrative continuity**: The contract remains controllable by the original admin.

## What the Harness Does NOT Guarantee

1. **Arbitrary code correctness**: The harness only checks state before vs. after. It does not prove that the new WASM bytecode is free of logic bugs.
2. **Storage-level bitwise equivalence**: The harness checks *semantic* preservation through the public API, not raw storage key equality. Cache reorganizations or key renames that preserve the public contract are acceptable.
3. **Performance characteristics**: Migration time, gas costs, and storage footprint are outside scope.
4. **Off-chain indexer compatibility**: The harness does not test external databases or event indexers that may depend on specific storage layouts.
5. **Concurrent migration safety**: The harness assumes single-threaded, single-admin migration execution.
6. **Future invariant coverage**: New invariants may need to be added for new features. This set covers the core protocol.

## When to Update This Document

Add a new invariant when:

- A new storage key or cache is introduced that has a source-of-truth dependency
- A new cross-contract reference is added to the call map (see `docs/architecture.md`)
- A new field is added to an existing struct and the migration preserves it
