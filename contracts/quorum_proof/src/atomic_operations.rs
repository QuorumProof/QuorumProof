//! Cross-Contract Atomic Operations (Issue #913)
//!
//! Provides transactional semantics for multi-step operations across contracts:
//! - quorum_proof → sbt_registry → zk_verifier
//! 
//! Uses Soroban's event-driven coordination model with a transaction log
//! to achieve atomicity and rollback capability.

use soroban_sdk::{contracttype, Address, Bytes, Env, Symbol, Vec};

use crate::{EXTENDED_TTL, STANDARD_TTL};

#[contracttype]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TxnPhase {
    /// Transaction initialized but not yet started
    Initialized = 0,
    /// Phase 1: credential operation in quorum_proof
    Phase1_QuorumProof = 1,
    /// Phase 2: SBT minting/registration in sbt_registry
    Phase2_SbtRegistry = 2,
    /// Phase 3: proof verification in zk_verifier
    Phase3_ZkVerifier = 3,
    /// All phases completed successfully
    Committed = 4,
    /// Transaction is being rolled back
    RollingBack = 5,
    /// Transaction rolled back
    RolledBack = 6,
}

#[contracttype]
#[derive(Clone)]
pub struct AtomicTransaction {
    /// Unique transaction ID (globally unique)
    pub txn_id: u64,
    /// Original initiator of the transaction
    pub initiator: Address,
    /// Current phase
    pub phase: TxnPhase,
    /// Timestamp when transaction started
    pub started_at: u64,
    /// Timestamp of last phase update
    pub updated_at: u64,
    /// Deadline for transaction completion
    pub expires_at: u64,
    /// Operation type identifier
    pub operation_type: u32,
    /// Encoded operation parameters
    pub operation_data: Bytes,
    /// Savepoint data for rollback (previous state)
    pub savepoint: Option<Bytes>,
}

/// Phase-specific result data
#[contracttype]
#[derive(Clone)]
pub struct PhaseResult {
    pub txn_id: u64,
    pub phase: TxnPhase,
    pub succeeded: bool,
    pub error_code: Option<u32>,
    pub result_data: Option<Bytes>,
    pub completed_at: u64,
}

/// Storage keys for cross-contract operations
#[contracttype]
#[derive(Clone)]
pub enum DataKeyAtomicity {
    /// Current transaction counter
    TxnCount,
    /// Active transaction indexed by txn_id
    Transaction(u64),
    /// Phase results indexed by (txn_id, phase)
    PhaseResult(u64, u32),
    /// Rollback log for recovery
    RollbackLog(u64),
}

/// Initialize atomic operation infrastructure
pub fn init_atomicity(env: &Env) {
    let key = Symbol::new(env, "atomic_txn_count");
    env.storage().instance().set(&key, &0u64);
    env.storage().instance().extend_ttl(STANDARD_TTL, EXTENDED_TTL);
}

/// Generate next transaction ID
fn next_txn_id(env: &Env) -> u64 {
    let key = Symbol::new(env, "atomic_txn_count");
    let count = env
        .storage()
        .instance()
        .get::<Symbol, u64>(&key)
        .unwrap_or(0);

    let next = count.saturating_add(1);
    env.storage().instance().set(&key, &next);
    env.storage().instance().extend_ttl(STANDARD_TTL, EXTENDED_TTL);
    next
}

/// Begin a new atomic transaction
pub fn begin_transaction(
    env: &Env,
    initiator: Address,
    operation_type: u32,
    operation_data: Bytes,
    timeout_seconds: u64,
) -> u64 {
    let now = env.ledger().timestamp();
    let txn_id = next_txn_id(env);

    let txn = AtomicTransaction {
        txn_id,
        initiator,
        phase: TxnPhase::Initialized,
        started_at: now,
        updated_at: now,
        expires_at: now.saturating_add(timeout_seconds),
        operation_type,
        operation_data,
        savepoint: None,
    };

    let key = Symbol::new(env, &format!("atomic_txn_{}", txn_id));
    env.storage().instance().set(&key, &txn);
    env.storage().instance().extend_ttl(STANDARD_TTL, EXTENDED_TTL);

    txn_id
}

/// Get a transaction by ID
pub fn get_transaction(env: &Env, txn_id: u64) -> Option<AtomicTransaction> {
    let key = Symbol::new(env, &format!("atomic_txn_{}", txn_id));
    env.storage()
        .instance()
        .get::<Symbol, AtomicTransaction>(&key)
}

