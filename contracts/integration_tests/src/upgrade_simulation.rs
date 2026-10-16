// Issue #1630: Contract upgrade simulation and state-compatibility tests
//
// Complements upgrade_safety.rs (#558) and contract_upgrade_testing.rs (#579)
// with a snapshot-based code-swap simulation and full state comparison.
//
// Simulates an in-place contract upgrade and verifies that:
//   * every piece of pre-upgrade state is still readable and unchanged after
//     the code swap (state compatibility),
//   * the state-schema migration path (`migrate_state`) is sequential,
//     admin-only and idempotent-safe,
//   * the upgrade entrypoints refuse unsafe upgrades (non-admin caller,
//     all-zero WASM hash, paused contract).
//
// The code swap is simulated by snapshotting the ledger, rebuilding an `Env`
// from that snapshot and re-registering the contract code at the *same*
// address. That is exactly what `update_current_contract_wasm` does on-chain:
// the contract address and its storage are kept, only the executable changes.
//
// See docs/upgrade-testing.md and docs/adr/adr-011-state-versioning-and-upgrades.md.

use quorum_proof::{QuorumProofContract, QuorumProofContractClient};
use sbt_registry::{SbtRegistryContract, SbtRegistryContractClient};
use soroban_sdk::{testutils::Address as _, Address, Bytes, BytesN, Env, Vec};
use zk_verifier::{ZkVerifierContract, ZkVerifierContractClient};

/// Everything observable about the contract state before an upgrade.
/// Compared field-by-field after the upgrade.
struct StateSnapshot {
    credential_count: u64,
    slice_count: u64,
    state_version: u32,
    paused: bool,
    credentials: std::vec::Vec<CredentialView>,
    slices: std::vec::Vec<SliceView>,
    attested: std::vec::Vec<(u64, u64, bool)>,
    subject_credentials: std::vec::Vec<u64>,
}

#[derive(Debug, PartialEq)]
struct CredentialView {
    id: u64,
    subject: Address,
    issuer: Address,
    credential_type: u32,
    metadata_hash: Bytes,
    revoked: bool,
    expires_at: Option<u64>,
    attestors: std::vec::Vec<Address>,
}

#[derive(Debug, PartialEq)]
struct SliceView {
    id: u64,
    creator: Address,
    attestors: std::vec::Vec<Address>,
    weights: std::vec::Vec<u32>,
    threshold: u32,
}

struct Fixture {
    qp_id: Address,
    admin: Address,
    subject: Address,
    credential_ids: std::vec::Vec<u64>,
    slice_ids: std::vec::Vec<u64>,
}

fn metadata(env: &Env, n: u8) -> Bytes {
    let mut raw = *b"QmUpgradeSafetyHash00000000000000";
    raw[raw.len() - 1] = b'0' + (n % 10);
    Bytes::from_slice(env, &raw)
}

fn to_std<T: soroban_sdk::TryFromVal<Env, soroban_sdk::Val> + soroban_sdk::IntoVal<Env, soroban_sdk::Val> + Clone>(
    v: &Vec<T>,
) -> std::vec::Vec<T> {
    v.iter().collect()
}

