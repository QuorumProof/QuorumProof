# Contract Upgrade Strategy

## Overview

QuorumProof uses Soroban's built-in contract upgrade mechanism to enable seamless updates without losing state. This document outlines the procedures, migration strategies, and testing protocols for upgrading the QuorumProof contract.

## Upgrade Mechanism

### How Soroban Upgrades Work

Soroban contracts can be upgraded by deploying new WASM code while preserving all stored state. The upgrade is performed via the `env.deployer().update_current_contract_wasm()` function, which:

1. Validates the new WASM hash
2. Replaces the contract code
3. Preserves all storage (DataKey entries remain intact)
4. Maintains the contract address

### Authorization

Upgrades are **admin-only** operations. The `upgrade()` function requires:

```rust
pub fn upgrade(env: Env, admin: Address, new_wasm_hash: soroban_sdk::BytesN<32>) {
    admin.require_auth();
    // stored admin check
    Self::validate_upgrade(env.clone(), new_wasm_hash.clone());
    env.deployer().update_current_contract_wasm(new_wasm_hash);
}
```

Only the address stored in `DataKey::Admin` can authorize upgrades.

### Upgrade Safety Validation

Before applying any upgrade, `validate_upgrade(env, new_wasm_hash)` is called automatically. It enforces:

| Check | Rationale |
|---|---|
| Hash is non-zero | Prevents accidental deployment of a blank/empty WASM |
| Contract is not paused | Upgrades are blocked during incident response windows |
| Error code baseline preserved | Ensures existing clients that depend on specific error codes are not broken |

An `UpgradeValidated` event is emitted on every successful validation call, giving off-chain tooling an auditable trail of upgrade attempts.

**Upgrade safety requirements:**

1. New WASM **must not remove** any `DataKey` or `DataKey2` variants — existing storage keys must remain readable.
2. New WASM **must not renumber** `ContractError` variants — error codes are part of the public API.
3. New WASM **must not remove** public contract functions — callers depend on a stable interface.
4. Struct fields may only be **appended**, never removed or reordered, to preserve XDR deserialization of stored data.
5. Run `validate_upgrade` on testnet before mainnet to confirm the hash is non-zero and the contract is unpaused.

## Upgrade Procedures

### Pre-Upgrade Checklist

Before initiating an upgrade:

1. **Code Review**: All changes must be reviewed and approved
2. **Testing**: Run full test suite on testnet
3. **Backward Compatibility**: Ensure new code handles existing storage format
4. **State Snapshot**: Document current contract state
5. **Rollback Plan**: Prepare previous WASM hash for emergency rollback
6. **Communication**: Notify all stakeholders (issuers, holders, verifiers)

### Step-by-Step Upgrade Process

#### 1. Build New WASM

```bash
cd contracts/quorum_proof
cargo build --release --target wasm32-unknown-unknown
```

The compiled WASM is located at:
```
target/wasm32-unknown-unknown/release/quorum_proof.wasm
```

#### 2. Compute WASM Hash

```bash
# Using soroban-cli
soroban contract install --wasm target/wasm32-unknown-unknown/release/quorum_proof.wasm \
  --network testnet

# Output will include the WASM hash (32-byte hex string)
```

#### 3. Invoke Upgrade

```bash
# Using soroban-cli
soroban contract invoke \
  --id <CONTRACT_ID> \
  --network testnet \
  --source-account <ADMIN_ACCOUNT> \
  -- upgrade \
  --admin <ADMIN_ADDRESS> \
  --new-wasm-hash <NEW_WASM_HASH>
```

#### 4. Verify Upgrade

```bash
# Check contract version or call a test function
soroban contract invoke \
  --id <CONTRACT_ID> \
  --network testnet \
  -- get_credential_count
```

### Emergency Rollback

If the upgrade causes critical issues:

1. **Identify Previous WASM Hash**: Retrieve from deployment records
2. **Invoke Rollback**: Call `upgrade()` with previous WASM hash
3. **Verify State**: Confirm all data is intact

