# Atomic Saga Rollback Specification

## Overview

QuorumProof uses a 3-phase saga pattern for cross-contract operations:
1. **Phase 1 (quorum_proof):** Credential state update
2. **Phase 2 (sbt_registry):** SBT minting/state change
3. **Phase 3 (zk_verifier):** Proof verification/caching

If any phase fails, the transaction must roll back to restore consistency. This document specifies the automatic and manual rollback triggers, the observable state guarantees, and how to verify rollback correctness.

---

## 1. Rollback Trigger Model

### 1.1 Automatic Rollback (Preferred)

When Phase 3 (zk_verifier) fails, the saga **automatically initiates rollback**:

```
Phase 1 (DONE) → Phase 2 (DONE) → Phase 3 (FAIL)
                                      ↓
                            initiate_rollback() [automatic]
                                      ↓
                            Phase 2 revert (DONE) → Phase 1 revert (DONE)
                                      ↓
                                  RolledBack
```

**Precondition:** No manual intervention required. The contract's event handlers trigger rollback immediately upon a phase failure.

**Implementation:** See `check_and_recover()` in `atomic_operations.rs`, called at the start of each mutating function.

### 1.2 Manual Rollback (Safety Net)

If automatic rollback fails to trigger (e.g., event listener crash), an operator can manually invoke rollback:

```bash
soroban contract invoke \
  --id <QUORUM_PROOF_CONTRACT_ID> \
  initiate_rollback \
  --admin <ADMIN_ADDRESS> \
  --txn_id <STUCK_TRANSACTION_ID>
```

**Precondition:** The transaction must be in `Phase3_ZkVerifier` or `RollingBack` state and not already `Committed` or `RolledBack`.

**Observable state after manual rollback:**
- Phase 2 state in sbt_registry is reverted (SBT minting is undone if it was applied).
- Phase 1 state in quorum_proof is reverted (credential state is restored).
- Transaction status is set to `RolledBack`.

---

## 2. Failure Scenarios and Recovery

### 2.1 Phase 1 Failure (Credential Operation Fails)

```
Phase 1 (FAIL) → No phases proceed
                      ↓
                   No rollback needed (no state changed)
                      ↓
                  Transaction remains Initialized
```

**Observable state:** quorum_proof, sbt_registry, and zk_verifier are all unchanged.

**Recovery:** Retry the saga with corrected operation parameters.

### 2.2 Phase 2 Failure (SBT Minting Fails)

```
Phase 1 (DONE) → Phase 2 (FAIL)
                      ↓
        initiate_rollback() [automatic]
                      ↓
        Revert Phase 1 (DONE)
                      ↓
              RolledBack
```

**Observable state after rollback:**
- quorum_proof: Credential state is restored to pre-Phase1.
- sbt_registry: No SBT was minted (Phase 2 failed before state was committed).
- zk_verifier: No change (Phase 3 never started).

**Recovery:** Retry the saga.

### 2.3 Phase 3 Failure (Proof Verification Fails)

```
Phase 1 (DONE) → Phase 2 (DONE) → Phase 3 (FAIL)
                                       ↓
                         initiate_rollback() [automatic]
                                       ↓
                    Revert Phase 2 (sbt_registry) (DONE)
                    Revert Phase 1 (quorum_proof) (DONE)
                                       ↓
                                   RolledBack
```

**Observable state after rollback:**
- quorum_proof: Credential is reverted.
- sbt_registry: SBT minting is undone; SBT record is deleted.
- zk_verifier: No cache entry is written (Phase 3 failed before verification result was cached).

**Critical guarantee:** An SBT is **never** minted without proof verification. If proof verification fails, the SBT is rolled back.

**Recovery:** 
- Fix the proof and retry the saga.
- OR provide an alternative proof from a different circuit.

### 2.4 Rollback Failure (Revert Operations Fail)

If a revert operation itself fails (e.g., a network partition prevents contacting sbt_registry during rollback):

```
Phase 3 (FAIL) → initiate_rollback() [automatic]
                         ↓
              Revert Phase 2 (FAIL) ← [Network error]
                         ↓
            Transaction status = RollingBack [STUCK]
```

**Observable state (stuck):**
- Transaction is in `RollingBack` state.
- Phase 1 has been reverted.
- Phase 2 revert was not applied.
- **Partial rollback:** quorum_proof is consistent, but sbt_registry still holds the minted SBT.

**Detection:** Monitor transactions in `RollingBack` state for longer than a configured TTL (e.g., 24 hours).

**Manual recovery:**
```bash
# Operator calls complete_rollback after the network issue is resolved
soroban contract invoke \
  --id <QUORUM_PROOF_CONTRACT_ID> \
  complete_rollback \
  --admin <ADMIN_ADDRESS> \
  --txn_id <STUCK_TRANSACTION_ID>
```

**Post-recovery:** 
- Phase 2 revert is retried.
- Transaction status transitions to `RolledBack`.