/// Populate a QuorumProof instance with a representative mix of state:
/// active, revoked and expiring credentials, several slices and attestations.
fn populate(env: &Env) -> Fixture {
    env.mock_all_auths();
    let admin = Address::generate(env);
    let issuer = Address::generate(env);
    let subject = Address::generate(env);
    let a1 = Address::generate(env);
    let a2 = Address::generate(env);
    let a3 = Address::generate(env);

    let qp_id = env.register_contract(None, QuorumProofContract);
    let qp = QuorumProofContractClient::new(env, &qp_id);
    qp.initialize(&admin);

    let mut slice_ids = std::vec::Vec::new();
    let mut attestors = Vec::new(env);
    attestors.push_back(a1.clone());
    attestors.push_back(a2.clone());
    let mut weights = Vec::new(env);
    weights.push_back(1u32);
    weights.push_back(1u32);
    slice_ids.push(qp.create_slice(&subject, &attestors, &weights, &2u32));

    let mut attestors_w = Vec::new(env);
    attestors_w.push_back(a1.clone());
    attestors_w.push_back(a2.clone());
    attestors_w.push_back(a3.clone());
    let mut weights_w = Vec::new(env);
    weights_w.push_back(2u32);
    weights_w.push_back(1u32);
    weights_w.push_back(1u32);
    slice_ids.push(qp.create_slice(&subject, &attestors_w, &weights_w, &3u32));

    let mut credential_ids = std::vec::Vec::new();
    for i in 0..4u8 {
        let expires = if i == 3 { Some(env.ledger().timestamp() + 1_000_000) } else { None };
        credential_ids.push(qp.issue_credential(
            &issuer,
            &subject,
            &(1u32 + (i as u32 % 2)),
            &metadata(env, i),
            &expires,
            &(i as u64),
        ));
    }

    // Fully attest credential 0 on slice 0, partially attest credential 1 on slice 1.
    qp.attest(&a1, &credential_ids[0], &slice_ids[0], &true, &None);
    qp.attest(&a2, &credential_ids[0], &slice_ids[0], &true, &None);
    qp.attest(&a1, &credential_ids[1], &slice_ids[1], &true, &None);

    // Revoke credential 2 so revoked state is covered.
    qp.revoke_credential(&issuer, &credential_ids[2], &None);

    Fixture { qp_id, admin, subject, credential_ids, slice_ids }
}

fn capture(env: &Env, fx: &Fixture) -> StateSnapshot {
    let qp = QuorumProofContractClient::new(env, &fx.qp_id);

    let credentials = fx
        .credential_ids
        .iter()
        .map(|id| {
            let c = qp.get_credential(id);
            CredentialView {
                id: c.id,
                subject: c.subject,
                issuer: c.issuer,
                credential_type: c.credential_type,
                metadata_hash: c.metadata_hash,
                revoked: c.revoked,
                expires_at: c.expires_at,
                attestors: to_std(&qp.get_attestors(id)),
            }
        })
        .collect();

    let slices = fx
        .slice_ids
        .iter()
        .map(|id| {
            let s = qp.get_slice(id);
            SliceView {
                id: s.id,
                creator: s.creator,
                attestors: to_std(&s.attestors),
                weights: to_std(&s.weights),
                threshold: s.threshold,
            }
        })
        .collect();

    let mut attested = std::vec::Vec::new();
    for c in &fx.credential_ids {
        for s in &fx.slice_ids {
            attested.push((*c, *s, qp.is_attested(c, s)));
        }
    }

    StateSnapshot {
        credential_count: qp.get_credential_count(),
        slice_count: qp.get_slice_count(),
        state_version: qp.get_state_version(),
        paused: qp.is_paused(),
        credentials,
        slices,
        attested,
        subject_credentials: to_std(&qp.get_credentials_by_subject(&fx.subject, &1u32, &50u32)),
    }
}

fn assert_state_compatible(before: &StateSnapshot, after: &StateSnapshot) {
    assert_eq!(before.credential_count, after.credential_count, "credential count changed across upgrade");
    assert_eq!(before.slice_count, after.slice_count, "slice count changed across upgrade");
    assert_eq!(before.paused, after.paused, "pause flag changed across upgrade");
    assert_eq!(before.credentials, after.credentials, "credential data changed across upgrade");
    assert_eq!(before.slices, after.slices, "slice data changed across upgrade");
    assert_eq!(before.attested, after.attested, "attestation results changed across upgrade");
    assert_eq!(
        before.subject_credentials, after.subject_credentials,
        "subject credential index changed across upgrade"
    );
}

/// Simulate an in-place code swap: carry the ledger over into a fresh `Env`
/// and re-register the contract code at the same address.
fn simulate_code_swap(env: &Env, qp_id: &Address) -> Env {
    let snapshot = env.to_snapshot();
    let upgraded = Env::from_snapshot(snapshot);
    upgraded.mock_all_auths();
    upgraded.register_contract(Some(qp_id), QuorumProofContract);
    upgraded
}

