# Contract Upgrade Guide

Step-by-step guidance for upgrading QuorumProof contracts, with a focus on identifying breaking changes, planning migration paths, and transforming stored data safely.

For the general upgrade mechanism and CLI procedures, see [contract-upgrade-strategy.md](./contract-upgrade-strategy.md).

---

## What Counts as a Breaking Change

A breaking change is any modification that causes existing callers or stored data to behave differently after upgrade. The table below lists every category with examples from this codebase.

| Category | Breaking | Non-breaking |
|----------|----------|--------------|
| Contract functions | Removing or renaming a function | Adding a new function |
| Function parameters | Removing, reordering, or changing the type of a parameter | Adding an optional parameter at the end |
| `ContractError` variants | Removing a variant or changing its discriminant value | Adding a new variant at the end |
| `DataKey` enum | Removing a variant used by live storage | Adding a new variant |
| Stored structs | Removing or reordering a field; changing a field type | Appending an `Option<T>` field |
| Events | Removing a published event type | Adding a new event type |

---

## Breaking-Change Classification Process

Before every release, the author must classify each diff:

1. Run `git diff main..HEAD -- contracts/` and review every changed type.
2. For each changed type, answer: *Can existing storage XDR still be deserialized?* and *Can existing callers still invoke the function?*
3. If either answer is no, the release is a **MAJOR** version bump (see [Semantic Versioning](#semantic-versioning)).
4. Document the breaking change in the [Changelog](#changelog-format) before merging.

---

## Semantic Versioning

| Version segment | When to bump | Example trigger |
|----------------|--------------|-----------------|
| MAJOR (x.0.0) | Any breaking change (storage layout, removed function, renumbered error) | Removing `DataKey::SliceThreshold` |
| MINOR (0.x.0) | New features; no breaking changes | Adding `get_issuer_reputation()` |
| PATCH (0.0.x) | Bug fixes; no API or storage changes | Fix off-by-one in attestor count |

---

## Migration Path Templates

### Template A — Additive field on existing struct

**Scenario:** You need to store a new field on `Credential` (e.g., `grace_period`).

**Steps:**
1. Add the field as `Option<T>` at the end of the struct — never in the middle.
2. On first read of any pre-existing record, default the missing field with `.unwrap_or(default_value)`.
3. No admin migration call is needed; lazy migration handles it automatically.

**Example:**
```rust
// Before
pub struct Credential {
    pub id: u64,
    pub subject: Address,
    pub revoked: bool,
    pub expires_at: Option<u64>,
    pub version: u32,
}

// After — grace_period appended, never inserted
pub struct Credential {
    pub id: u64,
    pub subject: Address,
    pub revoked: bool,
    pub expires_at: Option<u64>,
    pub version: u32,
    pub grace_period: Option<u64>,   // new
}
```

**Read helper:**
```rust
pub fn get_credential(env: Env, id: u64) -> Credential {
    let mut cred: Credential = env.storage().instance()
        .get(&DataKey::Credential(id))
        .unwrap_or_else(|| panic_with_error!(&env, ContractError::CredentialNotFound));
    // Lazy migration: older records carry None; set a concrete default on first read.
    if cred.grace_period.is_none() {
        cred.grace_period = Some(0);
        env.storage().instance().set(&DataKey::Credential(id), &cred);
    }
    cred
}
```

---

### Template B — New storage key alongside existing key

**Scenario:** You need to track per-issuer reputation scores, which did not exist before.

**Steps:**
1. Add `DataKey::IssuerReputation(Address)` to the `DataKey` enum.
2. All reads default to 0 for issuers created before the upgrade.
3. No data transformation needed on upgrade.

```rust
pub fn get_issuer_reputation(env: Env, issuer: Address) -> u64 {
    env.storage().instance()
        .get::<DataKey, u64>(&DataKey::IssuerReputation(issuer.clone()))
        .unwrap_or(0)
}
```

---

### Template C — Replacing a key with a new format

**Scenario:** `DataKey::SliceMembers(u64)` stored a `Vec<Address>`, but you now need `Vec<Member>` (a richer struct).

**Steps:**
1. Add the new key `DataKey::SliceMembersV2(u64)`.
2. Write a one-time migration function, callable only by admin.
3. Keep reading from the old key for the migration window; after all records are migrated, reads switch to the new key.
4. Do not delete the old key variant from the enum until the next MAJOR release.

```rust
pub fn migrate_slice_members(env: Env, admin: Address, slice_ids: Vec<u64>) {
    admin.require_auth();
    let stored_admin: Address = env.storage().instance()
        .get(&DataKey::Admin)
        .unwrap_or_else(|| panic_with_error!(&env, ContractError::InvalidInput));
    assert!(admin == stored_admin);

    for id in slice_ids.iter() {
        if let Some(old_members) = env.storage().instance()
            .get::<DataKey, Vec<Address>>(&DataKey::SliceMembers(id))
        {
            let new_members: Vec<Member> = old_members.iter()
                .map(|addr| Member { address: addr, weight: 1 })
                .collect();
            env.storage().instance().set(&DataKey::SliceMembersV2(id), &new_members);
        }
    }
}
```

---

### Template D — Removing a feature (MAJOR bump required)

**Scenario:** `DataKey::BlacklistedHolder(Address)` is being removed in favour of on-chain governance.

**Steps:**
1. Bump MAJOR version.
2. In the release prior to removal, emit a deprecation event from all reads of the key so off-chain tooling can detect usage.
3. In the removal release, stop writing the key. Old storage entries become orphaned but do no harm.
4. Document the removed function in [Changelog](#changelog-format).

---

## Data Transformation Procedures

When stored data must be transformed (not just extended), follow this sequence:

```
1. Deploy upgrade that adds new storage key and migration function.
   (Old data still readable by old key; contract is fully functional.)

2. Admin calls migration function with batch of record IDs.
   (Repeat in batches to stay within Soroban instruction budget.)

3. Verify migrated records via off-chain script before step 4.

4. Deploy follow-up upgrade that removes reads from old key.
   (Old data stays in storage but is no longer accessed.)
```

**Batch size guidance:** Soroban limits each transaction to ~100M instructions. For struct transformations, aim for batches of 50–200 records depending on struct complexity. Test on testnet with representative data first.

**Verification script (TypeScript):**
```typescript
async function verifyMigration(oldKey: string, newKey: string, ids: number[]) {
  for (const id of ids) {
    const oldRecord = await simulateCall('get_legacy_slice_members', [id]);
    const newRecord = await simulateCall('get_slice_members', [id]);
    if (oldRecord.length !== newRecord.length) {
      console.error(`Mismatch at id=${id}: old=${oldRecord.length}, new=${newRecord.length}`);
    }
  }
  console.log('Migration verification complete.');
}
```

---

## Changelog Format

Every upgrade must include an entry in `CHANGELOG.md` using this structure:

```markdown
## [2.0.0] — 2026-06-30

### Breaking Changes
- Removed `blacklist_holder` / `remove_from_blacklist` functions (replaced by on-chain governance).
- `DataKey::BlacklistedHolder` is no longer written; existing entries are ignored.

### Migration Required
- Run `migrate_slice_members` admin function with all slice IDs before upgrading clients.
- CLI: `soroban contract invoke -- migrate_slice_members --admin <ADDR> --slice-ids '[1,2,3,...]'`

### New Features
- Added `Member.weight` field for weighted quorum (defaults to 1 for pre-upgrade records).

### Fixed
- Off-by-one in attestor count during edge-case quorum evaluation.
```

---

## Pre-upgrade Checklist for Breaking Changes

- [ ] All breaking changes are classified and documented in the changelog
- [ ] MAJOR version bumped in `Cargo.toml`
- [ ] Migration function added and tested on testnet
- [ ] Batch size calibrated against real record sizes on testnet
- [ ] Rollback WASM hash recorded in ops runbook
- [ ] Off-chain clients (api-server, frontend) updated to handle both old and new response shapes during the migration window
- [ ] All stakeholders (issuers, holders, integrators) notified at least 7 days in advance

---

## References

- [contract-upgrade-strategy.md](./contract-upgrade-strategy.md) — upgrade CLI procedures and rollback
- [error-codes.md](./error-codes.md) — `ContractError` variant list (never renumber)
- [architecture.md](./architecture.md) — DataKey inventory
