# Chaos Testing for SBT Registry Contract Resilience

This document describes the chaos testing strategy and failure modes for the SBT Registry contract.

## Overview

Chaos testing exercises the contract under adverse conditions to identify failure modes and verify graceful degradation. Tests are organized by failure category:

1. **Storage Exhaustion Simulation**
2. **Concurrency & Atomicity Stress Tests**
3. **Failure Mode Scenarios**

## Storage Exhaustion Simulation (Issue #1245)

### Test: `chaos_storage_pressure_many_holders`

**Purpose**: Verify graceful handling when storage accumulates with many SBT holders.

**Scenario**: Create 50 credentials and mint SBTs for each holder sequentially.

**Failure Mode**: Without proper handling, excessive holders could exhaust persistent storage, leading to:
- Non-deterministic storage failures
- Uncontrolled panics mid-operation
- Inconsistent state (partial writes)

**Mitigation**:
- Pagination via `MAX_BATCH_SIZE = 1000` limits tokens per call
- Atomic operations: all or nothing (no partial writes)
- Chunked storage updates (one token at a time within iteration)

**Pass Criteria**: Contract remains operational after 50 holders; final credential creation succeeds.

---

### Test: `chaos_batch_operations_within_limits`

**Purpose**: Verify batch operations respect storage boundaries.

**Scenario**: Create a batch of 100 SBT mint entries and execute batch_mint.

**Failure Mode**: Unbounded batches could:
- Exceed ledger transaction size limits
- Cause storage write failures
- Lead to partial-batch panics

**Mitigation**:
- `MAX_BATCH_SIZE = 1000` constant enforces size limits
- Callers must paginate large operations
- Each batch is atomic (all tokens minted or all fail)

**Pass Criteria**: Batch of 100 mints succeeds; all token IDs returned in order.

---

### Test: `chaos_large_metadata_storage`

**Purpose**: Test metadata storage under size constraints.

**Scenario**: Mint SBT with 256-byte metadata URI.

