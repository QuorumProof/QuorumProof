//! Tests for Issue #910, #913, #915
//! - #910: Attestation Veto by Trusted Third Party
//! - #913: Cross-Contract Atomic Operations
//! - #915: Contract Version Migration Path

#![cfg(test)]

use crate::{
    QuorumProofContract, QuorumProofContractClient,
    attestation_veto, atomic_operations, migration_v2,
};
use soroban_sdk::{Address, Env};

// ─────────────────────────────────────────────────────────────────────────────
// Issue #910: Attestation Veto Tests
// ─────────────────────────────────────────────────────────────────────────────

#[test]
fn test_veto_request_lifecycle_910() {
    let env = Env::default();
    env.mock_all_auths();
    
    let admin = Address::generate(&env);
    let veto_auth = Address::generate(&env);
    let attestor = Address::generate(&env);
    
    let client = QuorumProofContractClient::new(&env, &env.register_contract(None, QuorumProofContract));
    client.initialize(&admin);
    
    // Initialize veto authorities
    let mut authorities = soroban_sdk::Vec::new(&env);
    authorities.push_back(veto_auth.clone());
    client.init_veto_authorities(&admin, &authorities);
    
    // Request veto
    let veto_id = client.request_veto(
        &veto_auth,
        &1u64,           // credential_id
        &100u64,         // slice_id
        &attestor,
        &None,           // reason
        &None,           // evidence_hash
    );
    
    assert!(veto_id > 0);
    
    // Verify veto was created
    let veto = client.get_veto_request(&veto_id).unwrap();
    assert_eq!(veto.veto_id, veto_id);
    assert_eq!(veto.credential_id, 1);
    assert_eq!(veto.slice_id, 100);
    
    // Verify it's in credential's veto list
    let veto_requests = client.get_credential_veto_requests(&1u64);
    assert_eq!(veto_requests.len(), 1);
    assert_eq!(veto_requests.get(0).unwrap(), veto_id);
}

#[test]
fn test_veto_timelock_910() {
    let env = Env::default();
    env.mock_all_auths();
    
    let admin = Address::generate(&env);
    let client = QuorumProofContractClient::new(&env, &env.register_contract(None, QuorumProofContract));
    client.initialize(&admin);
    
    // Check default timelock
    let default_timelock = client.get_veto_timelock();
    assert_eq!(default_timelock, 172_800); // 48 hours
    
    // Set custom timelock
    client.set_veto_timelock(&admin, &86_400); // 1 day
    
    let new_timelock = client.get_veto_timelock();
    assert_eq!(new_timelock, 86_400);
}

// ─────────────────────────────────────────────────────────────────────────────
// Issue #913: Atomic Operations Tests
// ─────────────────────────────────────────────────────────────────────────────

#[test]
fn test_atomic_transaction_lifecycle_913() {
    let env = Env::default();
    env.mock_all_auths();
    
    let admin = Address::generate(&env);
    let initiator = Address::generate(&env);
    
    let client = QuorumProofContractClient::new(&env, &env.register_contract(None, QuorumProofContract));
    client.initialize(&admin);
    client.init_atomic_operations(&admin);
    
    // Begin transaction
    let op_data = soroban_sdk::Bytes::new(&env);
    let txn_id = client.begin_atomic_transaction(
        &initiator,
        &1u32,           // operation_type
        &op_data,
        &3600u64,        // timeout_seconds
    );
    
    assert!(txn_id > 0);
    
    // Verify transaction was created
    let txn = client.get_atomic_transaction(&txn_id).unwrap();
    assert_eq!(txn.txn_id, txn_id);
    assert_eq!(txn.initiator, initiator);
    assert_eq!(txn.operation_type, 1);
    
    // Verify it's active
    assert!(client.is_atomic_transaction_active(&txn_id));
    assert!(!client.is_atomic_transaction_expired(&txn_id));
}

#[test]
fn test_atomic_transaction_phases_913() {
    let env = Env::default();
    env.mock_all_auths();
    
    let admin = Address::generate(&env);
    let initiator = Address::generate(&env);
    
    let client = QuorumProofContractClient::new(&env, &env.register_contract(None, QuorumProofContract));
    client.initialize(&admin);
    client.init_atomic_operations(&admin);
    
    // Begin transaction
    let op_data = soroban_sdk::Bytes::new(&env);
    let txn_id = client.begin_atomic_transaction(
        &initiator,
        &1u32,
        &op_data,
        &3600u64,
    );
    
    // Advance to Phase 1
    client.advance_atomic_phase(&admin, &txn_id, &1u32, &None);
    let txn = client.get_atomic_transaction(&txn_id).unwrap();
    assert_eq!(txn.phase.as_u32(), 1); // Phase1_QuorumProof
    
    // Record Phase 1 result
    client.record_atomic_phase_result(&admin, &txn_id, &1u32, &true, &None, &None);
    let result = client.get_atomic_phase_result(&txn_id, &1u32).unwrap();
    assert!(result.succeeded);
    
    // Advance to Phase 2
    client.advance_atomic_phase(&admin, &txn_id, &2u32, &None);
    let txn = client.get_atomic_transaction(&txn_id).unwrap();
    assert_eq!(txn.phase.as_u32(), 2); // Phase2_SbtRegistry
    
    // Record Phase 2 result
    client.record_atomic_phase_result(&admin, &txn_id, &2u32, &true, &None, &None);
    
    // Advance to Phase 3
    client.advance_atomic_phase(&admin, &txn_id, &3u32, &None);
    
    // Record Phase 3 result
    client.record_atomic_phase_result(&admin, &txn_id, &3u32, &true, &None, &None);
    
    // Commit transaction
    client.commit_atomic_transaction(&admin, &txn_id);
    let txn = client.get_atomic_transaction(&txn_id).unwrap();
    assert_eq!(txn.phase.as_u32(), 4); // Committed
}

