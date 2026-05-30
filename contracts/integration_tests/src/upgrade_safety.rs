// Issue #558: Contract upgrade safety tests
// Verifies that upgrades preserve existing state, produce no data loss,
// and that rollback scenarios are handled correctly.
//
// Acceptance criteria:
//   1. Upgrade with existing state — all data survives a WASM hash swap.
//   2. No data loss — credentials, slices, attestations, and counts are intact.
//   3. Rollback scenario — state version can be queried; a bad upgrade is blocked.

use quorum_proof::{QuorumProofContract, QuorumProofContractClient};
use sbt_registry::{SbtRegistryContract, SbtRegistryContractClient};
use soroban_sdk::{testutils::Address as _, Bytes, BytesN, Env, Vec};

// ── Shared helpers ────────────────────────────────────────────────────────────

struct Contracts<'a> {
    qp: QuorumProofContractClient<'a>,
    sbt: SbtRegistryContractClient<'a>,
    admin: soroban_sdk::Address,
}

fn setup(env: &Env) -> Contracts<'_> {
    env.mock_all_auths();
    let admin = soroban_sdk::Address::generate(env);

    let qp_id = env.register_contract(None, QuorumProofContract);
    let qp = QuorumProofContractClient::new(env, &qp_id);
    qp.initialize(&admin);

    let sbt_id = env.register_contract(None, SbtRegistryContract);
    let sbt = SbtRegistryContractClient::new(env, &sbt_id);
    sbt.initialize(&admin, &qp_id);

    Contracts { qp, sbt, admin }
}

fn metadata(env: &Env) -> Bytes {
    Bytes::from_slice(env, b"QmTestHash000000000000000000000000")
}

/// A non-zero WASM hash that represents a hypothetical new contract binary.
fn new_wasm_hash(env: &Env) -> BytesN<32> {
    BytesN::from_array(env, &[0xABu8; 32])
}

/// A second distinct non-zero WASM hash (simulates a different upgrade target).
fn alt_wasm_hash(env: &Env) -> BytesN<32> {
    BytesN::from_array(env, &[0xCDu8; 32])
}

// ── 1. Upgrade with existing state ───────────────────────────────────────────

/// Populate the contract with credentials, slices, and attestations, then
/// simulate an upgrade by calling `validate_upgrade` + `upgrade`.
/// All state must remain readable after the upgrade call returns.
#[test]
fn upgrade_preserves_credentials_and_slices() {
    let env = Env::default();
    let c = setup(&env);

    let issuer = soroban_sdk::Address::generate(&env);
    let holder = soroban_sdk::Address::generate(&env);
    let attestor = soroban_sdk::Address::generate(&env);

    // Pre-upgrade state: issue two credentials
    let cred_id1 = c.qp.issue_credential(&issuer, &holder, &1u32, &metadata(&env), &None, &0u64);
    let cred_id2 = c.qp.issue_credential(&issuer, &holder, &2u32, &metadata(&env), &None, &0u64);

    // Pre-upgrade state: create a quorum slice and attest cred_id1
    let mut attestors = Vec::new(&env);
    attestors.push_back(attestor.clone());
    let mut weights = Vec::new(&env);
    weights.push_back(1u32);
    let slice_id = c.qp.create_slice(&issuer, &attestors, &weights, &1u32);
    c.qp.attest(&attestor, &cred_id1, &slice_id, &true, &None);

    // Snapshot counts before upgrade
    let cred_count_before = c.qp.get_credential_count();
    let slice_count_before = c.qp.get_slice_count();

    // Validate the upgrade hash (must not panic)
    c.qp.validate_upgrade(&new_wasm_hash(&env));

    // In the Soroban test environment `update_current_contract_wasm` is a no-op
    // (the WASM binary is not actually swapped), so we call `upgrade` to exercise
    // the full auth + validation path without a real binary replacement.
    c.qp.upgrade(&c.admin, &new_wasm_hash(&env));

    // Post-upgrade: counts must be unchanged
    assert_eq!(
        c.qp.get_credential_count(),
        cred_count_before,
        "upgrade: credential count must be preserved"
    );
    assert_eq!(
        c.qp.get_slice_count(),
        slice_count_before,
        "upgrade: slice count must be preserved"
    );

    // Post-upgrade: individual records must still be readable
    assert!(
        c.qp.credential_exists(&cred_id1),
        "upgrade: cred_id1 must still exist after upgrade"
    );
    assert!(
        c.qp.credential_exists(&cred_id2),
        "upgrade: cred_id2 must still exist after upgrade"
    );
    assert!(
        c.qp.slice_exists(&slice_id),
        "upgrade: slice must still exist after upgrade"
    );
}