// ── Upgrade simulation ──────────────────────────────────────────────────────

#[test]
fn upgrade_simulation_preserves_all_state() {
    let env = Env::default();
    let fx = populate(&env);
    let before = capture(&env, &fx);

    let upgraded = simulate_code_swap(&env, &fx.qp_id);
    let after = capture(&upgraded, &fx);

    assert_state_compatible(&before, &after);
    assert_eq!(before.state_version, after.state_version);
}

#[test]
fn upgrade_simulation_then_migration_preserves_state() {
    let env = Env::default();
    let fx = populate(&env);
    let before = capture(&env, &fx);
    assert_eq!(before.state_version, 0, "fresh deployments start at schema v0");

    let upgraded = simulate_code_swap(&env, &fx.qp_id);
    let qp = QuorumProofContractClient::new(&upgraded, &fx.qp_id);
    qp.migrate_state(&fx.admin, &0u32, &1u32);

    let after = capture(&upgraded, &fx);
    assert_state_compatible(&before, &after);
    assert_eq!(after.state_version, 1);
}

#[test]
fn contract_remains_writable_after_upgrade() {
    let env = Env::default();
    let fx = populate(&env);
    let upgraded = simulate_code_swap(&env, &fx.qp_id);
    let qp = QuorumProofContractClient::new(&upgraded, &fx.qp_id);

    let issuer = Address::generate(&upgraded);
    let count_before = qp.get_credential_count();
    let new_id = qp.issue_credential(&issuer, &fx.subject, &1u32, &metadata(&upgraded, 9), &None, &99u64);

    assert_eq!(qp.get_credential_count(), count_before + 1);
    assert!(!fx.credential_ids.contains(&new_id), "post-upgrade id collides with pre-upgrade id");
    assert_eq!(qp.get_credential(&new_id).issuer, issuer);
}

#[test]
fn repeated_upgrades_preserve_state() {
    let env = Env::default();
    let fx = populate(&env);
    let before = capture(&env, &fx);

    let mut current = env;
    for _ in 0..3 {
        current = simulate_code_swap(&current, &fx.qp_id);
    }
    assert_state_compatible(&before, &capture(&current, &fx));
}

// ── State compatibility / migration checks ──────────────────────────────────

#[test]
#[should_panic(expected = "versions must be sequential")]
fn migration_rejects_version_skip() {
    let env = Env::default();
    let fx = populate(&env);
    QuorumProofContractClient::new(&env, &fx.qp_id).migrate_state(&fx.admin, &0u32, &2u32);
}

#[test]
#[should_panic(expected = "current version mismatch")]
fn migration_rejects_replay() {
    let env = Env::default();
    let fx = populate(&env);
    let qp = QuorumProofContractClient::new(&env, &fx.qp_id);
    qp.migrate_state(&fx.admin, &0u32, &1u32);
    qp.migrate_state(&fx.admin, &0u32, &1u32);
}

#[test]
#[should_panic(expected = "unauthorized")]
fn migration_rejects_non_admin() {
    let env = Env::default();
    let fx = populate(&env);
    let attacker = Address::generate(&env);
    QuorumProofContractClient::new(&env, &fx.qp_id).migrate_state(&attacker, &0u32, &1u32);
}

#[test]
#[should_panic(expected = "no migration defined for this version")]
fn migration_rejects_undefined_version() {
    let env = Env::default();
    let fx = populate(&env);
    let qp = QuorumProofContractClient::new(&env, &fx.qp_id);
    qp.migrate_state(&fx.admin, &0u32, &1u32);
    qp.migrate_state(&fx.admin, &1u32, &2u32);
}

// ── Upgrade guard rails ─────────────────────────────────────────────────────

