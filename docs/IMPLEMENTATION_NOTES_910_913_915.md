# Implementation Notes for Issues #910, #913, #915

This document covers the implementation of three major features:
- **#910**: Attestation Veto by Trusted Third Party
- **#913**: Cross-Contract Atomic Operations  
- **#915**: Contract Version Migration Path

## Overview

All three features have been implemented as modules within the `quorum_proof` contract with comprehensive test coverage.

---

## Issue #910: Attestation Veto by Trusted Third Party

### Purpose
Provide a mechanism for designated authorities (e.g., regulatory bodies) to dispute/veto attestations with a configurable time-locked delay.

### Architecture

**Core Module**: `contracts/quorum_proof/src/attestation_veto.rs`

**Data Structures**:
- `VetoRequest` - Represents a single veto request with status and metadata
- `VetoStatus` - Enum: Pending, Ready, Executed, Cancelled

**Key Functions**:
```rust
pub fn request_veto(...) -> u64                    // Request a veto (returns veto_id)
pub fn get_veto_request(...) -> Option<VetoRequest>  // Query veto by ID
pub fn get_credential_veto_requests(...) -> Vec<u64> // Get all vetoes for a credential
pub fn cancel_veto(...)                            // Cancel pending veto
pub fn execute_veto(...) -> bool                   // Execute veto after time-lock
pub fn get_veto_audit_log(...) -> Vec<...>        // Audit trail of all vetoes
```

**Contract Exposure**:
```rust
// In QuorumProofContract::impl
pub fn init_veto_authorities(env, admin, authorities)
pub fn request_veto(env, veto_authority, ...)
pub fn get_veto_request(env, veto_id)
pub fn execute_veto(env, executor, veto_id) -> bool
pub fn set_veto_timelock(env, admin, seconds)
pub fn get_veto_timelock(env) -> u64
```

### Flow
1. **Setup**: Admin calls `init_veto_authorities` with list of authorized veto authorities
2. **Request**: Authority calls `request_veto` with credential_id, slice_id, attestor, and optional reason/evidence
3. **Time-lock**: Veto enters `Pending` status; must wait configured time-lock (default 48 hours)
4. **Execute**: After time-lock expires, `execute_veto` moves status to `Ready` then `Executed`
5. **Audit**: All vetoes logged in immutable audit trail

### Time-Lock Design
- Default: 172,800 seconds (48 hours)
- Configurable via `set_veto_timelock` (admin-only)
- Prevents hasty revocation of valid attestations
- Allows creditors/issuers time to contest

### Security Considerations
- Authorization: Only designated veto authorities can request vetoes
- Immutability: Executed vetoes permanently recorded in audit log
- Reversibility: Pending vetoes can be cancelled by their authority
- State validation: Contract checks veto_id and credential_id validity

### Testing
Run with:
```bash
cargo test test_veto_request_lifecycle_910
cargo test test_veto_timelock_910
```

---

## Issue #913: Cross-Contract Atomic Operations

### Purpose
Provide transactional semantics for multi-step operations across three contracts:
- quorum_proof (credential operations)
- sbt_registry (SBT minting)
- zk_verifier (proof verification)

### Architecture

**Core Module**: `contracts/quorum_proof/src/atomic_operations.rs`

**Data Structures**:
- `AtomicTransaction` - Represents a multi-phase transaction
- `TxnPhase` - Enum: Initialized, Phase1_QuorumProof, Phase2_SbtRegistry, Phase3_ZkVerifier, Committed, RollingBack, RolledBack
- `PhaseResult` - Result of executing a single phase

**Key Functions**:
```rust
pub fn begin_transaction(...) -> u64              // Begin new transaction
pub fn advance_phase(...) -> void                 // Move to next phase
pub fn record_phase_result(...) -> void           // Record phase outcome
pub fn get_phase_result(...) -> Option<PhaseResult> // Query phase result
pub fn commit_transaction(...) -> void            // Mark transaction complete
pub fn initiate_rollback(...) -> void             // Start rollback sequence
pub fn complete_rollback(...) -> void             // Finish rollback
pub fn is_transaction_active(...) -> bool         // Check if transaction still running
pub fn is_transaction_expired(...) -> bool        // Check if transaction timed out
```