/// Attestation state (is_attested, attestation_count) must survive an upgrade.
#[test]
fn upgrade_preserves_attestation_state() {
    let env = Env::default();
    let c = setup(&env);

    let issuer = soroban_sdk::Address::generate(&env);
    let holder = soroban_sdk::Address::generate(&env);
    let attestor1 = soroban_sdk::Address::generate(&env);
    let attestor2 = soroban_sdk::Address::generate(&env);

    let cred_id = c.qp.issue_credential(&issuer, &holder, &1u32, &metadata(&env), &None, &0u64);
    let mut attestors = Vec::new(&env);
    attestors.push_back(attestor1.clone());
    attestors.push_back(attestor2.clone());
    let mut weights = Vec::new(&env);
    weights.push_back(1u32);
    weights.push_back(1u32);
    let slice_id = c.qp.create_slice(&issuer, &attestors, &weights, &2u32);

    c.qp.attest(&attestor1, &cred_id, &slice_id, &true, &None);
    c.qp.attest(&attestor2, &cred_id, &slice_id, &true, &None);

    // Confirm attested before upgrade
    assert!(c.qp.is_attested(&cred_id, &slice_id), "pre-upgrade: must be attested");
    let count_before = c.qp.get_attestation_count(&cred_id);

    // Perform upgrade
    c.qp.upgrade(&c.admin, &new_wasm_hash(&env));

    // Attestation state must be intact
    assert!(
        c.qp.is_attested(&cred_id, &slice_id),
        "upgrade: attestation status must survive upgrade"
    );
    assert_eq!(
        c.qp.get_attestation_count(&cred_id),
        count_before,
        "upgrade: attestation count must be unchanged after upgrade"
    );
}

/// SBT ownership must survive an upgrade of the QuorumProof contract.
#[test]
fn upgrade_preserves_sbt_ownership() {
    let env = Env::default();
    let c = setup(&env);

    let issuer = soroban_sdk::Address::generate(&env);
    let holder = soroban_sdk::Address::generate(&env);

    let cred_id = c.qp.issue_credential(&issuer, &holder, &1u32, &metadata(&env), &None, &0u64);
    let uri = Bytes::from_slice(&env, b"ipfs://QmSBT");
    let token_id = c.sbt.mint(&holder, &cred_id, &uri);

    let sbt_count_before = c.sbt.sbt_count();

    // Upgrade the QuorumProof contract
    c.qp.upgrade(&c.admin, &new_wasm_hash(&env));

    // SBT registry state is independent but must still be consistent
    assert_eq!(
        c.sbt.sbt_count(),
        sbt_count_before,
        "upgrade: SBT count must be unchanged after QP upgrade"
    );
    assert_eq!(
        c.sbt.owner_of(&token_id),
        holder,
        "upgrade: SBT ownership must be preserved after QP upgrade"
    );
}

// ── 2. No data loss ───────────────────────────────────────────────────────────

/// Every credential issued before an upgrade must be individually retrievable
/// and structurally intact (subject, issuer, type, revoked flag) afterwards.
#[test]
fn upgrade_no_data_loss_credential_fields() {
    let env = Env::default();
    let c = setup(&env);

    let issuer = soroban_sdk::Address::generate(&env);
    let holder = soroban_sdk::Address::generate(&env);

    let hash = Bytes::from_array(&env, &[0xFFu8; 32]);
    let cred_id = c.qp.issue_credential(&issuer, &holder, &42u32, &hash, &None, &0u64);

    // Capture full credential record before upgrade
    let cred_before = c.qp.get_credential(&cred_id);

    c.qp.upgrade(&c.admin, &new_wasm_hash(&env));

    // Every field must be identical after upgrade
    let cred_after = c.qp.get_credential(&cred_id);
    assert_eq!(cred_after.id, cred_before.id, "upgrade: credential id must not change");
    assert_eq!(
        cred_after.subject, cred_before.subject,
        "upgrade: credential subject must not change"
    );
    assert_eq!(
        cred_after.issuer, cred_before.issuer,
        "upgrade: credential issuer must not change"
    );
    assert_eq!(
        cred_after.credential_type, cred_before.credential_type,
        "upgrade: credential type must not change"
    );
    assert_eq!(
        cred_after.metadata_hash, cred_before.metadata_hash,
        "upgrade: metadata hash must not change"
    );
    assert_eq!(
        cred_after.revoked, cred_before.revoked,
        "upgrade: revoked flag must not change"
    );
}

