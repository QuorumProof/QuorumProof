// Issue #554: Chaos testing for cross-contract calls
// Simulates contract call failures, verifies graceful degradation,
// and exercises boundary conditions across contract boundaries.

use quorum_proof::{QuorumProofContract, QuorumProofContractClient};
use sbt_registry::{SbtRegistryContract, SbtRegistryContractClient};
use zk_verifier::{ClaimType, ZkVerifierContract, ZkVerifierContractClient};
use soroban_sdk::{testutils::Address as _, Bytes, BytesN, Env, Vec};

struct Contracts<'a> {
    qp: QuorumProofContractClient<'a>,
    sbt: SbtRegistryContractClient<'a>,
    zk: ZkVerifierContractClient<'a>,
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

    let zk_id = env.register_contract(None, ZkVerifierContract);
    let zk = ZkVerifierContractClient::new(env, &zk_id);
    zk.initialize(&admin);
    let vk_hash = BytesN::from_array(env, &[0u8; 32]);
    zk.set_verifying_key(&admin, &vk_hash);

    Contracts { qp, sbt, zk, admin }
}

fn metadata(env: &Env) -> Bytes {
    Bytes::from_slice(env, b"QmTestHash000000000000000000000000")
}

fn valid_proof(env: &Env) -> Bytes {
    let mut proof_bytes = [0u8; 256];
    proof_bytes[0] = 1;
    proof_bytes[63] = 1;
    proof_bytes[192] = 1;
    proof_bytes[255] = 1;
    Bytes::from_slice(env, &proof_bytes)
}

// Chaos: credential revoked after SBT is minted — verify_engineer must not panic.
// Verifies graceful degradation when cross-contract state becomes inconsistent.
#[test]
fn chaos_revoke_after_mint_graceful_degradation() {
    let env = Env::default();
    let c = setup(&env);
    let issuer = soroban_sdk::Address::generate(&env);
    let engineer = soroban_sdk::Address::generate(&env);

    let cred_id =
        c.qp.issue_credential(&issuer, &engineer, &1u32, &metadata(&env), &None, &0u64);
    let uri = Bytes::from_slice(&env, b"ipfs://QmSBT");
    c.sbt.mint(&engineer, &cred_id, &uri);

    // Chaos injection: revoke the credential after the SBT exists
    c.qp.revoke_credential(&issuer, &cred_id);

    // System must degrade gracefully — no panic, deterministic result
    let result = c.qp.verify_engineer(
        &c.sbt.address,
        &c.zk.address,
        &c.admin,
        &engineer,
        &cred_id,
        &ClaimType::HasDegree,
        &valid_proof(&env),
        &None,
    );
    // Outcome is deterministic; the important property is no uncontrolled panic
    let _ = result;
}

// Chaos: empty proof sent to verify_engineer — must return false, never panic.
#[test]
fn chaos_empty_proof_returns_false() {
    let env = Env::default();
    let c = setup(&env);
    let issuer = soroban_sdk::Address::generate(&env);
    let engineer = soroban_sdk::Address::generate(&env);

    let cred_id =
        c.qp.issue_credential(&issuer, &engineer, &1u32, &metadata(&env), &None, &0u64);
    let uri = Bytes::from_slice(&env, b"ipfs://QmSBT");
    c.sbt.mint(&engineer, &cred_id, &uri);

    let empty_proof = Bytes::new(&env);
    let result = c.qp.verify_engineer(
        &c.sbt.address,
        &c.zk.address,
        &c.admin,
        &engineer,
        &cred_id,
        &ClaimType::HasDegree,
        &empty_proof,
        &None,
    );
    assert!(!result, "chaos: empty proof must yield false, not a panic");
}

// Chaos: non-existent credential ID passed to verify_engineer — must return false.
#[test]
fn chaos_nonexistent_credential_returns_false() {
    let env = Env::default();
    let c = setup(&env);
    let engineer = soroban_sdk::Address::generate(&env);

    // No credential issued — SBT ownership check fails immediately
    let result = c.qp.verify_engineer(
        &c.sbt.address,
        &c.zk.address,
        &c.admin,
        &engineer,
        &9999u64,
        &ClaimType::HasDegree,
        &valid_proof(&env),
        &None,
    );
    assert!(!result, "chaos: non-existent credential must yield false");
}

// Chaos: SBT mint cross-contract call fails when credential is already revoked.
#[test]
#[should_panic]
fn chaos_mint_revoked_credential_panics() {
    let env = Env::default();
    let c = setup(&env);
    let issuer = soroban_sdk::Address::generate(&env);
    let holder = soroban_sdk::Address::generate(&env);

    let cred_id =
        c.qp.issue_credential(&issuer, &holder, &1u32, &metadata(&env), &None, &0u64);
    c.qp.revoke_credential(&issuer, &cred_id);

    let uri = Bytes::from_slice(&env, b"ipfs://QmSBT");
    // Cross-contract call to is_revoked must cause SBT mint to reject
    c.sbt.mint(&holder, &cred_id, &uri);
}

