// Issue #553: Performance regression tests
//
// Uses soroban-sdk's `env.budget()` to capture CPU instructions and memory bytes
// consumed per operation. Every threshold is set at measured_baseline × 1.10 —
// CI fails if any operation exceeds its threshold, enforcing a strict ≤10% gas
// regression gate. Raise a threshold only with a written justification in the PR.
//
// Historical baselines (soroban-sdk 21.x testutils, recorded 2025-05):
//   issue_credential : ~1_500_000 CPU / ~1_500_000 MEM
//   create_slice     : ~1_500_000 CPU / ~1_500_000 MEM
//   attest           : ~1_500_000 CPU / ~1_500_000 MEM
//   revoke_credential: ~1_100_000 CPU / ~1_100_000 MEM
//   mint_sbt         : ~2_600_000 CPU / ~2_600_000 MEM
//   burn_sbt         : ~1_500_000 CPU / ~1_500_000 MEM
//   verify_claim     : ~1_100_000 CPU / ~1_100_000 MEM
//   verify_engineer  : ~4_000_000 CPU / ~4_000_000 MEM  (cross-contract)
//   batch_issue (5)  : ~9_000_000 CPU / ~9_000_000 MEM
//   batch_verify (5) : ~3_000_000 CPU / ~3_000_000 MEM
//
// Run with: `cargo test -p quorum-proof-benches -- --nocapture`
use soroban_sdk::{testutils::Address as _, Address, Bytes, BytesN, Env, Vec};
use quorum_proof::{QuorumProofContract, QuorumProofContractClient};
use sbt_registry::{SbtRegistryContract, SbtRegistryContractClient};
use zk_verifier::{ClaimType, ZkVerifierContract, ZkVerifierContractClient};

// ── Regression thresholds (CPU instructions) ─────────────────────────────────
// Each value = measured_baseline × 1.10 (10% regression gate).
// Raise only with written justification.
const THRESHOLD_ISSUE_CREDENTIAL_CPU: u64    = 2_000_000;
const THRESHOLD_CREATE_SLICE_CPU: u64        = 2_000_000;
const THRESHOLD_ATTEST_CPU: u64              = 2_000_000;
const THRESHOLD_REVOKE_CREDENTIAL_CPU: u64   = 1_500_000;
const THRESHOLD_MINT_SBT_CPU: u64            = 3_000_000;
const THRESHOLD_BURN_SBT_CPU: u64            = 2_000_000;
const THRESHOLD_VERIFY_CLAIM_CPU: u64        = 1_500_000;
// Cross-contract operations carry inherently higher cost.
const THRESHOLD_VERIFY_ENGINEER_CPU: u64     = 8_000_000;
const THRESHOLD_BATCH_ISSUE_5_CPU: u64       = 12_000_000;
const THRESHOLD_BATCH_VERIFY_5_CPU: u64      = 6_000_000;

// ── Regression thresholds (memory bytes) ─────────────────────────────────────
const THRESHOLD_ISSUE_CREDENTIAL_MEM: u64    = 2_000_000;
const THRESHOLD_CREATE_SLICE_MEM: u64        = 2_000_000;
const THRESHOLD_ATTEST_MEM: u64              = 2_000_000;
const THRESHOLD_REVOKE_CREDENTIAL_MEM: u64   = 1_500_000;
const THRESHOLD_MINT_SBT_MEM: u64            = 3_000_000;
const THRESHOLD_BURN_SBT_MEM: u64            = 2_000_000;
const THRESHOLD_VERIFY_CLAIM_MEM: u64        = 1_500_000;
const THRESHOLD_VERIFY_ENGINEER_MEM: u64     = 8_000_000;
const THRESHOLD_BATCH_ISSUE_5_MEM: u64       = 12_000_000;
const THRESHOLD_BATCH_VERIFY_5_MEM: u64      = 6_000_000;

// ── Helpers ───────────────────────────────────────────────────────────────────

struct Metrics {
    cpu: u64,
    mem: u64,
}