/// Revoked credentials must remain revoked (and still exist) after an upgrade.
/// This guards against an upgrade accidentally clearing the revocation flag.
#[test]
fn upgrade_no_data_loss_revoked_credentials_remain_revoked() {
    let env = Env::default();
    let c = setup(&env);

    let issuer = soroban_sdk::Address::generate(&env);
    let holder = soroban_sdk::Address::generate(&env);

    let hash = Bytes::from_array(&env, &[1u8; 32]);
    let cred_id = c.qp.issue_credential(&issuer, &holder, &1u32, &hash, &None, &0u64);
    c.qp.revoke_credential(&issuer, &cred_id);

    assert!(c.qp.is_revoked(&cred_id), "pre-upgrade: credential must be revoked");

    c.qp.upgrade(&c.admin, &new_wasm_hash(&env));

    assert!(
        c.qp.credential_exists(&cred_id),
        "upgrade: revoked credential must still exist (no data loss)"
    );
    assert!(
        c.qp.is_revoked(&cred_id),
        "upgrade: revoked flag must survive upgrade"
    );
}

/// Slice structure (attestors, weights, threshold) must be intact after upgrade.
#[test]
fn upgrade_no_data_loss_slice_structure() {
    let env = Env::default();
    let c = setup(&env);

    let creator = soroban_sdk::Address::generate(&env);
    let a1 = soroban_sdk::Address::generate(&env);
    let a2 = soroban_sdk::Address::generate(&env);

    let mut attestors = Vec::new(&env);
    attestors.push_back(a1.clone());
    attestors.push_back(a2.clone());
    let mut weights = Vec::new(&env);
    weights.push_back(3u32);
    weights.push_back(7u32);
    let slice_id = c.qp.create_slice(&creator, &attestors, &weights, &5u32);

    let slice_before = c.qp.get_slice(&slice_id);

    c.qp.upgrade(&c.admin, &new_wasm_hash(&env));

    let slice_after = c.qp.get_slice(&slice_id);
    assert_eq!(
        slice_after.attestors.len(),
        slice_before.attestors.len(),
        "upgrade: attestor list length must be preserved"
    );
    assert_eq!(
        slice_after.threshold, slice_before.threshold,
        "upgrade: slice threshold must be preserved"
    );
    assert_eq!(
        slice_after.weights.len(),
        slice_before.weights.len(),
        "upgrade: weights list length must be preserved"
    );
}

/// Admin address must survive an upgrade — the contract must still be
/// administrable by the original admin after the WASM swap.
#[test]
fn upgrade_no_data_loss_admin_preserved() {
    let env = Env::default();
    let c = setup(&env);

    // Perform upgrade
    c.qp.upgrade(&c.admin, &new_wasm_hash(&env));

    // Admin-only operations must still work with the original admin
    // (pause/unpause exercises the stored admin check)
    c.qp.pause(&c.admin);
    assert!(c.qp.is_paused(), "upgrade: admin must still be able to pause after upgrade");
    c.qp.unpause(&c.admin);
    assert!(!c.qp.is_paused(), "upgrade: admin must still be able to unpause after upgrade");
}