**Contract Exposure**:
```rust
pub fn init_atomic_operations(env, admin)
pub fn begin_atomic_transaction(env, initiator, op_type, op_data, timeout_secs) -> u64
pub fn get_atomic_transaction(env, txn_id) -> Option<AtomicTransaction>
pub fn advance_atomic_phase(env, admin, txn_id, phase, savepoint_data)
pub fn record_atomic_phase_result(env, admin, txn_id, phase, succeeded, error_code, result_data)
pub fn commit_atomic_transaction(env, admin, txn_id)
pub fn initiate_atomic_rollback(env, admin, txn_id, reason)
pub fn complete_atomic_rollback(env, admin, txn_id)
pub fn is_atomic_transaction_active(env, txn_id) -> bool
pub fn is_atomic_transaction_expired(env, txn_id) -> bool
```

### Flow

**Success Path**:
1. Call `begin_atomic_transaction` (Initialized → Phase1)
2. Execute quorum_proof operations
3. Call `record_atomic_phase_result(phase=1, succeeded=true)`
4. Call `advance_atomic_phase(phase=2)` (Phase2_SbtRegistry)
5. Execute sbt_registry operations
6. Call `record_atomic_phase_result(phase=2, succeeded=true)`
7. Call `advance_atomic_phase(phase=3)` (Phase3_ZkVerifier)
8. Execute zk_verifier operations
9. Call `record_atomic_phase_result(phase=3, succeeded=true)`
10. Call `commit_atomic_transaction` (Committed)

**Failure Path**:
1. Any phase fails: `record_atomic_phase_result(succeeded=false, error_code=100)`
2. Call `initiate_atomic_rollback(reason=...)`
3. Off-chain orchestrator reverses effects in reverse order
4. Call `complete_atomic_rollback` (RolledBack)

### Savepoint Mechanism
- Each `advance_phase` call accepts optional `savepoint_data`
- Savepoint captures previous state for recovery
- In production: savepoint contains serialized contract state snapshot
- Enables deterministic rollback to known good state

### Timeout Protection
- Each transaction has an `expires_at` timestamp
- Default or specified timeout (e.g., 3600 seconds)
- `is_transaction_expired()` returns true after expiry
- Prevents zombie transactions from blocking system

### Idempotency
- Advancing an already-advanced phase is idempotent
- Recording a result multiple times is safe
- Rollbacks cannot be re-initiated once completed

### Security Considerations
- Authorization: Only admin/initiator can control transactions
- Atomicity: Phase results logged before any state changes
- Consistency: Savepoint enables state restoration
- Isolation: Transactions don't interfere with each other
- Durability: All state changes persisted before next phase

### Testing
```bash
cargo test test_atomic_transaction_lifecycle_913
cargo test test_atomic_transaction_phases_913
cargo test test_atomic_transaction_rollback_913
```

---

## Issue #915: Contract Version Migration Path

### Purpose
Provide a safe, pausable upgrade path for schema changes from V1 to V2.

### Architecture

**Core Module**: `contracts/quorum_proof/src/migration_v2.rs`

**Data Structures**:
- `SchemaVersion` - Enum: V1, V2
- `MigrationStatus` - Enum: NotStarted, InProgress, Paused, Completed, Failed
- `MigrationCheckpoint` - Tracks migration progress

**Key Functions**:
```rust
pub fn get_schema_version(env) -> SchemaVersion     // Get current version
pub fn start_migration_v1_to_v2(env, admin) -> u32  // Begin migration
pub fn migrate_chunk_v1_to_v2(env, admin, chunk_sz) // Process one chunk
pub fn get_migration_status(env) -> Option<...>     // Query migration state
pub fn validate_migration_integrity(env) -> bool    // Verify correctness
pub fn pause_migration(env, admin)                  // Pause in-progress migration
pub fn resume_migration(env, admin)                 // Resume paused migration
pub fn rollback_migration(env, admin)               // Rollback incomplete migration
```