#[test]
fn validate_upgrade_accepts_nonzero_hash_when_unpaused() {
    let env = Env::default();
    let fx = populate(&env);
    let qp = QuorumProofContractClient::new(&env, &fx.qp_id);
    qp.validate_upgrade(&BytesN::from_array(&env, &[7u8; 32]));
}

#[test]
#[should_panic]
fn validate_upgrade_rejects_zero_hash() {
    let env = Env::default();
    let fx = populate(&env);
    let qp = QuorumProofContractClient::new(&env, &fx.qp_id);
    qp.validate_upgrade(&BytesN::from_array(&env, &[0u8; 32]));
}

#[test]
#[should_panic]
fn validate_upgrade_rejects_when_paused() {
    let env = Env::default();
    let fx = populate(&env);
    let qp = QuorumProofContractClient::new(&env, &fx.qp_id);
    qp.pause(&fx.admin);
    qp.validate_upgrade(&BytesN::from_array(&env, &[7u8; 32]));
}

#[test]
#[should_panic(expected = "unauthorized")]
fn quorum_proof_upgrade_rejects_non_admin() {
    let env = Env::default();
    let fx = populate(&env);
    let attacker = Address::generate(&env);
    QuorumProofContractClient::new(&env, &fx.qp_id)
        .upgrade(&attacker, &BytesN::from_array(&env, &[7u8; 32]));
}

#[test]
fn failed_upgrade_attempt_leaves_state_untouched() {
    let env = Env::default();
    let fx = populate(&env);
    let before = capture(&env, &fx);
    let qp = QuorumProofContractClient::new(&env, &fx.qp_id);

    let res = qp.try_upgrade(&fx.admin, &BytesN::from_array(&env, &[0u8; 32]));
    assert!(res.is_err(), "zero-hash upgrade must fail");
    assert_state_compatible(&before, &capture(&env, &fx));
}

#[test]
#[should_panic(expected = "unauthorized")]
fn sbt_registry_upgrade_rejects_non_admin() {
    let env = Env::default();
    env.mock_all_auths();
    let admin = Address::generate(&env);
    let qp_id = env.register_contract(None, QuorumProofContract);
    let sbt_id = env.register_contract(None, SbtRegistryContract);
    let sbt = SbtRegistryContractClient::new(&env, &sbt_id);
    sbt.initialize(&admin, &qp_id);
    sbt.upgrade(&Address::generate(&env), &BytesN::from_array(&env, &[7u8; 32]));
}

#[test]
#[should_panic(expected = "invalid wasm hash")]
fn sbt_registry_upgrade_rejects_zero_hash() {
    let env = Env::default();
    env.mock_all_auths();
    let admin = Address::generate(&env);
    let qp_id = env.register_contract(None, QuorumProofContract);
    let sbt_id = env.register_contract(None, SbtRegistryContract);
    let sbt = SbtRegistryContractClient::new(&env, &sbt_id);
    sbt.initialize(&admin, &qp_id);
    sbt.upgrade(&admin, &BytesN::from_array(&env, &[0u8; 32]));
}

#[test]
#[should_panic(expected = "unauthorized")]
fn zk_verifier_upgrade_rejects_non_admin() {
    let env = Env::default();
    env.mock_all_auths();
    let admin = Address::generate(&env);
    let zk_id = env.register_contract(None, ZkVerifierContract);
    let zk = ZkVerifierContractClient::new(&env, &zk_id);
    zk.initialize(&admin);
    zk.upgrade(&Address::generate(&env), &BytesN::from_array(&env, &[7u8; 32]));
}

#[test]
#[should_panic(expected = "invalid wasm hash")]
fn zk_verifier_upgrade_rejects_zero_hash() {
    let env = Env::default();
    env.mock_all_auths();
    let admin = Address::generate(&env);
    let zk_id = env.register_contract(None, ZkVerifierContract);
    let zk = ZkVerifierContractClient::new(&env, &zk_id);
    zk.initialize(&admin);
    zk.upgrade(&admin, &BytesN::from_array(&env, &[0u8; 32]));
}