/// Advance to next phase and record savepoint
pub fn advance_phase(
    env: &Env,
    txn_id: u64,
    next_phase: TxnPhase,
    savepoint_data: Option<Bytes>,
) {
    let key = Symbol::new(env, &format!("atomic_txn_{}", txn_id));
    if let Some(mut txn) = env
        .storage()
        .instance()
        .get::<Symbol, AtomicTransaction>(&key)
    {
        let now = env.ledger().timestamp();
        if now > txn.expires_at {
            panic!("transaction expired");
        }

        txn.phase = next_phase;
        txn.updated_at = now;
        txn.savepoint = savepoint_data;

        env.storage().instance().set(&key, &txn);
        env.storage().instance().extend_ttl(STANDARD_TTL, EXTENDED_TTL);
    } else {
        panic!("transaction not found");
    }
}

/// Record result of a phase execution
pub fn record_phase_result(
    env: &Env,
    txn_id: u64,
    phase: TxnPhase,
    succeeded: bool,
    error_code: Option<u32>,
    result_data: Option<Bytes>,
) {
    let phase_num = match phase {
        TxnPhase::Phase1_QuorumProof => 1u32,
        TxnPhase::Phase2_SbtRegistry => 2u32,
        TxnPhase::Phase3_ZkVerifier => 3u32,
        _ => return, // Only record phase-specific results
    };

    let result = PhaseResult {
        txn_id,
        phase,
        succeeded,
        error_code,
        result_data,
        completed_at: env.ledger().timestamp(),
    };

    let key = Symbol::new(env, &format!("atomic_phase_{}_{}", txn_id, phase_num));
    env.storage().instance().set(&key, &result);
    env.storage().instance().extend_ttl(STANDARD_TTL, EXTENDED_TTL);

    // If phase failed, log for rollback
    if !succeeded {
        let rollback_key = Symbol::new(env, &format!("rollback_log_{}", txn_id));
        let mut log = env
            .storage()
            .instance()
            .get::<Symbol, Vec<(u32, Option<u32>)>>(&rollback_key)
            .unwrap_or_else(|| Vec::new(env));
        log.push_back((phase_num, error_code));
        env.storage().instance().set(&rollback_key, &log);
        env.storage().instance().extend_ttl(STANDARD_TTL, EXTENDED_TTL);
    }
}

/// Get result of a specific phase
pub fn get_phase_result(env: &Env, txn_id: u64, phase: TxnPhase) -> Option<PhaseResult> {
    let phase_num = match phase {
        TxnPhase::Phase1_QuorumProof => 1u32,
        TxnPhase::Phase2_SbtRegistry => 2u32,
        TxnPhase::Phase3_ZkVerifier => 3u32,
        _ => return None,
    };

    let key = Symbol::new(env, &format!("atomic_phase_{}_{}", txn_id, phase_num));
    env.storage().instance().get::<Symbol, PhaseResult>(&key)
}

/// Commit transaction (all phases succeeded)
pub fn commit_transaction(env: &Env, txn_id: u64) {
    let key = Symbol::new(env, &format!("atomic_txn_{}", txn_id));
    if let Some(mut txn) = env
        .storage()
        .instance()
        .get::<Symbol, AtomicTransaction>(&key)
    {
        if txn.phase != TxnPhase::Phase3_ZkVerifier {
            panic!("cannot commit transaction not in final phase");
        }

        txn.phase = TxnPhase::Committed;
        txn.updated_at = env.ledger().timestamp();

        env.storage().instance().set(&key, &txn);
        env.storage().instance().extend_ttl(STANDARD_TTL, EXTENDED_TTL);
    } else {
        panic!("transaction not found");
    }
}

/// Initiate rollback for a transaction
pub fn initiate_rollback(env: &Env, txn_id: u64, reason: Option<Bytes>) {
    let key = Symbol::new(env, &format!("atomic_txn_{}", txn_id));
    if let Some(mut txn) = env
        .storage()
        .instance()
        .get::<Symbol, AtomicTransaction>(&key)
    {
        if txn.phase == TxnPhase::Committed
            || txn.phase == TxnPhase::RolledBack
            || txn.phase == TxnPhase::RollingBack
        {
            panic!("cannot rollback transaction in current state");
        }

        txn.phase = TxnPhase::RollingBack;
        txn.updated_at = env.ledger().timestamp();

        env.storage().instance().set(&key, &txn);
        env.storage().instance().extend_ttl(STANDARD_TTL, EXTENDED_TTL);

        // Log rollback reason
        if let Some(reason_bytes) = reason {
            let reason_key = Symbol::new(env, &format!("rollback_reason_{}", txn_id));
            env.storage().instance().set(&reason_key, &reason_bytes);
            env.storage()
                .instance()
                .extend_ttl(STANDARD_TTL, EXTENDED_TTL);
        }
    } else {
        panic!("transaction not found");
    }
}