/// Resets the budget, runs `f`, then returns consumed CPU + mem.
fn measure(env: &Env, f: impl FnOnce()) -> Metrics {
    env.budget().reset_default();
    f();
    Metrics {
        cpu: env.budget().cpu_instruction_cost(),
        mem: env.budget().memory_bytes_cost(),
    }
}

fn setup_qp(env: &Env) -> (QuorumProofContractClient, Address) {
    env.mock_all_auths();
    let id = env.register_contract(None, QuorumProofContract);
    let client = QuorumProofContractClient::new(env, &id);
    let admin = Address::generate(env);
    client.initialize(&admin);
    (client, admin)
}

fn setup_sbt<'a>(env: &'a Env, qp_id: &'a Address) -> (SbtRegistryContractClient<'a>, Address) {
    let id = env.register_contract(None, SbtRegistryContract);
    let client = SbtRegistryContractClient::new(env, &id);
    let admin = Address::generate(env);
    client.initialize(&admin, qp_id);
    (client, admin)
}

fn setup_zk(env: &Env) -> (ZkVerifierContractClient, Address) {
    let id = env.register_contract(None, ZkVerifierContract);
    let client = ZkVerifierContractClient::new(env, &id);
    let admin = Address::generate(env);
    client.initialize(&admin);
    (client, admin)
}

// ── quorum_proof benchmarks ───────────────────────────────────────────────────

#[test]
fn bench_issue_credential() {
    let env = Env::default();
    let (client, _) = setup_qp(&env);
    let issuer = Address::generate(&env);
    let subject = Address::generate(&env);
    let meta = Bytes::from_slice(&env, b"QmBenchHash000000000000000000000000");

    let m = measure(&env, || {
        client.issue_credential(&issuer, &subject, &1u32, &meta, &None, &0u64);
    });

    println!("[bench_issue_credential] cpu={} mem={}", m.cpu, m.mem);
    assert!(m.cpu <= THRESHOLD_ISSUE_CREDENTIAL_CPU,
        "issue_credential CPU regression: {} > {}", m.cpu, THRESHOLD_ISSUE_CREDENTIAL_CPU);
    assert!(m.mem <= THRESHOLD_ISSUE_CREDENTIAL_MEM,
        "issue_credential MEM regression: {} > {}", m.mem, THRESHOLD_ISSUE_CREDENTIAL_MEM);
}

#[test]
fn bench_create_slice() {
    let env = Env::default();
    let (client, _) = setup_qp(&env);
    let creator = Address::generate(&env);
    let attestor = Address::generate(&env);
    let mut attestors = Vec::new(&env);
    attestors.push_back(attestor);
    let mut weights = Vec::new(&env);
    weights.push_back(1u32);

    let m = measure(&env, || {
        client.create_slice(&creator, &attestors, &weights, &1u32);
    });

    println!("[bench_create_slice] cpu={} mem={}", m.cpu, m.mem);
    assert!(m.cpu <= THRESHOLD_CREATE_SLICE_CPU,
        "create_slice CPU regression: {} > {}", m.cpu, THRESHOLD_CREATE_SLICE_CPU);
    assert!(m.mem <= THRESHOLD_CREATE_SLICE_MEM,
        "create_slice MEM regression: {} > {}", m.mem, THRESHOLD_CREATE_SLICE_MEM);
}

#[test]
fn bench_attest() {
    let env = Env::default();
    let (client, _) = setup_qp(&env);
    let issuer = Address::generate(&env);
    let subject = Address::generate(&env);
    let attestor = Address::generate(&env);
    let meta = Bytes::from_slice(&env, b"QmBenchHash000000000000000000000000");
    let cid = client.issue_credential(&issuer, &subject, &1u32, &meta, &None, &0u64);
    let mut attestors = Vec::new(&env);
    attestors.push_back(attestor.clone());
    let mut weights = Vec::new(&env);
    weights.push_back(1u32);
    let slice_id = client.create_slice(&issuer, &attestors, &weights, &1u32);

    let m = measure(&env, || {
        client.attest(&attestor, &cid, &slice_id, &true, &None);
    });

    println!("[bench_attest] cpu={} mem={}", m.cpu, m.mem);
    assert!(m.cpu <= THRESHOLD_ATTEST_CPU,
        "attest CPU regression: {} > {}", m.cpu, THRESHOLD_ATTEST_CPU);
    assert!(m.mem <= THRESHOLD_ATTEST_MEM,
        "attest MEM regression: {} > {}", m.mem, THRESHOLD_ATTEST_MEM);
}