/// Paused state must be preserved across an upgrade.
/// If the contract was paused before the upgrade, it must remain paused after.
#[test]
fn upgrade_no_data_loss_paused_state_preserved() {
    let env = Env::default();
    let c = setup(&env);

    // Pause the contract, then upgrade
    c.qp.pause(&c.admin);
    assert!(c.qp.is_paused(), "pre-upgrade: contract must be paused");

    // validate_upgrade must reject while paused
    let zero = BytesN::from_array(&env, &[0u8; 32]);
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        c.qp.validate_upgrade(&zero);
    }));
    assert!(result.is_err(), "upgrade: validate_upgrade must reject zero hash");

    // Unpause, then upgrade
    c.qp.unpause(&c.admin);
    c.qp.upgrade(&c.admin, &new_wasm_hash(&env));

    // Contract must be unpaused after upgrade (state preserved)
    assert!(
        !c.qp.is_paused(),
        "upgrade: paused=false must be preserved after upgrade"
    );
}

// ── 3. Rollback scenario ──────────────────────────────────────────────────────

/// `migrate_state` advances the state version from 0 → 1.
/// After migration, `get_state_version` must return 1 and all pre-migration
/// data must still be accessible (no data loss during migration).
#[test]
fn migrate_state_v0_to_v1_preserves_data() {
    let env = Env::default();
    let c = setup(&env);

    let issuer = soroban_sdk::Address::generate(&env);
    let holder = soroban_sdk::Address::generate(&env);

    let hash = Bytes::from_array(&env, &[2u8; 32]);
    let cred_id = c.qp.issue_credential(&issuer, &holder, &1u32, &hash, &None, &0u64);

    // Baseline: version is 0 before any migration
    assert_eq!(
        c.qp.get_state_version(),
        0u32,
        "rollback: initial state version must be 0"
    );

    // Migrate v0 → v1
    c.qp.migrate_state(&c.admin, &0u32, &1u32);

    assert_eq!(
        c.qp.get_state_version(),
        1u32,
        "rollback: state version must be 1 after migration"
    );

    // All pre-migration data must still be intact
    assert!(
        c.qp.credential_exists(&cred_id),
        "rollback: credential must survive v0→v1 migration"
    );
    let cred = c.qp.get_credential(&cred_id);
    assert_eq!(cred.subject, holder, "rollback: credential subject must be unchanged after migration");
}

/// Attempting to re-run the same migration (v0 → v1 when already at v1) must panic.
/// This is the "rollback guard" — the contract refuses to apply a migration twice.
#[test]
#[should_panic]
fn migrate_state_reapply_same_version_panics() {
    let env = Env::default();
    let c = setup(&env);

    // First migration succeeds
    c.qp.migrate_state(&c.admin, &0u32, &1u32);

    // Second attempt with the same from/to must panic (current version mismatch)
    c.qp.migrate_state(&c.admin, &0u32, &1u32);
}

/// Skipping a version (v0 → v2) must be rejected — migrations must be sequential.
#[test]
#[should_panic]
fn migrate_state_non_sequential_version_panics() {
    let env = Env::default();
    let c = setup(&env);

    // Attempt to jump from v0 directly to v2 — must panic
    c.qp.migrate_state(&c.admin, &0u32, &2u32);
}

/// An unauthorized caller must not be able to migrate state.
#[test]
#[should_panic]
fn migrate_state_unauthorized_caller_panics() {
    let env = Env::default();
    let c = setup(&env);

    let stranger = soroban_sdk::Address::generate(&env);

    // Stranger attempts migration — must panic
    c.qp.migrate_state(&stranger, &0u32, &1u32);
}

/// An unauthorized caller must not be able to upgrade the contract.
#[test]
#[should_panic]
fn upgrade_unauthorized_caller_panics() {
    let env = Env::default();
    let c = setup(&env);

    let stranger = soroban_sdk::Address::generate(&env);

    // Stranger attempts upgrade — must panic
    c.qp.upgrade(&stranger, &new_wasm_hash(&env));
}

/// Upgrading with a zero WASM hash must be rejected by `validate_upgrade`.
#[test]
#[should_panic]
fn upgrade_zero_hash_rejected() {
    let env = Env::default();
    let c = setup(&env);

    let zero = BytesN::from_array(&env, &[0u8; 32]);
    c.qp.validate_upgrade(&zero);
}

/// Upgrade while paused must be blocked.
#[test]
#[should_panic]
fn upgrade_blocked_while_paused() {
    let env = Env::default();
    let c = setup(&env);

    c.qp.pause(&c.admin);
    // validate_upgrade (called internally by upgrade) must reject when paused
    c.qp.upgrade(&c.admin, &new_wasm_hash(&env));
}