#[test]
fn test_atomic_transaction_rollback_913() {
    let env = Env::default();
    env.mock_all_auths();
    
    let admin = Address::generate(&env);
    let initiator = Address::generate(&env);
    
    let client = QuorumProofContractClient::new(&env, &env.register_contract(None, QuorumProofContract));
    client.initialize(&admin);
    client.init_atomic_operations(&admin);
    
    // Begin transaction
    let op_data = soroban_sdk::Bytes::new(&env);
    let txn_id = client.begin_atomic_transaction(
        &initiator,
        &1u32,
        &op_data,
        &3600u64,
    );
    
    // Advance to Phase 1
    client.advance_atomic_phase(&admin, &txn_id, &1u32, &None);
    
    // Record failure
    client.record_atomic_phase_result(&admin, &txn_id, &1u32, &false, &Some(100), &None);
    
    // Initiate rollback
    client.initiate_atomic_rollback(&admin, &txn_id, &None);
    let txn = client.get_atomic_transaction(&txn_id).unwrap();
    assert_eq!(txn.phase.as_u32(), 5); // RollingBack
    
    // Complete rollback
    client.complete_atomic_rollback(&admin, &txn_id);
    let txn = client.get_atomic_transaction(&txn_id).unwrap();
    assert_eq!(txn.phase.as_u32(), 6); // RolledBack
    
    // Verify transaction is no longer active
    assert!(!client.is_atomic_transaction_active(&txn_id));
}

// ─────────────────────────────────────────────────────────────────────────────
// Issue #915: Migration Path Tests
// ─────────────────────────────────────────────────────────────────────────────

#[test]
fn test_schema_version_management_915() {
    let env = Env::default();
    env.mock_all_auths();
    
    let admin = Address::generate(&env);
    
    let client = QuorumProofContractClient::new(&env, &env.register_contract(None, QuorumProofContract));
    client.initialize(&admin);
    client.init_migration_v2(&admin);
    
    // Check initial schema version
    let version = client.get_schema_version();
    assert_eq!(version, 1); // V1
}

#[test]
fn test_migration_status_915() {
    let env = Env::default();
    env.mock_all_auths();
    
    let admin = Address::generate(&env);
    
    let client = QuorumProofContractClient::new(&env, &env.register_contract(None, QuorumProofContract));
    client.initialize(&admin);
    client.init_migration_v2(&admin);
    
    // Start migration
    let job_id = client.start_migration_v1_to_v2(&admin);
    assert!(job_id > 0);
    
    // Check migration status
    let status = client.get_migration_status().unwrap();
    assert_eq!(status.from_version.as_u32(), 1);
    assert_eq!(status.to_version.as_u32(), 2);
    assert_eq!(status.status.as_u32(), 1); // InProgress
}

#[test]
fn test_migration_pause_resume_915() {
    let env = Env::default();
    env.mock_all_auths();
    
    let admin = Address::generate(&env);
    
    let client = QuorumProofContractClient::new(&env, &env.register_contract(None, QuorumProofContract));
    client.initialize(&admin);
    client.init_migration_v2(&admin);
    
    // Start migration
    client.start_migration_v1_to_v2(&admin);
    
    // Pause migration
    client.pause_migration(&admin);
    let status = client.get_migration_status().unwrap();
    assert_eq!(status.status.as_u32(), 2); // Paused
    
    // Resume migration
    client.resume_migration(&admin);
    let status = client.get_migration_status().unwrap();
    assert_eq!(status.status.as_u32(), 1); // InProgress again
}

// Extension trait implementations for the new types
// These allow the test code to access fields and methods

impl atomic_operations::TxnPhase {
    fn as_u32(self) -> u32 {
        match self {
            atomic_operations::TxnPhase::Initialized => 0,
            atomic_operations::TxnPhase::Phase1_QuorumProof => 1,
            atomic_operations::TxnPhase::Phase2_SbtRegistry => 2,
            atomic_operations::TxnPhase::Phase3_ZkVerifier => 3,
            atomic_operations::TxnPhase::Committed => 4,
            atomic_operations::TxnPhase::RollingBack => 5,
            atomic_operations::TxnPhase::RolledBack => 6,
        }
    }
}

impl migration_v2::SchemaVersion {
    fn as_u32(self) -> u32 {
        match self {
            migration_v2::SchemaVersion::V1 => 1,
            migration_v2::SchemaVersion::V2 => 2,
        }
    }
}

impl migration_v2::MigrationStatus {
    fn as_u32(self) -> u32 {
        match self {
            migration_v2::MigrationStatus::NotStarted => 0,
            migration_v2::MigrationStatus::InProgress => 1,
            migration_v2::MigrationStatus::Paused => 2,
            migration_v2::MigrationStatus::Completed => 3,
            migration_v2::MigrationStatus::Failed => 4,
        }
    }
}