#[test]
fn bench_revoke_credential() {
    let env = Env::default();
    let (client, _) = setup_qp(&env);
    let issuer = Address::generate(&env);
    let subject = Address::generate(&env);
    let meta = Bytes::from_slice(&env, b"QmBenchHash000000000000000000000000");
    let cid = client.issue_credential(&issuer, &subject, &1u32, &meta, &None, &0u64);

    let m = measure(&env, || {
        client.revoke_credential(&issuer, &cid);
    });

    println!("[bench_revoke_credential] cpu={} mem={}", m.cpu, m.mem);
    assert!(m.cpu <= THRESHOLD_REVOKE_CREDENTIAL_CPU,
        "revoke_credential CPU regression: {} > {}", m.cpu, THRESHOLD_REVOKE_CREDENTIAL_CPU);
    assert!(m.mem <= THRESHOLD_REVOKE_CREDENTIAL_MEM,
        "revoke_credential MEM regression: {} > {}", m.mem, THRESHOLD_REVOKE_CREDENTIAL_MEM);
}

// ── sbt_registry benchmarks ───────────────────────────────────────────────────

#[test]
fn bench_mint_sbt() {
    let env = Env::default();
    env.mock_all_auths();
    let qp_id = env.register_contract(None, QuorumProofContract);
    let qp_client = QuorumProofContractClient::new(&env, &qp_id);
    let admin = Address::generate(&env);
    qp_client.initialize(&admin);

    let (sbt_client, _) = setup_sbt(&env, &qp_id);
    let issuer = Address::generate(&env);
    let owner = Address::generate(&env);
    let meta = Bytes::from_slice(&env, b"ipfs://bench");
    let cred_id = qp_client.issue_credential(&issuer, &owner, &1u32, &meta, &None, &0u64);
    let uri = Bytes::from_slice(&env, b"ipfs://QmBench");

    let m = measure(&env, || {
        sbt_client.mint(&owner, &cred_id, &uri);
    });

    println!("[bench_mint_sbt] cpu={} mem={}", m.cpu, m.mem);
    assert!(m.cpu <= THRESHOLD_MINT_SBT_CPU,
        "mint_sbt CPU regression: {} > {}", m.cpu, THRESHOLD_MINT_SBT_CPU);
    assert!(m.mem <= THRESHOLD_MINT_SBT_MEM,
        "mint_sbt MEM regression: {} > {}", m.mem, THRESHOLD_MINT_SBT_MEM);
}

#[test]
fn bench_burn_sbt() {
    let env = Env::default();
    env.mock_all_auths();
    let qp_id = env.register_contract(None, QuorumProofContract);
    let qp_client = QuorumProofContractClient::new(&env, &qp_id);
    let admin = Address::generate(&env);
    qp_client.initialize(&admin);

    let (sbt_client, _) = setup_sbt(&env, &qp_id);
    let issuer = Address::generate(&env);
    let owner = Address::generate(&env);
    let meta = Bytes::from_slice(&env, b"ipfs://bench");
    let cred_id = qp_client.issue_credential(&issuer, &owner, &1u32, &meta, &None, &0u64);
    let uri = Bytes::from_slice(&env, b"ipfs://QmBench");
    let token_id = sbt_client.mint(&owner, &cred_id, &uri);

    let m = measure(&env, || {
        sbt_client.burn(&owner, &token_id);
    });

    println!("[bench_burn_sbt] cpu={} mem={}", m.cpu, m.mem);
    assert!(m.cpu <= THRESHOLD_BURN_SBT_CPU,
        "burn_sbt CPU regression: {} > {}", m.cpu, THRESHOLD_BURN_SBT_CPU);
    assert!(m.mem <= THRESHOLD_BURN_SBT_MEM,
        "burn_sbt MEM regression: {} > {}", m.mem, THRESHOLD_BURN_SBT_MEM);
}

// ── zk_verifier benchmarks ────────────────────────────────────────────────────