```bash
soroban contract invoke \
  --id <CONTRACT_ID> \
  --network testnet \
  --source-account <ADMIN_ACCOUNT> \
  -- upgrade \
  --admin <ADMIN_ADDRESS> \
  --new-wasm-hash <PREVIOUS_WASM_HASH>
```

## Migration Strategy

### Storage Compatibility

QuorumProof uses the `DataKey` enum to manage all storage. When upgrading:

- **Existing DataKeys**: Remain accessible and unchanged
- **New DataKeys**: Can be added without affecting existing data
- **Removed DataKeys**: Old data persists but becomes inaccessible (safe to ignore)
- **Modified DataKeys**: Requires careful migration logic

### Adding New Features

When adding new features that require storage:

1. **Define New DataKey Variants**: Add to the `DataKey` enum
2. **Initialize Defaults**: Use `.unwrap_or()` for missing keys
3. **Lazy Migration**: Populate new storage on first access
4. **No Data Loss**: Existing credentials and slices remain intact

Example:

```rust
// Old code
pub fn get_attestor_count(env: Env, address: Address) -> u64 {
    env.storage()
        .instance()
        .get(&DataKey::AttestorCount(address))
        .unwrap_or(0u64)
}

// After upgrade with new feature
pub fn get_holder_attestation_count(env: Env, holder: Address) -> u64 {
    env.storage()
        .instance()
        .get(&DataKey::HolderAttestationCount(holder))  // New key
        .unwrap_or(0u64)  // Defaults to 0 if not yet set
}
```

### Modifying Existing Structures

If you need to modify a struct (e.g., `Credential`):

1. **Add New Fields**: Always append, never remove
2. **Use Option Types**: Make new fields `Option<T>` for backward compatibility
3. **Provide Defaults**: Use `.unwrap_or()` when reading old data

Example:

```rust
// Before upgrade
pub struct Credential {
    pub id: u64,
    pub subject: Address,
    pub issuer: Address,
    pub credential_type: u32,
    pub metadata_hash: soroban_sdk::Bytes,
    pub revoked: bool,
    pub expires_at: Option<u64>,
    pub version: u32,
}

// After upgrade (adding new field)
pub struct Credential {
    pub id: u64,
    pub subject: Address,
    pub issuer: Address,
    pub credential_type: u32,
    pub metadata_hash: soroban_sdk::Bytes,
    pub revoked: bool,
    pub expires_at: Option<u64>,
    pub version: u32,
    pub grace_period: Option<u64>,  // New field, optional for compatibility
}
```

### Data Migration Patterns

#### Pattern 1: Lazy Migration

Migrate data on first access:

```rust
pub fn get_credential(env: Env, credential_id: u64) -> Credential {
    let mut credential: Credential = env
        .storage()
        .instance()
        .get(&DataKey::Credential(credential_id))
        .unwrap_or_else(|| panic_with_error!(&env, ContractError::CredentialNotFound));
    
    // Lazy migration: set default if new field is missing
    if credential.grace_period.is_none() {
        credential.grace_period = Some(0);
        env.storage()
            .instance()
            .set(&DataKey::Credential(credential_id), &credential);
    }
    
    credential
}
```

#### Pattern 2: Batch Migration

Migrate all data in a single admin-only call:

```rust
pub fn migrate_credentials(env: Env, admin: Address) {
    admin.require_auth();
    let stored_admin: Address = env
        .storage()
        .instance()
        .get(&DataKey::Admin)
        .unwrap_or_else(|| panic_with_error!(&env, ContractError::InvalidInput));
    assert!(admin == stored_admin, "only admin can migrate");
    
    let total: u64 = env
        .storage()
        .instance()
        .get(&DataKey::CredentialCount)
        .unwrap_or(0u64);
    
    for id in 1..=total {
        if let Some(mut credential) = env
            .storage()
            .instance()
            .get::<DataKey, Credential>(&DataKey::Credential(id))
        {
            if credential.grace_period.is_none() {
                credential.grace_period = Some(0);
                env.storage()
                    .instance()
                    .set(&DataKey::Credential(id), &credential);
            }
        }
    }
}
```