**Contract Exposure**:
```rust
pub fn init_migration_v2(env, admin)
pub fn get_schema_version(env) -> u32
pub fn start_migration_v1_to_v2(env, admin) -> u32
pub fn migrate_chunk_v1_to_v2(env, admin, chunk_size) -> MigrationCheckpoint
pub fn get_migration_status(env) -> Option<MigrationCheckpoint>
pub fn validate_migration_integrity(env) -> bool
pub fn pause_migration(env, admin)
pub fn resume_migration(env, admin)
pub fn rollback_migration(env, admin)
```

### Integration with Existing Migration Framework

This module builds on the existing `migration.rs` module which provides:
- Chunked/paginated migration (respects Soroban's per-tx CPU ceiling)
- On-chain cursor tracking (idempotent orchestrator calls)
- Status polling for off-chain orchestrators

**Key Integration Points**:
```rust
// Start job in existing migration framework
let job = migration::start_job(env, 2, 1, total_items);

// Process chunks incrementally
let updated_job = migration::advance(env, job, items_examined, migrated, skipped);

// Query status at any time
if let Some(job) = migration::get_job(env, 2) { ... }
```

### Flow

**V1→V2 Migration** (Chunked):
1. Admin calls `start_migration_v1_to_v2()`
   - Creates `MigrationCheckpoint` in storage
   - Registers migration job ID=2 in framework
   - Returns job_id
2. Off-chain orchestrator calls `migrate_chunk_v1_to_v2(chunk_size=100)` in loop:
   - Loads credentials from `job.cursor` to `job.cursor + chunk_size`
   - Applies V1→V2 schema transformation to each
   - Validates transformed data against V2 schema
   - Writes back to storage
   - Updates `MigrationCheckpoint` (migrated_count, skipped_count, failed_count)
   - Returns updated checkpoint
3. Orchestrator monitors progress:
   - Polls `get_migration_status()` to see progress
   - Can call `pause_migration()` if needed
   - Resumes with `resume_migration()` when ready
4. Upon completion:
   - `migrate_chunk_v1_to_v2()` auto-updates schema version to V2
   - Sets `MigrationCheckpoint.status` to Completed
   - Records completion timestamp
5. Validation:
   - Call `validate_migration_integrity()` to verify all items migrated correctly
   - Returns false if any failures detected

**Rollback Path**:
1. If migration fails: call `rollback_migration()`
2. Schema version reverts to V1
3. `MigrationCheckpoint.status` set to Failed
4. Allows admin to diagnose and retry

### Transformation Logic

The `transform_credential_v1_to_v2()` function applies:
1. **New field defaults**: Any V2-only fields get reasonable defaults
2. **Metadata migration**: If metadata format changed, apply transformation
3. **Validation**: Ensure all V2 constraints met
4. **Versioning**: Increment credential version number

Example transformations:
- Add `version_tag: String` = "v2"
- Migrate `metadata: Bytes` to structured format if needed
- Validate timestamp fields
- Check all required fields present

### Checkpoint Semantics

`MigrationCheckpoint` tracks:
- `total_items` - Snapshot of credential count at start
- `migrated_items` - Count of successfully transformed credentials
- `skipped_items` - Count of credentials already at V2 (idempotent)
- `failed_items` - Count of credentials with transformation errors
- `status` - Current migration state
- `progress_bps()` - Progress in basis points (0..=10,000)

### Safety Guarantees

**Atomicity of Chunks**: Each chunk is processed as a single Soroban transaction. All or nothing.

**Idempotency**: Processing the same chunk twice applies transformations only to untransformed items.

**Completeness**: Migration must process all items created before `total_items` snapshot.

**Integrity**: `validate_migration_integrity()` confirms V2 constraints met.

### Performance Considerations

- Chunk size tunable (default 100): larger = fewer orchestrator calls, but higher per-tx cost
- MAX_CHUNK_SIZE = 200: safety limit to prevent exceeding Soroban's CPU budget
- Orchestrator can auto-scale chunk size based on tx costs

### Testing
```bash
cargo test test_schema_version_management_915
cargo test test_migration_status_915
cargo test test_migration_pause_resume_915
```

---

## Integration Summary

### Module Dependencies
```
lib.rs (QuorumProofContract)
  ├── attestation_veto.rs     (Issue #910)
  ├── atomic_operations.rs    (Issue #913)
  ├── migration_v2.rs         (Issue #915)
  │   └── migration.rs        (existing framework)
  └── ...other modules
```

### Public API

All three features are exposed via `QuorumProofContract` public methods.

**Dashboard API** (`api-server/src/routes/dashboard.ts` - Issue #997):
- GET `/api/me/credentials` - List user's credentials
- GET `/api/me/credentials/{id}` - Get credential details with attestations
- GET `/api/me/disputes` - Get pending disputes
- GET `/api/me/access-log` - Credential access audit log
- POST `/api/me/disputes` - Create dispute
- GET `/api/me/summary` - Dashboard summary

### Event Emission

Each module emits events for audit/monitoring:

**#910 Veto Events**:
- `VetoRequested(veto_id, credential_id, authority)`
- `VetoExecuted(veto_id, credential_id)`
- `VetoCancelled(veto_id)`

**#913 Atomic Events**:
- `TransactionBegun(txn_id, initiator)`
- `PhaseAdvanced(txn_id, phase)`
- `PhaseResult(txn_id, phase, succeeded)`
- `TransactionCommitted(txn_id)`
- `TransactionRolledBack(txn_id, reason)`

**#915 Migration Events**:
- `MigrationStarted(from_version, to_version)`
- `ChunkMigrated(migrated_count, skipped_count)`
- `MigrationCompleted(total_items)`
- `MigrationFailed(reason)`

---

## Testing

All three features include comprehensive test coverage:

```bash
# Build all contracts
cargo build --release --target wasm32-unknown-unknown -p quorum_proof
cargo build --release --target wasm32-unknown-unknown -p sbt_registry
cargo build --release --target wasm32-unknown-unknown -p zk_verifier

# Run contract unit tests
cargo test --target x86_64-unknown-linux-gnu --lib --workspace

# Run integration tests
cargo test --target x86_64-unknown-linux-gnu -p integration_tests

# Run API server tests
cd api-server && npm test -- dashboard
```

---

## Deployment Checklist

- [ ] All three modules compile without warnings
- [ ] Unit tests pass (100% coverage)
- [ ] Integration tests pass
- [ ] API tests pass
- [ ] CI pipeline passes
- [ ] Code review approved
- [ ] Security audit completed
- [ ] Mainnet deployment dry-run successful
- [ ] Admin notified; ready to deploy

---

## Known Limitations & Future Work

### #910 Attestation Veto
- Veto authorities currently not rotatable during execution (can be added in v1.1)
- No automatic veto expiry (manual cancellation required)
- Single veto per attestation (bulk vetoes in v1.1)

### #913 Atomic Operations
- No cross-contract calls yet (relies on off-chain orchestrator)
- Savepoint format is application-specific (serialization in v1.1)
- No automatic retry on transient failures (orchestrator handles)

### #915 Migration Path
- Only V1→V2 path implemented (V2→V3 follows same pattern)
- No rollforward after rollback (full re-migration needed)
- Chunk size not auto-tuned (manual scaling required)

### #997 Dashboard API
- In-memory storage (use persistent DB in production)
- No caching layer (add Redis in production)
- No rate limiting per credential (implement in v1.1)

---

## References

- [Architecture Overview](./architecture.md)
- [Migration Framework Design](./migration-invariants.md)
- [Atomic Operations Pattern](https://en.wikipedia.org/wiki/Atomicity_(database_systems))
- [Verifiable Credentials Data Model](https://www.w3.org/TR/vc-data-model/)
- [Soroban Smart Contracts Guide](https://developers.stellar.org/learn/fundamentals/soroban)
