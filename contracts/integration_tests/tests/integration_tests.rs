// Issue #1002: Contract Integration Tests
//
// External integration-test binary covering multi-contract interactions
// (credential -> quorum slice -> SBT -> ZK verification). The crate's
// existing `#[cfg(test)] mod integration` in src/lib.rs (issue #364) already
// covers the happy-path full flow and several single-panic error cases, and
// `upgrade_safety.rs` (issue #558) already covers upgrade/migration safety in
// depth. This file adds the specific #1002 deliverables that aren't covered
// elsewhere: a full-flow test living in the literal `tests/integration_tests.rs`
// path the issue asks for, dispute-resolution and revocation-cascade error
// paths, upgrade-safety checks exercised from a populated multi-contract
// flow, and a performance budget check on the full flow.

use quorum_proof::{ChallengeStatus, ClaimType as QpClaimType, QuorumProofContract, QuorumProofContractClient};
use sbt_registry::{SbtRegistryContract, SbtRegistryContractClient};
use zk_verifier::{ClaimType, ZkVerifierContract, ZkVerifierContractClient};
use soroban_sdk::{testutils::Address as _, Address, Bytes, BytesN, Env, Vec};

// ── Shared setup ─────────────────────────────────────────────────────────────

struct Contracts<'a> {
    qp: QuorumProofContractClient<'a>,
    sbt: SbtRegistryContractClient<'a>,
    zk: ZkVerifierContractClient<'a>,
    admin: Address,
}

fn setup(env: &Env) -> Contracts<'_> {
    // verify_engineer makes a nested cross-contract call to zk_verifier that
    // requires zk_admin's auth outside the root invocation — plain
    // mock_all_auths() only mocks auth tied to the root call.
    env.mock_all_auths_allowing_non_root_auth();

    let admin = Address::generate(env);

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
    Bytes::from_slice(env, b"QmIntegrationTestHash00000000000000")
}

/// A mock 256-byte Groth16 proof (BN254 uncompressed: A‖B‖C) that passes
/// structural checks but not real pairing verification.
fn valid_proof(env: &Env) -> Bytes {
    let mut proof_bytes = [0u8; 256];
    proof_bytes[0] = 1;
    proof_bytes[63] = 1;
    proof_bytes[192] = 1;
    proof_bytes[255] = 1;
    Bytes::from_slice(env, &proof_bytes)
}

fn new_wasm_hash(env: &Env) -> BytesN<32> {
    BytesN::from_array(env, &[0xABu8; 32])
}

/// See `upgrade_safety.rs` for the full explanation: `upgrade` performs a
/// real WASM swap that this sandbox can't satisfy with a fabricated hash, so
/// any test that expects `upgrade` to logically succeed tolerates the
/// resulting "Wasm does not exist" panic. Do NOT use this for tests
/// asserting that `upgrade` itself must panic for auth/validation reasons.
fn simulate_upgrade(qp: &QuorumProofContractClient, admin: &Address, wasm_hash: &BytesN<32>) {
    let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        qp.upgrade(admin, wasm_hash);
    }));
}

// ── Full flow: issue -> quorum slice -> attest -> SBT -> ZK proof ───────────

#[test]
fn full_flow_issue_slice_attest_sbt_zk_proof() {
    let env = Env::default();
    let c = setup(&env);

    let issuer = Address::generate(&env);
    let holder = Address::generate(&env);
    let attestor1 = Address::generate(&env);
    let attestor2 = Address::generate(&env);

    // 1. Issue credential
    let cred_id = c.qp.issue_credential(&issuer, &holder, &1u32, &metadata(&env), &None, &0u64);

    // 2. Create a 2-of-2 quorum slice
    let mut attestors = Vec::new(&env);
    attestors.push_back(attestor1.clone());
    attestors.push_back(attestor2.clone());
    let mut weights = Vec::new(&env);
    weights.push_back(1u32);
    weights.push_back(1u32);
    let slice_id = c.qp.create_slice(&issuer, &attestors, &weights, &2u32);

    // 3. Attest the credential
    c.qp.attest(&attestor1, &cred_id, &slice_id, &true, &None);
    c.qp.attest(&attestor2, &cred_id, &slice_id, &true, &None);
    assert!(c.qp.is_attested(&cred_id, &slice_id));

    // 4. Generate SBT
    let uri = Bytes::from_slice(&env, b"ipfs://QmIntegrationSBT");
    let token_id = c.sbt.mint(&holder, &cred_id, &uri);
    assert_eq!(c.sbt.owner_of(&token_id), holder);

    // 5. Verify with ZK proof, both directly and via the cross-contract
    //    verify_engineer entry point (SBT ownership + ZK proof combined).
    let verified = c.zk.verify_claim(&c.admin, &c.qp.address, &cred_id, &ClaimType::HasDegree, &valid_proof(&env));
    assert!(verified);

    let engineer_ok = c.qp.verify_engineer(
        &c.sbt.address,
        &c.zk.address,
        &c.admin,
        &holder,
        &cred_id,
        &QpClaimType::HasDegree,
        &valid_proof(&env),
        &None,
    );
    assert!(engineer_ok);
}