#### Pattern 3: Paginated / Chunked Migration (large deployments)

Pattern 2 (batch migration) walks every id in a caller-supplied `[start_id, end_id]`
range inside a single transaction. That's fine for a few dozen test records, but a
live deployment with many thousands of Credential/Slice/SBT records cannot be
migrated that way: Soroban enforces a hard per-invocation CPU instruction and
memory ceiling (mirrored in tests by `Env::default()`'s budget, ~100M CPU
instructions per invocation), and one transaction walking thousands of storage
entries will exceed it and abort with no state change. See
[Paginated / Chunked Migration Protocol](#paginated--chunked-migration-protocol)
below for the full design: an on-chain cursor (`migration.rs`), the
`start_metadata_migration` / `migrate_next_chunk` / `get_migration_job`
entrypoints, and the crash-safe off-chain orchestrator that drives them.

## Paginated / Chunked Migration Protocol

### Why batch migration doesn't scale

`migrate_metadata_schema(admin, to_version, start_id, end_id)` (Pattern 2 above) is a
single-transaction batch migration. It works for test fixtures and small deployments,
but it fundamentally cannot migrate a deployment with real history: Soroban gives
every invocation a fixed CPU/memory budget, and there is no way to split a single
transaction across two ledger closes. Once `end_id - start_id` is large enough that
walking every id's storage entry exceeds that budget, the call reverts outright —
with no partial progress, because Soroban transactions are all-or-nothing. A test in
`migration_tests.rs` (`test_single_shot_batch_migration_exceeds_a_single_invocation_budget`)
demonstrates exactly this failure mode against a 200-credential synthetic dataset,
using the same budget model Soroban enforces on mainnet.

### On-chain progress cursor

`contracts/quorum_proof/src/migration.rs` implements a small, reusable state machine
that any chunked migration can drive:

```rust
pub struct MigrationJob {
    pub id: u32,            // caller-chosen id (by convention: target schema version)
    pub kind: u32,           // which concrete migration this job runs
    pub cursor: u64,         // next item id to examine — the authoritative progress marker
    pub total_items: u64,    // snapshot of the item count taken when the job was created
    pub migrated_count: u64,
    pub skipped_count: u64,
    pub status: MigrationStatus,  // InProgress | Completed
    pub started_at: u64,
    pub updated_at: u64,
    pub completed_at: Option<u64>,
}
```

Three contract entrypoints (in `contracts/quorum_proof/src/lib.rs`) drive a job
forward one bounded chunk at a time:

| Function | Purpose |
|---|---|
| `start_metadata_migration(admin, to_version) -> MigrationJob` | Creates a job (snapshotting `CredentialCount` as `total_items`) or returns the existing one. Admin-only. |
| `migrate_next_chunk(admin, migration_id, chunk_size) -> MigrationJob` | Processes up to `chunk_size` items (server-clamped to `migration::MAX_CHUNK_SIZE = 200`) starting at the **stored** cursor, then advances it. Admin-only. |
| `get_migration_job(migration_id) -> Option<MigrationJob>` | Read-only status lookup. Unauthenticated, always available. |

`chunk_size` is clamped **inside the contract**, not just recommended to callers —
no orchestrator misconfiguration can push a single invocation past
`migration::MAX_CHUNK_SIZE = 200`.

**`MAX_CHUNK_SIZE` is a hard ceiling / circuit-breaker, not a claim that 200 is a
safe chunk size.** The real per-item cost depends on how much storage work each
migration transform does, and empirically (see
`test_single_shot_batch_migration_exceeds_a_single_invocation_budget` in
`migration_tests.rs`) even a few dozen credentials migrated in a single invocation
can exceed a realistic per-invocation budget — nowhere close to 200. Before running
a migration against a live deployment:

1. Deploy to testnet with production-representative data volume.
2. Call `migrate_next_chunk` with a candidate `chunk_size` and confirm it succeeds
   (doesn't hit `Error(Budget, ExceededLimit)`).
3. Pick the orchestrator's `--chunk-size` based on that measurement, with margin —
   real mainnet WASM execution costs are typically **higher**, not lower, than what
   a native test run shows.

This mirrors the existing "test on testnet before mainnet" guidance elsewhere in
this document — `chunk_size` is an operational tuning parameter, not a constant to
trust blindly.

### Idempotency guarantees

Idempotency holds at three levels, and each is covered by a dedicated test in
`contracts/quorum_proof/src/migration_tests.rs`:

1. **Cursor position is derived from storage, never from the caller.**
   `migrate_next_chunk` reads `job.cursor` from contract storage to decide where to
   start — it ignores any notion of "where the caller thinks the job is." A replayed,
   duplicated, or concurrently-submitted call for the same `migration_id` can only
   ever continue from wherever the ledger currently says the job is; it cannot
   rewind or reprocess a range that already advanced past it.
   (`test_replayed_chunk_call_after_crash_never_reprocesses_items`)
2. **Per-item transforms check the item's own state before touching it.** Each
   credential's `CredentialMetadataSchema` marker is checked before transforming its
   metadata; if it's already `>= to_version`, the item is skipped, not re-migrated.
   This holds even when the *old* single-shot `migrate_metadata_schema` and the *new*
   chunked engine are mixed on the same range — whichever entrypoint touched an item
   first, the other treats it as already done.
   (`test_old_batch_entrypoint_and_new_cursor_entrypoint_are_mutually_idempotent`)
3. **A completed job is a permanent no-op.** Once `cursor > total_items`, `status`
   flips to `Completed` and every subsequent `migrate_next_chunk` call against that
   `migration_id` returns the identical job untouched — same counts, same
   timestamps — without scanning storage again.
   (`test_completed_job_is_permanent_noop`)

`start_metadata_migration` is likewise idempotent: calling it again against an
already-running or already-completed job returns the existing job rather than
resetting `cursor`/`migrated_count` to zero.
(`test_starting_an_existing_job_again_does_not_reset_progress`)

### What's available during an in-progress migration

| Operation | Availability mid-migration | Why |
|---|---|---|
| Reads (`get_credential`, `get_credential_metadata`, counts, etc.) | **Always available**, for both migrated and not-yet-migrated ids | Reads never check migration/job state; `resolve_credential_metadata` already has a lazy-transform fallback for anything not yet at the active schema version. |
| Writes to not-yet-migrated records (e.g. `set_credential_metadata`) | **Available** | Writes are gated only by the contract's own `paused` flag, which a running migration does not set. |
| New writes (`issue_credential`) | **Available**, and land pre-migrated | New credentials are written directly at the currently-active schema version, so they need no migration and are excluded from the job's `total_items` snapshot correctly (anything created after the snapshot is already current). |
| `migrate_next_chunk` from a second admin session, or two orchestrator instances at once | **Safe**, but not more parallel | Both calls execute against the same on-chain cursor; whichever lands first advances it, and the second simply continues from there (see idempotency above). There's no data hazard, but throughput doesn't increase — the cursor is a single serial resource. |
| Global contract pause (`pause()`) | Still blocks admin-gated writes, `migrate_next_chunk` included | A migration is not itself a reason to pause the contract, and does not pause it. If an operator pauses the contract for an unrelated incident, migration steps pause along with everything else admin-gated, and resume automatically once unpaused. |

This is verified end-to-end by
`test_reads_and_writes_available_mid_migration`, which issues new credentials,
updates not-yet-migrated metadata, and reads both migrated and unmigrated ranges
while a job sits partway through.

### Crash-safe off-chain orchestrator

`scripts/migration_orchestrator.py` drives a job to completion by calling
`migrate_next_chunk` in a loop. Its crash-safety rests on one rule: **it never
trusts its own memory of progress** — every iteration starts by calling
`get_migration_job` and treats whatever comes back as ground truth. Concretely:

- On startup (including after a crash), it calls `start_metadata_migration`
  unconditionally — a no-op if the job already exists — and then immediately reads
  `get_migration_job` for the real cursor.
- It never keeps a local "last processed id" file, database, or in-memory
  checkpoint that could drift from on-chain state. If the process is killed at any
  point — before submitting a chunk, after submitting but before seeing the
  result, or anywhere in between — the very next thing it does on restart is ask
  the chain where the job actually is.
- Each `migrate_next_chunk` submission is wrapped in retry-with-backoff for
  transient RPC failures. A submission that the RPC reports as failed but that
  actually landed (an ambiguous network timeout) is harmless to retry: the retry
  reads the fresh cursor before building its next call, per the point above.
- The loop exits once `get_migration_job(...).status == Completed`.

`scripts/tests/test_migration_orchestrator.py` proves this with a fake in-memory
"chain" client: it runs the orchestrator, kills it (raises mid-loop) after a few
chunks, constructs a **fresh** orchestrator instance against the same fake chain
state, and asserts the second run completes the job with the exact expected total
migrated count and no id processed twice — i.e. the kill/restart is invisible to
the outcome.

### Monitoring

`get_migration_job` is polled by `monitoring/exporter/exporter.py` the same way
whether or not a migration is running. It exposes:

- `quorumproof_migration_status{migration_id}` — 0 (in progress) / 1 (completed)
- `quorumproof_migration_progress_ratio{migration_id}` — cursor / total_items
- `quorumproof_migration_cursor{migration_id}` / `..._total_items{migration_id}`
- `quorumproof_migration_migrated_total{migration_id}` / `..._skipped_total{migration_id}`
- `quorumproof_migration_last_progress_timestamp{migration_id}` — for a stalled-migration alert

The Grafana `Contract Health` dashboard has a "Migration Progress" panel, and
`prometheus/alerts.yml` has a `MigrationStalled` rule that fires if a job's cursor
stops advancing for longer than a configurable window while still `InProgress`.

### Testing

See `contracts/quorum_proof/src/migration_tests.rs` for the full suite:
multi-step completion over a 500-credential synthetic dataset (10+ chunked
invocations), the single-shot-exceeds-budget proof above, all three idempotency
guarantees, and the read/write availability test. See
`scripts/tests/test_migration_orchestrator.py` for the off-chain kill/restart
proof.

## Testing Procedures

### Unit Tests

Run all tests before upgrade:

```bash
cd contracts/quorum_proof
cargo test
```

### Integration Tests

Test on testnet before mainnet:

1. **Deploy to Testnet**: Deploy new contract version
2. **Run Test Suite**: Execute all integration tests
3. **Verify State**: Check that existing credentials are accessible
4. **Test New Features**: Verify new functionality works correctly

### Upgrade Simulation

Simulate the upgrade process:

```bash
# 1. Deploy current version
soroban contract deploy --wasm target/wasm32-unknown-unknown/release/quorum_proof.wasm \
  --network testnet

# 2. Create test data
soroban contract invoke --id <CONTRACT_ID> --network testnet \
  -- issue_credential --subject <ADDR> --credential-type 1 --metadata-hash <HASH>

# 3. Build new version with changes
cargo build --release --target wasm32-unknown-unknown

# 4. Install new WASM and get hash
soroban contract install --wasm target/wasm32-unknown-unknown/release/quorum_proof.wasm \
  --network testnet

# 5. Perform upgrade
soroban contract invoke --id <CONTRACT_ID> --network testnet \
  -- upgrade --admin <ADMIN> --new-wasm-hash <NEW_HASH>

# 6. Verify data is intact
soroban contract invoke --id <CONTRACT_ID> --network testnet \
  -- get_credential --credential-id 1
```

### Migration Invariant Regression

Run the formal invariant checker after every upgrade:

```bash
cargo test -p integration_tests -- migration_verification
```

This runs the snapshot-diff harness against all invariants defined in `docs/migration-invariants.md`.

### Regression Testing

After upgrade, verify:

- ✅ All existing credentials are accessible
- ✅ All existing slices are accessible
- ✅ Attestation history is preserved
- ✅ Admin functions still work
- ✅ New features function correctly
- ✅ No data corruption
- ✅ Migration invariant set passes (I1–I8)

## Version Management

### Tracking Versions

Store upgrade history in a separate log:

```
Upgrade Log:
- v1.0.0 (Hash: 0x1234...): Initial deployment
- v1.1.0 (Hash: 0x5678...): Added grace period feature
- v1.2.0 (Hash: 0x9abc...): Added whitelist feature
```

### Semantic Versioning

Follow semantic versioning for releases:

- **MAJOR**: Breaking changes (requires migration)
- **MINOR**: New features (backward compatible)
- **PATCH**: Bug fixes (backward compatible)

## Migration Invariant Verification

Every upgrade that performs a state migration **must** pass the formal invariant verification gate before merging. See:

- **[Migration Invariants](./migration-invariants.md)** — The complete formal invariant set (I1–I8) that every migration must preserve.
- **`contracts/integration_tests/src/migration_verification.rs`** — The snapshot-diff harness that captures contract state before/after a candidate migration and asserts all invariants hold.

### Invariant Gate in CI

The CI workflow (`.github/workflows/ci.yml`) runs `cargo test -p integration_tests -- migration_verification` as a mandatory check. Positive tests validate real migrations; negative tests ensure the checker catches deliberately broken transitions.

### Adding a New Migration

When writing a new `migrate_state` branch:

1. **Review the invariant set** in `docs/migration-invariants.md`. If your migration changes storage in a way not covered, add a new invariant.
2. **Add a positive test** to `migration_verification.rs` that populates state, runs your migration, and asserts zero violations.
3. **Run the gate locally** before pushing:
   ```bash
   cargo test -p integration_tests -- migration_verification
   ```
4. Ensure CI passes with the migration-verification gate green before requesting review.

### What the Harness Checks

| ID | Invariant | Scope |
|---|---|---|
| I1 | No orphaned SBT-to-credential references | Cross-contract |
| I2 | Slice weight caches match live attestor-weight sums | quorum_proof |
| I3 | No ID collisions (credential/slice/SBT) post-migration | quorum_proof + sbt_registry |
| I4 | Revocation/expiry state fully preserved | quorum_proof |
| I5 | Cross-contract credential cache consistent | quorum_proof ↔ sbt_registry |
| I6 | Admin identity preserved | quorum_proof |
| I7 | Paused state preserved | quorum_proof |
| I8 | StateVersion monotonically non-decreasing | quorum_proof |

## Mainnet Upgrade Checklist

Before upgrading on mainnet:

- [ ] Code reviewed by 2+ team members
- [ ] All tests pass on testnet
- [ ] Migration invariant verification passes (`cargo test -p integration_tests -- migration_verification`)
- [ ] Upgrade tested on testnet with real data
- [ ] Rollback plan documented and tested
- [ ] All stakeholders notified
- [ ] Upgrade window scheduled (low-traffic time)
- [ ] Monitoring alerts configured
- [ ] Post-upgrade verification plan ready

## Troubleshooting

### Issue: Upgrade Fails with "Invalid WASM Hash"

**Solution**: Ensure the WASM hash is correctly computed and the WASM is installed on the network.

### Issue: Contract State Becomes Inaccessible

**Solution**: Rollback to previous version. State is preserved; the issue is likely in the new code.

### Issue: New Features Don't Work After Upgrade

**Solution**: Check that new DataKey variants are properly defined and initialized.

### Issue: Performance Degradation After Upgrade

**Solution**: Profile the new code. Consider optimizing hot paths or rolling back if critical.

## References

- [Soroban Contract Upgrade Documentation](https://developers.stellar.org/docs/learn/storing-data)
- [Stellar Deployer Interface](https://developers.stellar.org/docs/learn/storing-data#deployer)
- [QuorumProof Architecture](./architecture.md)
- [Error Codes Reference](./error-codes.md)
- [Migration Invariants](./migration-invariants.md) — Formal invariant set (I1–I8)
- [Migration Verification Harness](../contracts/integration_tests/src/migration_verification.rs) — Snapshot-diff test harness
- [CI Workflow](../.github/workflows/ci.yml) — CI gate with migration verification