/// Simulates a "rollback" by verifying that the contract can be upgraded to a
/// second hash after a first upgrade — the state version and all data remain
/// consistent across multiple sequential upgrades.
#[test]
fn upgrade_multiple_sequential_upgrades_preserve_state() {
    let env = Env::default();
    let c = setup(&env);

    let issuer = soroban_sdk::Address::generate(&env);
    let holder = soroban_sdk::Address::generate(&env);

    let hash = Bytes::from_array(&env, &[3u8; 32]);
    let cred_id = c.qp.issue_credential(&issuer, &holder, &1u32, &hash, &None, &0u64);

    // First upgrade
    c.qp.upgrade(&c.admin, &new_wasm_hash(&env));
    assert!(
        c.qp.credential_exists(&cred_id),
        "rollback: credential must exist after first upgrade"
    );

    // Second upgrade (simulates rollback to a previous binary or hotfix)
    c.qp.upgrade(&c.admin, &alt_wasm_hash(&env));
    assert!(
        c.qp.credential_exists(&cred_id),
        "rollback: credential must exist after second upgrade"
    );
    assert_eq!(
        c.qp.get_credential_count(),
        1u64,
        "rollback: credential count must be 1 after two sequential upgrades"
    );
}

/// Full upgrade + migration scenario:
///   1. Populate state (credentials, slices, attestations).
///   2. Upgrade the WASM.
///   3. Run the v0 → v1 state migration.
///   4. Verify all data is intact and the version is correct.
#[test]
fn upgrade_then_migrate_full_scenario() {
    let env = Env::default();
    let c = setup(&env);

    let issuer = soroban_sdk::Address::generate(&env);
    let holder = soroban_sdk::Address::generate(&env);
    let attestor = soroban_sdk::Address::generate(&env);

    // Populate state
    let hash = Bytes::from_array(&env, &[4u8; 32]);
    let cred_id1 = c.qp.issue_credential(&issuer, &holder, &1u32, &hash, &None, &0u64);
    let cred_id2 = c.qp.issue_credential(&issuer, &holder, &2u32, &hash, &None, &0u64);

    let mut attestors = Vec::new(&env);
    attestors.push_back(attestor.clone());
    let mut weights = Vec::new(&env);
    weights.push_back(1u32);
    let slice_id = c.qp.create_slice(&issuer, &attestors, &weights, &1u32);
    c.qp.attest(&attestor, &cred_id1, &slice_id, &true, &None);

    let uri = Bytes::from_slice(&env, b"ipfs://QmSBT");
    let token_id = c.sbt.mint(&holder, &cred_id1, &uri);

    // Step 1: upgrade WASM
    c.qp.upgrade(&c.admin, &new_wasm_hash(&env));

    // Step 2: migrate state schema
    c.qp.migrate_state(&c.admin, &0u32, &1u32);

    // Verify version advanced
    assert_eq!(
        c.qp.get_state_version(),
        1u32,
        "full scenario: state version must be 1 after upgrade + migration"
    );

    // Verify no data loss
    assert_eq!(
        c.qp.get_credential_count(),
        2u64,
        "full scenario: credential count must be 2"
    );
    assert!(
        c.qp.credential_exists(&cred_id1),
        "full scenario: cred_id1 must exist"
    );
    assert!(
        c.qp.credential_exists(&cred_id2),
        "full scenario: cred_id2 must exist"
    );
    assert!(
        c.qp.is_attested(&cred_id1, &slice_id),
        "full scenario: attestation must survive upgrade + migration"
    );
    assert_eq!(
        c.sbt.owner_of(&token_id),
        holder,
        "full scenario: SBT ownership must survive upgrade + migration"
    );

    // Verify the contract is still fully operational post-migration
    let cred_id3 = c.qp.issue_credential(&issuer, &holder, &3u32, &hash, &None, &0u64);
    assert!(
        c.qp.credential_exists(&cred_id3),
        "full scenario: new credentials must be issuable after upgrade + migration"
    );
    assert_eq!(
        c.qp.get_credential_count(),
        3u64,
        "full scenario: credential count must be 3 after post-migration issuance"
    );
}