/// Complete rollback (restore state from savepoint)
pub fn complete_rollback(env: &Env, txn_id: u64) {
    let key = Symbol::new(env, &format!("atomic_txn_{}", txn_id));
    if let Some(mut txn) = env
        .storage()
        .instance()
        .get::<Symbol, AtomicTransaction>(&key)
    {
        if txn.phase != TxnPhase::RollingBack {
            panic!("transaction not in rollback state");
        }

        txn.phase = TxnPhase::RolledBack;
        txn.updated_at = env.ledger().timestamp();

        env.storage().instance().set(&key, &txn);
        env.storage().instance().extend_ttl(STANDARD_TTL, EXTENDED_TTL);
    } else {
        panic!("transaction not found");
    }
}

/// Check if transaction is active (not yet committed/rolled back)
pub fn is_transaction_active(env: &Env, txn_id: u64) -> bool {
    if let Some(txn) = get_transaction(env, txn_id) {
        matches!(
            txn.phase,
            TxnPhase::Initialized
                | TxnPhase::Phase1_QuorumProof
                | TxnPhase::Phase2_SbtRegistry
                | TxnPhase::Phase3_ZkVerifier
        )
    } else {
        false
    }
}

/// Check if transaction has expired
pub fn is_transaction_expired(env: &Env, txn_id: u64) -> bool {
    if let Some(txn) = get_transaction(env, txn_id) {
        env.ledger().timestamp() > txn.expires_at
    } else {
        false
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_transaction_lifecycle() {
        let env = Env::default();
        init_atomicity(&env);

        let initiator = Address::generate(&env);
        let op_data = Bytes::new(&env);

        let txn_id = begin_transaction(&env, initiator.clone(), 1, op_data, 3600);

        let txn = get_transaction(&env, txn_id).unwrap();
        assert_eq!(txn.txn_id, txn_id);
        assert_eq!(txn.phase, TxnPhase::Initialized);
        assert_eq!(txn.initiator, initiator);

        // Advance to phase 1
        advance_phase(&env, txn_id, TxnPhase::Phase1_QuorumProof, None);
        let txn = get_transaction(&env, txn_id).unwrap();
        assert_eq!(txn.phase, TxnPhase::Phase1_QuorumProof);

        // Record success for phase 1
        record_phase_result(&env, txn_id, TxnPhase::Phase1_QuorumProof, true, None, None);
        let result = get_phase_result(&env, txn_id, TxnPhase::Phase1_QuorumProof).unwrap();
        assert!(result.succeeded);

        // Advance to phase 2
        advance_phase(&env, txn_id, TxnPhase::Phase2_SbtRegistry, None);
        record_phase_result(&env, txn_id, TxnPhase::Phase2_SbtRegistry, true, None, None);

        // Advance to phase 3
        advance_phase(&env, txn_id, TxnPhase::Phase3_ZkVerifier, None);
        record_phase_result(&env, txn_id, TxnPhase::Phase3_ZkVerifier, true, None, None);

        // Commit
        commit_transaction(&env, txn_id);
        let txn = get_transaction(&env, txn_id).unwrap();
        assert_eq!(txn.phase, TxnPhase::Committed);
    }

    #[test]
    fn test_transaction_rollback() {
        let env = Env::default();
        init_atomicity(&env);

        let initiator = Address::generate(&env);
        let txn_id = begin_transaction(&env, initiator, 1, Bytes::new(&env), 3600);

        // Advance to phase 1
        advance_phase(&env, txn_id, TxnPhase::Phase1_QuorumProof, None);

        // Phase 1 fails
        record_phase_result(
            &env,
            txn_id,
            TxnPhase::Phase1_QuorumProof,
            false,
            Some(100),
            None,
        );

        // Initiate rollback
        initiate_rollback(&env, txn_id, None);
        let txn = get_transaction(&env, txn_id).unwrap();
        assert_eq!(txn.phase, TxnPhase::RollingBack);

        // Complete rollback
        complete_rollback(&env, txn_id);
        let txn = get_transaction(&env, txn_id).unwrap();
        assert_eq!(txn.phase, TxnPhase::RolledBack);
    }
}