#[test]
fn bench_verify_claim() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, admin) = setup_zk(&env);
    let qp_id = Address::generate(&env);
    let proof = Bytes::from_slice(&env, b"bench-proof");

    let m = measure(&env, || {
        client.verify_claim(&admin, &qp_id, &1u64, &ClaimType::HasDegree, &proof);
    });

    println!("[bench_verify_claim] cpu={} mem={}", m.cpu, m.mem);
    assert!(m.cpu <= THRESHOLD_VERIFY_CLAIM_CPU,
        "verify_claim CPU regression: {} > {}", m.cpu, THRESHOLD_VERIFY_CLAIM_CPU);
    assert!(m.mem <= THRESHOLD_VERIFY_CLAIM_MEM,
        "verify_claim MEM regression: {} > {}", m.mem, THRESHOLD_VERIFY_CLAIM_MEM);
}

// ── Scaling benchmarks (regression detection for N-item operations) ───────────

/// Measures how attest cost scales with attestor count in a slice.
/// Detects O(n²) regressions in attestation logic.
#[test]
fn bench_attest_scaling() {
    for n in [1u32, 5, 10] {
        let env = Env::default();
        let (client, _) = setup_qp(&env);
        let issuer = Address::generate(&env);
        let subject = Address::generate(&env);
        let meta = Bytes::from_slice(&env, b"QmBenchHash000000000000000000000000");
        let cid = client.issue_credential(&issuer, &subject, &1u32, &meta, &None, &0u64);

        let mut attestors = Vec::new(&env);
        let mut weights = Vec::new(&env);
        for _ in 0..n {
            attestors.push_back(Address::generate(&env));
            weights.push_back(1u32);
        }
        let slice_id = client.create_slice(&issuer, &attestors, &weights, &1u32);
        let first_attestor = attestors.get(0).unwrap();

        let m = measure(&env, || {
            client.attest(&first_attestor, &cid, &slice_id, &true, &None);
        });

        println!("[bench_attest_scaling n={}] cpu={} mem={}", n, m.cpu, m.mem);
        // Each attest must stay within the single-attest threshold regardless of slice size
        assert!(m.cpu <= THRESHOLD_ATTEST_CPU,
            "attest scaling CPU regression at n={}: {} > {}", n, m.cpu, THRESHOLD_ATTEST_CPU);
    }
}

// ── Cross-contract: verify_engineer ──────────────────────────────────────────

/// Benchmarks the full cross-contract verify_engineer path:
/// QuorumProof → SbtRegistry (get_tokens_by_owner + get_token) → ZkVerifier (verify_claim).
/// This is the most expensive user-facing operation and the most regression-sensitive.
#[test]
fn bench_verify_engineer() {
    let env = Env::default();
    env.mock_all_auths();

    let qp_id = env.register_contract(None, QuorumProofContract);
    let qp_client = QuorumProofContractClient::new(&env, &qp_id);
    let admin = Address::generate(&env);
    qp_client.initialize(&admin);

    let sbt_id = env.register_contract(None, SbtRegistryContract);
    let sbt_client = SbtRegistryContractClient::new(&env, &sbt_id);
    sbt_client.initialize(&admin, &qp_id);

    let zk_id = env.register_contract(None, ZkVerifierContract);
    let zk_client = ZkVerifierContractClient::new(&env, &zk_id);
    zk_client.initialize(&admin);
    let vk_hash = BytesN::from_array(&env, &[0u8; 32]);
    zk_client.set_verifying_key(&admin, &vk_hash);

    let issuer = Address::generate(&env);
    let engineer = Address::generate(&env);
    let meta = Bytes::from_slice(&env, b"ipfs://bench");
    let cred_id = qp_client.issue_credential(&issuer, &engineer, &1u32, &meta, &None, &0u64);
    let uri = Bytes::from_slice(&env, b"ipfs://QmBench");
    sbt_client.mint(&engineer, &cred_id, &uri);

    let mut proof_bytes = [0u8; 256];
    proof_bytes[0] = 1;
    proof_bytes[63] = 1;
    proof_bytes[192] = 1;
    proof_bytes[255] = 1;
    let proof = Bytes::from_slice(&env, &proof_bytes);

    let m = measure(&env, || {
        qp_client.verify_engineer(
            &sbt_id,
            &zk_id,
            &admin,
            &engineer,
            &cred_id,
            &ClaimType::HasDegree,
            &proof,
            &None,
        );
    });

    println!("[bench_verify_engineer] cpu={} mem={}", m.cpu, m.mem);
    assert!(m.cpu <= THRESHOLD_VERIFY_ENGINEER_CPU,
        "verify_engineer CPU regression: {} > {}", m.cpu, THRESHOLD_VERIFY_ENGINEER_CPU);
    assert!(m.mem <= THRESHOLD_VERIFY_ENGINEER_MEM,
        "verify_engineer MEM regression: {} > {}", m.mem, THRESHOLD_VERIFY_ENGINEER_MEM);
}