---

## 3. Double-Rollback Prevention

An already-rolled-back transaction must not be rolled back again:

**Precondition check:**
```rust
pub fn initiate_rollback(env: &Env, admin: &Address, txn_id: u64) {
    let txn = get_transaction(env, txn_id);
    
    // Reject if already committed or already rolled back
    assert!(
        txn.phase != TxnPhase::Committed && txn.phase != TxnPhase::RolledBack,
        "transaction already finalized"
    );
    // ... proceed with rollback
}
```

**Test scenario:**
1. Start a saga.
2. Trigger Phase 3 failure.
3. Call `initiate_rollback` (automatic or manual).
4. Wait for rollback to complete (`txn.phase == RolledBack`).
5. Attempt to call `initiate_rollback` again.
6. **Expected:** Panic with "transaction already finalized" or equivalent error code.
7. **Actual state:** Transaction remains `RolledBack`, no changes made.

---

## 4. State Consistency Assertions

After any rollback, the following invariants must hold:

### 4.1 Credential Consistency (quorum_proof)

```rust
// Before saga:
assert_eq!(credential.status, CredentialStatus::Valid);

// After Phase 1 (before Phase 2):
assert_eq!(credential.status, CredentialStatus::Attested);

// After rollback:
assert_eq!(credential.status, CredentialStatus::Valid);
// All state is identical to pre-saga
```

### 4.2 SBT Consistency (sbt_registry)

```rust
// Before saga:
assert_eq!(registry.token_count(), N);

// After Phase 2 (before Phase 3):
assert_eq!(registry.token_count(), N + 1);

// After rollback:
assert_eq!(registry.token_count(), N);
// New SBT is deleted; registry is consistent
```

### 4.3 Verification Cache Consistency (zk_verifier)

```rust
// Before saga:
assert_eq!(cache.get(proof_hash), None);

// After Phase 3 (normal completion):
assert_eq!(cache.get(proof_hash), Some(verification_result));

// After Phase 3 failure + rollback:
assert_eq!(cache.get(proof_hash), None);
// No cache entry for the failed proof
```

---

## 5. Integration Test Structure

### 5.1 Test Layout

Tests are in `contracts/integration_tests/src/saga_rollback.rs`:

```rust
#[test]
fn test_phase3_failure_auto_rollback() {
    // 1. Setup: initialize all three contracts
    // 2. Execute Phase 1: credential operation succeeds
    // 3. Execute Phase 2: SBT minting succeeds
    // 4. Execute Phase 3: inject a bad proof to trigger failure
    // 5. Assert: auto-rollback is triggered
    // 6. Verify: credential and SBT state are reverted
}

#[test]
fn test_stuck_rollback_manual_recovery() {
    // 1. Setup: initialize all three contracts with network fault simulation
    // 2. Execute Phases 1-2 successfully
    // 3. Trigger Phase 3 failure
    // 4. Simulate network partition during Phase 2 revert
    // 5. Assert: transaction is in RollingBack state
    // 6. Call complete_rollback() manually
    // 7. Verify: transaction reaches RolledBack and state is consistent
}

#[test]
fn test_double_rollback_panic() {
    // 1. Execute a saga and rollback
    // 2. Attempt to rollback again
    // 3. Assert: panic or error with "already finalized"
}
```

### 5.2 Execution Harness

Use Soroban's testutils to mock all three contracts in a single test environment:

```rust
fn setup_saga_test() -> (QuorumProofClient, SbtRegistryClient, ZkVerifierClient, Env) {
    let env = Env::default();
    env.mock_all_auths();
    
    let qp_contract = /* register quorum_proof contract */;
    let registry_contract = /* register sbt_registry contract */;
    let zk_contract = /* register zk_verifier contract */;
    
    (qp_client, registry_client, zk_client, env)
}
```

---

## 6. Observability

### 6.1 Transaction Log Queries

Operators can query the state of any saga transaction:

```bash
soroban contract invoke \
  --id <QUORUM_PROOF_CONTRACT_ID> \
  get_transaction \
  --txn_id <ID>
```

Returns:
```json
{
  "txn_id": 42,
  "phase": "RolledBack",
  "started_at": 1693503600,
  "updated_at": 1693503700,
  "initiator": "GXXXXXX...",
  "operation_type": 1
}
```

### 6.2 Rollback Log Events

Each rollback emits an event for audit purposes:

```
Topic: "SagaRollback"
Data: {
  "txn_id": 42,
  "phase_failed": "Phase3_ZkVerifier",
  "reason": "proof_verification_failed",
  "triggered_by": "automatic",
  "rolled_back_at": 1693503701
}
```

Operators can monitor these events to detect failures in real-time.

---

## Related Documentation

- [Atomic Operations Implementation](../contracts/quorum_proof/src/atomic_operations.rs)
- [Disaster Recovery Procedures](./disaster-recovery.md)
- [Threat Model & Security Analysis](./threat-model.md)