**Failure Mode**: Large metadata could:
- Exceed Soroban `Bytes` limits (max 4KB per entry)
- Cause storage overflow during rehydration (Issue #512)

**Mitigation**:
- Metadata stored separately in `CompressedMetadata` key (Issue #512)
- Transparent rehydration on `get_token()`
- Metadata size validated implicitly by Soroban SDK

**Pass Criteria**: Large metadata mint and retrieval succeed; metadata preserved.

---

## Concurrency & Atomicity Stress Tests (Issue #1245)

### Test: `chaos_concurrent_batch_mints_atomic`

**Purpose**: Verify atomicity across multiple batch operations.

**Scenario**:
- Prepare two separate batches (issuer1 and issuer2)
- Mint 10 tokens per batch
- Verify no collision, all tokens unique

**Failure Mode**: Insufficient atomicity could cause:
- Reused token IDs across batches
- Partial-batch writes with inconsistent counters
- Interleaved state updates

**Mitigation**:
- Token ID counter atomically incremented per token
- No interleaving between counter read and write
- Each entry's storage writes are synchronous

**Pass Criteria**: All 20 tokens have unique IDs; no collisions across batches.

---

### Test: `chaos_batch_burn_with_state_changes`

**Purpose**: Verify burn operations handle rapid state changes.

**Scenario**: Mint a token, then immediately batch burn it.

**Failure Mode**: Race conditions could cause:
- Burn of already-burned token (double-spend)
- Orphaned owner tokens in list
- Credential ID mappings left inconsistent

**Mitigation**:
- Holder-only authorization (`require_auth()`) on burn
- Token existence checked before any removal
- Owner token list updated atomically with owner mapping

**Pass Criteria**: Batch burn succeeds; correct credential ID returned.

---

## Failure Mode Scenarios (Issue #1245)

### Test: `chaos_clawback_timelock_enforced`

**Purpose**: Verify clawback timelock prevents premature execution.

**Scenario**: Initiate clawback with 1000-second timelock; verify expiry time is correct.

**Failure Mode**: Timelock bypass could allow:
- Premature clawback execution
- Holder unable to appeal (grace period lost)
- Issuer override of intended delays

**Mitigation**:
- Timelock stored in `ClawbackRequest.expires_at`
- `execute_sbt_clawback()` asserts `current_time >= expires_at`
- Ledger timestamp used (tamper-proof via consensus)

**Pass Criteria**: Clawback created; expires_at is in future; no early execution possible.

---

### Test: `chaos_clawback_cycles_consistent`

**Purpose**: Verify state consistency through repeated clawback operations.

**Scenario**:
- Initiate clawback 1, cancel it
- Initiate clawback 2, cancel it
- Verify token still owned by holder

**Failure Mode**: State tracking failures could cause:
- Lingering `PendingClawbackBySbt` entry (blocks new clawbacks)
- Incorrect status field (e.g., "pending" instead of "cancelled")
- Token incorrectly burned during cancel

**Mitigation**:
- Status field updated atomically with removal from pending map
- Both entries removed/updated in same transaction
- Owner unchanged on cancel operation

**Pass Criteria**: Both clawback cycles succeed; token owner unchanged; new clawbacks allowed.

---

### Test: `chaos_concurrent_clawback_mutual_exclusion`

**Purpose**: Verify mutual exclusion prevents concurrent clawbacks on same SBT.

**Scenario**:
- Initiate clawback 1 on token X (succeeds)
- Initiate clawback 2 on same token X (must panic)

**Failure Mode**: Concurrent clawbacks could cause:
- Two issuers clawing back the same token
- Multiple expiry times (conflicting states)
- Undefined behavior on execution

**Mitigation**:
- `PendingClawbackBySbt` key prevents duplicate initiation
- Check occurs before any state write
- Panic with `ClawbackAlreadyExists` error

**Pass Criteria**: First clawback succeeds; second clawback panics with error code 15.

---

## Cross-Cutting Failure Modes

### Credential Revocation Race (from `chaos_revoke_after_mint_graceful_degradation`)

**Scenario**: Credential revoked after SBT minted (state divergence).

**Failure Mode**: Inconsistent state could break downstream operations (e.g., `verify_engineer`).

**Mitigation**:
- Cross-contract credential cache (Issue #516) with TTL
- Caller must handle revoked credentials gracefully
- Deterministic return value (false, never panic)

---

### Authorization & Delegation Issues

**Failure Mode**: Missing `require_auth()` could allow:
- Unauthorized token burns
- Unauthorized clawback cancellations
- Unauthorized admin operations

**Mitigation**:
- Each sensitive operation calls `require_auth()` on caller
- Auth checks before any storage modification
- Double-check in `cancel_sbt_clawback()` (issuer == stored issuer)

---

## Running the Chaos Tests

```bash
cd contracts/sbt_registry
cargo test --test '*chaos*' -- --nocapture
```

All tests pass by default. The `#[should_panic]` tests verify that certain operations correctly panic.

## Key Invariants

1. **Token Uniqueness**: No two tokens share the same ID.
2. **Owner Consistency**: `Owner(token_id)` always matches `OwnerTokens(owner)` membership.
3. **Atomicity**: Batch operations are all-or-nothing at the storage level.
4. **Clawback Exclusivity**: At most one pending clawback per SBT.
5. **Authorization**: No state change without explicit `require_auth()`.
6. **Timelock Enforcement**: Clawback execution time >= expiry time.

## Future Enhancements

- [ ] Stress test with realistic ledger closure times
- [ ] Simulate network delays and timeouts
- [ ] Test credential cache TTL boundary conditions
- [ ] Load testing with max batch sizes
- [ ] Recovery protocol under partial failures

## Regression Test Convention (Issue #1479)

In addition to chaos scenarios, the `integration_tests` crate hosts a
dedicated regression suite at `src/regressions.rs`.  Every test there is
explicitly pinned to a closed bug with a `// regression: #N` comment and a
descriptive function name `regression_<N>_<short_description>`.

**Rules for adding regression tests here:**

1. Add a new submodule `regression_<N>` inside `regressions.rs`.
2. Each `#[test]` in the module must carry a `// regression: #N` comment.
3. The module doc-comment must describe the bug, the fix, and why removing
   the fix causes the test to fail.
4. Confirm the test is red before the fix and green after.

See [CONTRIBUTING.md](../../CONTRIBUTING.md) § "Regression Test Convention"
for the full policy and a worked example.

### Current regression inventory

| Issue | Module | Description |
|---|---|---|
| #1362 | `regression_1362` | Per-(credential,slice) attestation duplicate guard and `check_quorum_intersection` all-slice validation |