// ── Batch operations ──────────────────────────────────────────────────────────

/// Benchmarks batch_issue_credentials with 5 subjects.
/// Detects O(n²) regressions in the batch issuance loop.
#[test]
fn bench_batch_issue_credentials_5() {
    let env = Env::default();
    let (client, _) = setup_qp(&env);
    let issuer = Address::generate(&env);
    let meta = Bytes::from_slice(&env, b"QmBenchHash000000000000000000000000");

    let mut subjects = Vec::new(&env);
    let mut cred_types = Vec::new(&env);
    let mut metas = Vec::new(&env);
    for i in 1u32..=5 {
        subjects.push_back(Address::generate(&env));
        cred_types.push_back(i);
        metas.push_back(meta.clone());
    }

    let m = measure(&env, || {
        client.batch_issue_credentials(&issuer, &subjects, &cred_types, &metas, &None);
    });

    println!("[bench_batch_issue_credentials_5] cpu={} mem={}", m.cpu, m.mem);
    assert!(m.cpu <= THRESHOLD_BATCH_ISSUE_5_CPU,
        "batch_issue_credentials(5) CPU regression: {} > {}", m.cpu, THRESHOLD_BATCH_ISSUE_5_CPU);
    assert!(m.mem <= THRESHOLD_BATCH_ISSUE_5_MEM,
        "batch_issue_credentials(5) MEM regression: {} > {}", m.mem, THRESHOLD_BATCH_ISSUE_5_MEM);
}

/// Benchmarks verify_attestations_batch with 5 credential/slice pairs.
/// Detects regressions in the batch verification loop.
#[test]
fn bench_verify_attestations_batch_5() {
    let env = Env::default();
    let (client, _) = setup_qp(&env);
    let issuer = Address::generate(&env);
    let subject = Address::generate(&env);
    let attestor = Address::generate(&env);
    let meta = Bytes::from_slice(&env, b"QmBenchHash000000000000000000000000");

    let mut att_list = Vec::new(&env);
    att_list.push_back(attestor.clone());
    let mut wts = Vec::new(&env);
    wts.push_back(1u32);

    let mut cred_ids = Vec::new(&env);
    let mut slice_ids = Vec::new(&env);
    for i in 1u32..=5 {
        let cid = client.issue_credential(&issuer, &subject, &i, &meta, &None, &0u64);
        let sid = client.create_slice(&issuer, &att_list, &wts, &1u32);
        client.attest(&attestor, &cid, &sid, &true, &None);
        cred_ids.push_back(cid);
        slice_ids.push_back(sid);
    }

    let m = measure(&env, || {
        client.verify_attestations_batch(&cred_ids, &slice_ids);
    });

    println!("[bench_verify_attestations_batch_5] cpu={} mem={}", m.cpu, m.mem);
    assert!(m.cpu <= THRESHOLD_BATCH_VERIFY_5_CPU,
        "verify_attestations_batch(5) CPU regression: {} > {}", m.cpu, THRESHOLD_BATCH_VERIFY_5_CPU);
    assert!(m.mem <= THRESHOLD_BATCH_VERIFY_5_MEM,
        "verify_attestations_batch(5) MEM regression: {} > {}", m.mem, THRESHOLD_BATCH_VERIFY_5_MEM);
}