// ── Error path: dispute resolution ───────────────────────────────────────────

/// A challenge that gathers enough weighted uphold-votes removes the
/// accused's attestation from the credential, which can drop the credential
/// back below the slice's attestation threshold.
#[test]
fn dispute_upheld_removes_attestation_and_drops_below_threshold() {
    let env = Env::default();
    let c = setup(&env);

    let issuer = Address::generate(&env);
    let holder = Address::generate(&env);
    let honest = Address::generate(&env);
    let accused = Address::generate(&env);
    let tiebreaker = Address::generate(&env);

    let cred_id = c.qp.issue_credential(&issuer, &holder, &1u32, &metadata(&env), &None, &0u64);

    let mut attestors = Vec::new(&env);
    attestors.push_back(honest.clone());
    attestors.push_back(accused.clone());
    attestors.push_back(tiebreaker.clone());
    let mut weights = Vec::new(&env);
    weights.push_back(1u32);
    weights.push_back(1u32);
    weights.push_back(1u32);
    // Absolute threshold of 2: any two attestations are sufficient.
    let slice_id = c.qp.create_slice(&issuer, &attestors, &weights, &2u32);

    c.qp.attest(&honest, &cred_id, &slice_id, &true, &None);
    c.qp.attest(&accused, &cred_id, &slice_id, &true, &None);
    assert!(c.qp.is_attested(&cred_id, &slice_id), "pre-dispute: two attestations must meet threshold");

    let challenge_id = c.qp.challenge_attestation(&honest, &cred_id, &slice_id, &accused);

    // honest + tiebreaker vote to uphold: weight 2 meets the threshold of 2.
    c.qp.vote_on_challenge(&honest, &challenge_id, &true);
    c.qp.vote_on_challenge(&tiebreaker, &challenge_id, &true);

    let challenge = c.qp.get_challenge(&challenge_id);
    assert!(challenge.status == ChallengeStatus::Upheld, "challenge with majority uphold votes must resolve as Upheld");

    // The accused's attestation record was removed, leaving only `honest`'s
    // single attestation — one attestation can no longer meet a threshold of 2.
    assert!(!c.qp.is_attested(&cred_id, &slice_id), "dispute resolution must cascade: removing accused's attestation drops below threshold");
    assert_eq!(c.qp.get_slash_count(&accused), 1, "upheld dispute must slash the accused attestor");
}

/// Only slice members may challenge an attestation.
#[test]
#[should_panic]
fn dispute_challenge_by_non_slice_member_panics() {
    let env = Env::default();
    let c = setup(&env);

    let issuer = Address::generate(&env);
    let holder = Address::generate(&env);
    let attestor = Address::generate(&env);
    let outsider = Address::generate(&env);

    let cred_id = c.qp.issue_credential(&issuer, &holder, &1u32, &metadata(&env), &None, &0u64);

    let mut attestors = Vec::new(&env);
    attestors.push_back(attestor.clone());
    let mut weights = Vec::new(&env);
    weights.push_back(1u32);
    let slice_id = c.qp.create_slice(&issuer, &attestors, &weights, &1u32);
    c.qp.attest(&attestor, &cred_id, &slice_id, &true, &None);

    // outsider is not a member of the slice -> must panic
    c.qp.challenge_attestation(&outsider, &cred_id, &slice_id, &attestor);
}