// Chaos: attestation call fails when credential is revoked mid-flow.
#[test]
#[should_panic]
fn chaos_attest_after_revocation_panics() {
    let env = Env::default();
    let c = setup(&env);
    let issuer = soroban_sdk::Address::generate(&env);
    let holder = soroban_sdk::Address::generate(&env);
    let attestor = soroban_sdk::Address::generate(&env);

    let cred_id =
        c.qp.issue_credential(&issuer, &holder, &1u32, &metadata(&env), &None, &0u64);
    let mut attestors = Vec::new(&env);
    attestors.push_back(attestor.clone());
    let mut weights = Vec::new(&env);
    weights.push_back(1u32);
    let slice_id = c.qp.create_slice(&issuer, &attestors, &weights, &1u32);

    // Chaos: state changes between slice creation and attestation
    c.qp.revoke_credential(&issuer, &cred_id);
    c.qp.attest(&attestor, &cred_id, &slice_id, &true, &None); // must reject
}

// Chaos: rapid pause/unpause cycle — system must recover to a consistent state.
#[test]
fn chaos_pause_unpause_cycle_recovers() {
    let env = Env::default();
    let c = setup(&env);
    let issuer = soroban_sdk::Address::generate(&env);
    let holder = soroban_sdk::Address::generate(&env);

    c.qp.pause(&c.admin);
    c.qp.unpause(&c.admin);
    c.qp.pause(&c.admin);
    c.qp.unpause(&c.admin);

    // After the chaos cycle the contract must operate normally
    let cred_id =
        c.qp.issue_credential(&issuer, &holder, &1u32, &metadata(&env), &None, &0u64);
    assert!(
        c.qp.credential_exists(&cred_id),
        "chaos: contract must function correctly after pause/unpause chaos"
    );
}

// Chaos: credential suspended then resumed — attestation must succeed after recovery.
#[test]
fn chaos_suspend_resume_restores_attestation() {
    let env = Env::default();
    let c = setup(&env);
    let issuer = soroban_sdk::Address::generate(&env);
    let holder = soroban_sdk::Address::generate(&env);
    let attestor = soroban_sdk::Address::generate(&env);

    let cred_id =
        c.qp.issue_credential(&issuer, &holder, &1u32, &metadata(&env), &None, &0u64);
    let mut attestors = Vec::new(&env);
    attestors.push_back(attestor.clone());
    let mut weights = Vec::new(&env);
    weights.push_back(1u32);
    let slice_id = c.qp.create_slice(&issuer, &attestors, &weights, &1u32);

    c.qp.suspend_credential(&issuer, &cred_id);
    c.qp.resume_credential(&issuer, &cred_id);

    // Post-chaos: attestation must proceed normally
    c.qp.attest(&attestor, &cred_id, &slice_id, &true, &None);
    assert!(
        c.qp.is_attested(&cred_id, &slice_id),
        "chaos: attestation must succeed after suspend/resume recovery"
    );
}

// Chaos: degenerate all-zero proof — ZK verifier must return a deterministic result.
#[test]
fn chaos_all_zero_proof_no_panic() {
    let env = Env::default();
    let c = setup(&env);
    let issuer = soroban_sdk::Address::generate(&env);
    let holder = soroban_sdk::Address::generate(&env);

    let cred_id =
        c.qp.issue_credential(&issuer, &holder, &1u32, &metadata(&env), &None, &0u64);
    let zero_proof = Bytes::from_slice(&env, &[0u8; 256]);

    // Degenerate input must not cause an uncontrolled failure
    let result = c.zk.verify_claim(
        &c.admin,
        &c.qp.address,
        &cred_id,
        &ClaimType::HasDegree,
        &zero_proof,
    );
    let _ = result; // result value may be true or false — no panic is the invariant
}

// Chaos: verify_engineer with mismatched credential ID — SBT belongs to cred N, not N+1.
#[test]
fn chaos_mismatched_credential_id_returns_false() {
    let env = Env::default();
    let c = setup(&env);
    let issuer = soroban_sdk::Address::generate(&env);
    let engineer = soroban_sdk::Address::generate(&env);

    let cred_id =
        c.qp.issue_credential(&issuer, &engineer, &1u32, &metadata(&env), &None, &0u64);
    let uri = Bytes::from_slice(&env, b"ipfs://QmSBT");
    c.sbt.mint(&engineer, &cred_id, &uri);

    // SBT linked to cred_id, but verification requests cred_id+1
    let result = c.qp.verify_engineer(
        &c.sbt.address,
        &c.zk.address,
        &c.admin,
        &engineer,
        &(cred_id + 1),
        &ClaimType::HasDegree,
        &valid_proof(&env),
        &None,
    );
    assert!(!result, "chaos: mismatched credential ID must yield false, not panic");
}

// Chaos: suspended credential blocks attestation — timeout/rejection must be clean.
#[test]
#[should_panic]
fn chaos_suspended_credential_rejects_attestation() {
    let env = Env::default();
    let c = setup(&env);
    let issuer = soroban_sdk::Address::generate(&env);
    let holder = soroban_sdk::Address::generate(&env);
    let attestor = soroban_sdk::Address::generate(&env);

    let cred_id =
        c.qp.issue_credential(&issuer, &holder, &1u32, &metadata(&env), &None, &0u64);
    let mut attestors = Vec::new(&env);
    attestors.push_back(attestor.clone());
    let mut weights = Vec::new(&env);
    weights.push_back(1u32);
    let slice_id = c.qp.create_slice(&issuer, &attestors, &weights, &1u32);

    c.qp.suspend_credential(&issuer, &cred_id);
    // Attestation on a suspended credential must fail with a controlled panic
    c.qp.attest(&attestor, &cred_id, &slice_id, &true, &None);
}