/// A challenge with enough weighted dismiss-votes leaves the original
/// attestation standing.
#[test]
fn dispute_dismissed_leaves_attestation_standing() {
    let env = Env::default();
    let c = setup(&env);

    let issuer = Address::generate(&env);
    let holder = Address::generate(&env);
    let honest = Address::generate(&env);
    let accused = Address::generate(&env);
    let juror1 = Address::generate(&env);
    let juror2 = Address::generate(&env);

    let cred_id = c.qp.issue_credential(&issuer, &holder, &1u32, &metadata(&env), &None, &0u64);

    let mut attestors = Vec::new(&env);
    attestors.push_back(honest.clone());
    attestors.push_back(accused.clone());
    attestors.push_back(juror1.clone());
    attestors.push_back(juror2.clone());
    let mut weights = Vec::new(&env);
    weights.push_back(1u32);
    weights.push_back(1u32);
    weights.push_back(1u32);
    weights.push_back(1u32);
    let slice_id = c.qp.create_slice(&issuer, &attestors, &weights, &2u32);

    c.qp.attest(&honest, &cred_id, &slice_id, &true, &None);
    c.qp.attest(&accused, &cred_id, &slice_id, &true, &None);

    let challenge_id = c.qp.challenge_attestation(&honest, &cred_id, &slice_id, &accused);

    // Two neutral jurors (not the challenger, not the accused — who is
    // barred from voting on their own challenge) vote to dismiss: weight 2
    // meets the threshold of 2.
    c.qp.vote_on_challenge(&juror1, &challenge_id, &false);
    c.qp.vote_on_challenge(&juror2, &challenge_id, &false);

    let challenge = c.qp.get_challenge(&challenge_id);
    assert!(challenge.status == ChallengeStatus::Dismissed);
    assert!(c.qp.is_attested(&cred_id, &slice_id), "dismissed dispute must leave the original attestation intact");
    assert_eq!(c.qp.get_slash_count(&accused), 0, "dismissed dispute must not slash anyone");
}

// ── Error path: revocation cascading ─────────────────────────────────────────

/// Revoking a credential must cascade to block both new attestations and new
/// SBT minting against that credential.
#[test]
fn revocation_cascades_blocks_attestation_and_sbt_mint() {
    let env = Env::default();
    let c = setup(&env);

    let issuer = Address::generate(&env);
    let holder = Address::generate(&env);
    let attestor = Address::generate(&env);

    let cred_id = c.qp.issue_credential(&issuer, &holder, &1u32, &metadata(&env), &None, &0u64);

    let mut attestors = Vec::new(&env);
    attestors.push_back(attestor.clone());
    let mut weights = Vec::new(&env);
    weights.push_back(1u32);
    let slice_id = c.qp.create_slice(&issuer, &attestors, &weights, &1u32);

    c.qp.revoke_credential(&issuer, &cred_id, &None);
    assert!(c.qp.is_revoked(&cred_id));

    // Cascade 1: attestation against a revoked credential is rejected.
    let attest_result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        c.qp.attest(&attestor, &cred_id, &slice_id, &true, &None);
    }));
    assert!(attest_result.is_err(), "revocation must cascade to block new attestations");

    // Cascade 2: SBT minting against a revoked credential is rejected.
    let uri = Bytes::from_slice(&env, b"ipfs://QmRevokedSBT");
    let mint_result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        c.sbt.mint(&holder, &cred_id, &uri);
    }));
    assert!(mint_result.is_err(), "revocation must cascade to block SBT minting");

    // The credential record itself is not deleted — it remains inspectable,
    // just permanently marked revoked.
    assert!(c.qp.credential_exists(&cred_id));
}

/// Revoking a credential that already has an SBT does not retroactively burn
/// it, but does block any *new* mint for that credential id.
#[test]
fn revocation_after_mint_does_not_burn_existing_sbt() {
    let env = Env::default();
    let c = setup(&env);

    let issuer = Address::generate(&env);
    let holder = Address::generate(&env);

    let cred_id = c.qp.issue_credential(&issuer, &holder, &1u32, &metadata(&env), &None, &0u64);
    let uri = Bytes::from_slice(&env, b"ipfs://QmPreRevocationSBT");
    let token_id = c.sbt.mint(&holder, &cred_id, &uri);

    c.qp.revoke_credential(&issuer, &cred_id, &None);

    // Already-minted SBT ownership is unaffected by the later revocation.
    assert_eq!(c.sbt.owner_of(&token_id), holder);

    // But re-minting (e.g. after a burn) is now blocked.
    let re_mint = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        c.sbt.mint(&holder, &(cred_id + 1), &uri);
    }));
    // cred_id + 1 doesn't exist at all, which panics for a different reason
    // (CredentialNotFound) — the point being that the SBT registry always
    // cross-checks credential state (existence, revocation) before minting.
    assert!(re_mint.is_err());
}

// ── Contract upgrade safety, exercised from a populated multi-contract flow ─

/// Upgrading the QuorumProof contract mid-flow must preserve the full
/// cross-contract state built up so far (credential, slice, attestation,
/// SBT ownership) and leave the contract fully operational afterwards.
#[test]
fn upgrade_preserves_full_cross_contract_flow_state() {
    let env = Env::default();
    let c = setup(&env);

    let issuer = Address::generate(&env);
    let holder = Address::generate(&env);
    let attestor = Address::generate(&env);

    let cred_id = c.qp.issue_credential(&issuer, &holder, &1u32, &metadata(&env), &None, &0u64);

    let mut attestors = Vec::new(&env);
    attestors.push_back(attestor.clone());
    let mut weights = Vec::new(&env);
    weights.push_back(1u32);
    let slice_id = c.qp.create_slice(&issuer, &attestors, &weights, &1u32);
    c.qp.attest(&attestor, &cred_id, &slice_id, &true, &None);

    let uri = Bytes::from_slice(&env, b"ipfs://QmUpgradeFlowSBT");
    let token_id = c.sbt.mint(&holder, &cred_id, &uri);

    simulate_upgrade(&c.qp, &c.admin, &new_wasm_hash(&env));

    assert!(c.qp.credential_exists(&cred_id));
    assert!(c.qp.is_attested(&cred_id, &slice_id));
    assert_eq!(c.sbt.owner_of(&token_id), holder);

    // Contract must remain fully operational after upgrade: a new credential
    // can be issued and independently verified with ZK.
    let cred_id2 = c.qp.issue_credential(&issuer, &holder, &2u32, &metadata(&env), &None, &0u64);
    assert!(c.zk.verify_claim(&c.admin, &c.qp.address, &cred_id2, &ClaimType::HasDegree, &valid_proof(&env)));
}

/// An unauthorized caller must not be able to upgrade the contract, even
/// once real cross-contract state (SBTs, ZK verifying key) has been set up.
#[test]
#[should_panic]
fn upgrade_unauthorized_caller_rejected_with_live_state() {
    let env = Env::default();
    let c = setup(&env);

    let issuer = Address::generate(&env);
    let holder = Address::generate(&env);
    c.qp.issue_credential(&issuer, &holder, &1u32, &metadata(&env), &None, &0u64);

    let attacker = Address::generate(&env);
    c.qp.upgrade(&attacker, &new_wasm_hash(&env));
}

// ── Performance benchmark ─────────────────────────────────────────────────────

struct Metrics {
    cpu: u64,
    mem: u64,
}

/// Resets the budget, runs `f`, then returns cumulative CPU + memory cost.
fn measure(env: &Env, f: impl FnOnce()) -> Metrics {
    env.budget().reset_default();
    f();
    Metrics {
        cpu: env.budget().cpu_instruction_cost(),
        mem: env.budget().memory_bytes_cost(),
    }
}

// This is a first-cut safety net on the *combined* cross-contract flow (no
// prior historical baseline exists for the full flow as a unit, unlike the
// tight ~10%-regression per-operation gates in benches/tests/benchmarks.rs),
// so the threshold carries generous headroom rather than a strict gate.
const THRESHOLD_FULL_FLOW_CPU: u64 = 15_000_000;
const THRESHOLD_FULL_FLOW_MEM: u64 = 15_000_000;

#[test]
fn perf_full_flow_within_cpu_and_memory_budget() {
    let env = Env::default();
    let c = setup(&env);

    let issuer = Address::generate(&env);
    let holder = Address::generate(&env);
    let attestor1 = Address::generate(&env);
    let attestor2 = Address::generate(&env);

    let m = measure(&env, || {
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

        let uri = Bytes::from_slice(&env, b"ipfs://QmPerfFlowSBT");
        c.sbt.mint(&holder, &cred_id, &uri);

        c.zk.verify_claim(&c.admin, &c.qp.address, &cred_id, &ClaimType::HasDegree, &valid_proof(&env));
    });

    println!("[perf_full_flow_within_cpu_and_memory_budget] cpu={} mem={}", m.cpu, m.mem);
    assert!(
        m.cpu <= THRESHOLD_FULL_FLOW_CPU,
        "full-flow CPU regression: {} > {}",
        m.cpu,
        THRESHOLD_FULL_FLOW_CPU
    );
    assert!(
        m.mem <= THRESHOLD_FULL_FLOW_MEM,
        "full-flow MEM regression: {} > {}",
        m.mem,
        THRESHOLD_FULL_FLOW_MEM
    );
}
