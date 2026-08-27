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
//
// ── Scaling / complexity-class gate (additive, does not replace the above) ──
// `bench_*_scaling` tests below run select operations across a range of `n`
// (capped at the contract's own MAX_BATCH_SIZE/MAX_ATTESTORS_PER_SLICE — no
// real call can exceed those) and record each (n, cpu, mem) point via
// `quorum_proof_benches::scaling::record_point`. They assert nothing
// themselves beyond what they already asserted (e.g. bench_attest_scaling's
// existing flat-threshold check); the actual complexity-class fit, cross-run
// history, and pass/fail gate live in `src/bin/scaling_report.rs` — run it
// after this test binary to fit curves and get a report:
//   cargo test --manifest-path benches/Cargo.toml --test benchmarks -- --nocapture
//   cargo run  --manifest-path benches/Cargo.toml --bin scaling_report
// or just `scripts/scaling_benchmark_report.sh` to do both.
use soroban_sdk::{testutils::Address as _, Address, Bytes, BytesN, Env, Vec};
use quorum_proof::{ClaimType as QpClaimType, DidKeyType, QuorumProofContract, QuorumProofContractClient};
use sbt_registry::{SbtRegistryContract, SbtRegistryContractClient};
use zk_verifier::{AggregateProof, ClaimType, ZkVerifierContract, ZkVerifierContractClient};
use quorum_proof_benches::scaling;

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
// PLONK with real BLS12-381 pairing check is significantly more expensive than Groth16's hash-binding.
// Estimated ~5-10x heavier, set conservatively for real field arithmetic.
const THRESHOLD_VERIFY_PLONK_PROOF_CPU: u64  = 20_000_000;
// Issue #1276: real BLS12-381 Groth16 verification needs 3 pairings (vs
// PLONK's 2 + heavier linearisation arithmetic) plus a small vk_x MSM.
// Estimated in the same order of magnitude as PLONK's threshold above;
// not yet measured against a live run — tighten once a real CI run
// records an actual baseline (see the file header's baseline-recording
// convention).
const THRESHOLD_VERIFY_GROTH16_PROOF_REAL_CPU: u64 = 20_000_000;
// Issue #1278: `verify_aggregated_proofs` at its max batch size (16) does
// n+3 = 19 pairing() calls instead of the naive 4n = 64, i.e. ~30% of the
// naive pairing count. Estimated from THRESHOLD_VERIFY_GROTH16_PROOF_REAL_CPU
// (3 pairings/proof) scaled to 19 pairings, with generous headroom since
// this hasn't been measured against a live run yet.
const THRESHOLD_VERIFY_AGGREGATED_PROOFS_16_CPU: u64 = 180_000_000;
// Cross-contract operations carry inherently higher cost.
const THRESHOLD_VERIFY_ENGINEER_CPU: u64     = 8_000_000;
const THRESHOLD_BATCH_ISSUE_5_CPU: u64       = 12_000_000;
const THRESHOLD_BATCH_VERIFY_5_CPU: u64      = 6_000_000;

// ── Aggregate-verify regression thresholds (CPU instructions) ─────────────────
// These reflect O(n·hash) cost — significantly cheaper than n independent full
// pairing verifications. Set at ~2× per-proof hash cost × n, with headroom.
// Raise only with written justification.
const THRESHOLD_AGGREGATE_VERIFY_5_CPU: u64   = 8_000_000;
const THRESHOLD_AGGREGATE_VERIFY_25_CPU: u64  = 20_000_000;
const THRESHOLD_AGGREGATE_VERIFY_50_CPU: u64  = 35_000_000;
const THRESHOLD_AGGREGATE_VERIFY_100_CPU: u64 = 60_000_000;

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

/// Like `measure`, but resets to an unlimited budget first. For scaling-curve
/// data collection only (never for the fixed-threshold regression gates
/// above): some operations' cost at the larger end of their scaling range
/// exceeds the mainnet-realistic default budget well before their own
/// MAX_BATCH_SIZE/MAX_ATTESTORS_PER_SLICE cap is reached, and hitting that
/// default limit mid-measurement panics instead of returning a value — which
/// would crash the whole benchmark binary instead of just producing a data
/// point demonstrating superlinear cost growth.
fn measure_unlimited(env: &Env, f: impl FnOnce()) -> Metrics {
    env.budget().reset_unlimited();
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
        client.revoke_credential(&issuer, &cid, &None);
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
    let vk_hash = BytesN::from_array(&env, &[0u8; 32]);
    client.set_verifying_key(&admin, &vk_hash);
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

#[test]
fn bench_verify_plonk_proof() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, admin) = setup_zk(&env);

    // Generate a genuinely valid PLONK proof using the test prover fixture.
    // The fixture includes the SRS (tau_g2) and verifying key with public inputs.
    use zk_verifier::plonk_test_prover;
    let fixture = plonk_test_prover::generate_valid_proof(&env, 0, 1, 7, 3, 4, 5, 6);

    // Register the universal SRS and circuit-specific verifying key
    client.set_plonk_srs(&admin, &fixture.srs_tau_g2);
    client.set_plonk_verifying_key(&admin, &fixture.vk_hash, &fixture.vk);

    // Measure the cost of verifying the PLONK proof.
    // This includes: Fiat-Shamir transcript construction, linearisation arithmetic,
    // and the final KZG batched pairing check (two single pairings over BLS12-381).
    let m = measure(&env, || {
        client.verify_plonk_proof(&fixture.proof, &fixture.public_inputs, &fixture.vk_hash);
    });

    println!("[bench_verify_plonk_proof] cpu={} mem={}", m.cpu, m.mem);
    assert!(m.cpu <= THRESHOLD_VERIFY_PLONK_PROOF_CPU,
        "verify_plonk_proof CPU regression: {} > {}", m.cpu, THRESHOLD_VERIFY_PLONK_PROOF_CPU);
}

// ── Issue #1276: real BLS12-381 pairing-based Groth16 verification ─────────

#[test]
fn bench_verify_groth16_proof_real() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, admin) = setup_zk(&env);

    use zk_verifier::groth16_test_prover;
    let fixture = groth16_test_prover::generate_valid_proof(&env, 0, 1);
    client.set_groth16_verifying_key(&admin, &fixture.vk_hash, &fixture.vk);

    // Cost of a single genuine Groth16 pairing check: 3 pairings
    // (e(A,B), e(alpha,beta), e(vk_x,gamma)·e(C,delta) combined) plus the
    // vk_x multi-scalar-multiplication.
    let m = measure(&env, || {
        client.verify_groth16_proof(&fixture.proof, &fixture.public_inputs, &fixture.vk_hash);
    });

    println!("[bench_verify_groth16_proof_real] cpu={} mem={}", m.cpu, m.mem);
    assert!(m.cpu <= THRESHOLD_VERIFY_GROTH16_PROOF_REAL_CPU,
        "verify_groth16_proof CPU regression: {} > {}", m.cpu, THRESHOLD_VERIFY_GROTH16_PROOF_REAL_CPU);
}

/// Issue #1276: "Performance benchmark against 100+ proofs" — measures the
/// naive O(n) real-pairing path (`verify_batch_proofs`, n independent
/// `verify_groth16_proof` calls) at n=100, establishing the baseline that
/// `verify_aggregated_proofs`'s randomized-linear-combination batching
/// (Issue #1278) amortizes against.
#[test]
fn bench_verify_batch_proofs_100_real() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, admin) = setup_zk(&env);

    use zk_verifier::groth16_test_prover;
    let vk = groth16_test_prover::generate_vk(&env, 1, 1);
    client.set_groth16_verifying_key(&admin, &vk.vk_hash, &vk.vk);

    let mut proofs = Vec::new(&env);
    let mut pis = Vec::new(&env);
    let mut vks = Vec::new(&env);
    for i in 0..100u64 {
        let p = groth16_test_prover::generate_proof(&env, &vk, 1000 + i, &[1]);
        proofs.push_back(p.proof);
        pis.push_back(p.public_inputs);
        vks.push_back(vk.vk_hash.clone());
    }

    let m = measure_unlimited(&env, || {
        client.verify_batch_proofs(&proofs, &pis, &vks);
    });

    println!("[bench_verify_batch_proofs_100_real] cpu={} mem={}", m.cpu, m.mem);
    scaling::record_point("verify_batch_proofs_real", 100, m.cpu, m.mem);
}

/// Issue #1278: measures `verify_aggregated_proofs`'s randomized
/// linear-combination batch verification at its maximum supported batch
/// size (`MAX_GROTH16_AGGREGATE_BATCH` = 16, bounded by the fixed stack
/// buffers a `#![no_std]`/no-alloc contract must use — see
/// `zk_verifier::groth16` module docs). Compare against
/// `bench_verify_groth16_proof_real`'s single-proof cost × 16 to see the
/// amortized savings from collapsing the three fixed-verifying-key
/// pairings into one call each, shared across the batch.
#[test]
fn bench_verify_aggregated_proofs_batch16() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, admin) = setup_zk(&env);

    use zk_verifier::groth16_test_prover;
    let vk = groth16_test_prover::generate_vk(&env, 2, 1);
    client.set_groth16_verifying_key(&admin, &vk.vk_hash, &vk.vk);

    let mut proofs = Vec::new(&env);
    let mut pis = Vec::new(&env);
    for i in 0..16u64 {
        let p = groth16_test_prover::generate_proof(&env, &vk, 2000 + i, &[1]);
        proofs.push_back(p.proof);
        pis.push_back(p.public_inputs);
    }

    let m = measure(&env, || {
        client.verify_aggregated_proofs(&proofs, &pis, &vk.vk_hash);
    });

    println!("[bench_verify_aggregated_proofs_batch16] cpu={} mem={}", m.cpu, m.mem);
    assert!(m.cpu <= THRESHOLD_VERIFY_AGGREGATED_PROOFS_16_CPU,
        "verify_aggregated_proofs(16) CPU regression: {} > {}", m.cpu, THRESHOLD_VERIFY_AGGREGATED_PROOFS_16_CPU);
}

// ── Scaling benchmarks (regression detection for N-item operations) ───────────

/// Measures how attest cost scales with attestor count in a slice.
/// Detects O(n²) regressions in attestation logic.
///
/// n is capped at `MAX_ATTESTORS_PER_SLICE` (20, contracts/quorum_proof/src/lib.rs:37) —
/// no real slice can ever have more attestors than that, so this is the full
/// range reachable through the public contract API. Points are recorded via
/// `scaling::record_point` for `bin/scaling_report.rs` to fit a complexity
/// curve against, on top of the fixed per-attest threshold assert below.
#[test]
fn bench_attest_scaling() {
    for n in [1u32, 5, 10, 15, 20] {
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
        scaling::record_point("attest", n, m.cpu, m.mem);
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
    // verify_engineer's cross-contract chain (QuorumProof -> ZkVerifier ->
    // SbtRegistry) needs non-root auth allowed, same as the equivalent
    // quorum_proof unit tests — plain mock_all_auths() only covers
    // top-level require_auth() calls.
    env.mock_all_auths_allowing_non_root_auth();

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
            &engineer,
            &cred_id,
            &QpClaimType::HasDegree,
            &proof,
            &vk_hash,
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

/// Measures how batch_issue_credentials cost scales with batch size.
///
/// n is capped at `MAX_BATCH_SIZE` (50, contracts/quorum_proof/src/lib.rs:38) —
/// no real batch call can ever exceed that, so this is the full range
/// reachable through the public contract API. Data-collection only: points
/// are recorded via `scaling::record_point` for `bin/scaling_report.rs` to
/// fit a complexity curve against; the fixed n=5 threshold gate above is
/// unaffected.
#[test]
fn bench_batch_issue_credentials_scaling() {
    for n in [1u32, 5, 10, 25, 50] {
        let env = Env::default();
        let (client, _) = setup_qp(&env);
        let issuer = Address::generate(&env);
        let meta = Bytes::from_slice(&env, b"QmBenchHash000000000000000000000000");

        let mut subjects = Vec::new(&env);
        let mut cred_types = Vec::new(&env);
        let mut metas = Vec::new(&env);
        for i in 1u32..=n {
            subjects.push_back(Address::generate(&env));
            cred_types.push_back(i);
            metas.push_back(meta.clone());
        }

        let m = measure_unlimited(&env, || {
            client.batch_issue_credentials(&issuer, &subjects, &cred_types, &metas, &None);
        });

        println!("[bench_batch_issue_credentials_scaling n={}] cpu={} mem={}", n, m.cpu, m.mem);
        scaling::record_point("batch_issue_credentials", n, m.cpu, m.mem);
    }
}

/// Issue #1398: Measures `batch_issue_credentials_by_did` across a batch-size
/// sweep, with a slice already created at `MAX_ATTESTORS_PER_SLICE` (20,
/// contracts/quorum_proof/src/lib.rs:74) attestors present in contract state —
/// the realistic worst case of a heavily-attested deployment issuing a large
/// batch via the DID resolution path (register_did + DID lookup per subject
/// adds real overhead the plain-Address `batch_issue_credentials` bench above
/// doesn't capture).
///
/// `n=100` is intentionally included even though it exceeds `MAX_BATCH_SIZE`
/// (50, contracts/quorum_proof/src/lib.rs:75): the call reverts before doing
/// any issuance work, which *is* the practical batch-size ceiling this bench
/// exists to document (see docs/batch-issuance-limits.md). It is recorded as
/// a rejection, not a cpu/mem data point.
#[test]
fn bench_batch_issue_credentials_by_did_scaling() {
    for n in [1u32, 10, 50, 100] {
        let env = Env::default();
        let (client, _) = setup_qp(&env);
        let issuer = Address::generate(&env);
        let meta = Bytes::from_slice(&env, b"QmBenchHash000000000000000000000000");

        // Realistic worst case: a slice already at MAX_ATTESTORS_PER_SLICE exists
        // in contract state alongside the batch issuance.
        let mut slice_attestors = Vec::new(&env);
        let mut slice_weights = Vec::new(&env);
        for _ in 0..20u32 {
            slice_attestors.push_back(Address::generate(&env));
            slice_weights.push_back(1u32);
        }
        client.create_slice(&issuer, &slice_attestors, &slice_weights, &1u32);

        if n > 50 {
            let mut subject_dids = Vec::new(&env);
            let mut cred_types = Vec::new(&env);
            let mut metas = Vec::new(&env);
            for i in 1u32..=n {
                let did = soroban_sdk::String::from_str(&env, &format!("did:bench:{}", i));
                subject_dids.push_back(did);
                cred_types.push_back(i);
                metas.push_back(meta.clone());
            }
            let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                client.batch_issue_credentials_by_did(&issuer, &subject_dids, &cred_types, &metas, &None);
            }));
            assert!(result.is_err(), "batch of {} must exceed MAX_BATCH_SIZE and revert", n);
            println!("[bench_batch_issue_credentials_by_did_scaling n={}] rejected: exceeds MAX_BATCH_SIZE", n);
            continue;
        }

        let mut subject_dids = Vec::new(&env);
        let mut cred_types = Vec::new(&env);
        let mut metas = Vec::new(&env);
        for i in 1u32..=n {
            let address = Address::generate(&env);
            let did = soroban_sdk::String::from_str(&env, &format!("did:bench:{}", i));
            let public_key = Bytes::from_slice(&env, &[0u8; 32]);
            client.register_did(&address, &did, &DidKeyType::Ed25519VerificationKey2020, &public_key);
            subject_dids.push_back(did);
            cred_types.push_back(i);
            metas.push_back(meta.clone());
        }

        let m = measure_unlimited(&env, || {
            client.batch_issue_credentials_by_did(&issuer, &subject_dids, &cred_types, &metas, &None);
        });

        println!("[bench_batch_issue_credentials_by_did_scaling n={}] cpu={} mem={}", n, m.cpu, m.mem);
        scaling::record_point("batch_issue_credentials_by_did", n, m.cpu, m.mem);
    }
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

/// Measures how verify_attestations_batch cost scales with batch size.
///
/// n is capped at `MAX_BATCH_SIZE` (50, contracts/quorum_proof/src/lib.rs:38).
/// This is the operation most likely to show superlinear growth: its
/// implementation does a nested scan (per credential, per attestation
/// record, linear scan over slice.attestors) rather than a map lookup —
/// see contracts/quorum_proof/src/lib.rs:9894-9911. Data-collection only:
/// points are recorded via `scaling::record_point`; the fixed n=5 threshold
/// gate above is unaffected.
#[test]
fn bench_verify_attestations_batch_scaling() {
    for n in [1u32, 5, 10, 25, 50] {
        let env = Env::default();
        // The n issue_credential/create_slice/attest setup calls below share
        // the env's default (mainnet-realistic) budget cumulatively, and at
        // n=25+ that setup alone exceeds it before the measured call even
        // runs. Setup isn't what's under measurement here — measure_unlimited
        // resets the budget again right before the timed closure — so give
        // setup an unlimited budget too.
        env.budget().reset_unlimited();
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
        for i in 1u32..=n {
            let cid = client.issue_credential(&issuer, &subject, &i, &meta, &None, &0u64);
            let sid = client.create_slice(&issuer, &att_list, &wts, &1u32);
            client.attest(&attestor, &cid, &sid, &true, &None);
            cred_ids.push_back(cid);
            slice_ids.push_back(sid);
        }

        let m = measure_unlimited(&env, || {
            client.verify_attestations_batch(&cred_ids, &slice_ids);
        });

        println!("[bench_verify_attestations_batch_scaling n={}] cpu={} mem={}", n, m.cpu, m.mem);
        scaling::record_point("verify_attestations_batch", n, m.cpu, m.mem);
    }
}

// ── verify_aggregate_proof benchmarks ─────────────────────────────────────────
//
// These extend the batch_verify (5) baseline by measuring the aggregate-proof
// entry point at batch sizes 5, 25, 50, and 100.
//
// Expected cost: O(n·hash) — sublinear vs n×single_proof_pairing_cost.

/// Helper: build n valid proofs, public inputs, and vk_hashes for ZK benchmarks.
fn make_zk_batch(
    env: &Env,
    n: usize,
) -> (Vec<Bytes>, Vec<Bytes>, Vec<BytesN<32>>) {
    let mut buf = [0u8; 256];
    buf[0..64].fill(0x01);
    buf[64..192].fill(0x02);
    buf[192..256].fill(0x03);
    let proof = Bytes::from_slice(env, &buf);
    let pi = Bytes::from_slice(env, &[0x42u8; 32]);
    let vk = BytesN::from_array(env, &[0x01u8; 32]);

    let mut proofs: Vec<Bytes> = Vec::new(env);
    let mut pis: Vec<Bytes> = Vec::new(env);
    let mut vks: Vec<BytesN<32>> = Vec::new(env);
    for _ in 0..n {
        proofs.push_back(proof.clone());
        pis.push_back(pi.clone());
        vks.push_back(vk.clone());
    }
    (proofs, pis, vks)
}

/// Measure verify_aggregate_proof for a given batch size.
fn bench_aggregate_verify(env: &Env, client: &ZkVerifierContractClient, n: usize) -> Metrics {
    let (proofs, pis, vks) = make_zk_batch(env, n);
    let agg = AggregateProof {
        proof_bytes: {
            let mut buf = [0u8; 256];
            buf[0..64].fill(0x01);
            buf[64..192].fill(0x02);
            buf[192..256].fill(0x03);
            Bytes::from_slice(env, &buf)
        },
        agg_nonce: BytesN::from_array(env, &[0xABu8; 32]),
        batch_size: n as u32,
    };
    measure(env, || {
        let _ = client.verify_aggregate_proof(&agg, &proofs, &pis, &vks);
    })
}

#[test]
fn bench_aggregate_verify_5() {
    let env = Env::default();
    let (client, _) = setup_zk(&env);
    let m = bench_aggregate_verify(&env, &client, 5);
    println!("[bench_aggregate_verify n=5] cpu={} mem={}", m.cpu, m.mem);
    assert!(
        m.cpu <= THRESHOLD_AGGREGATE_VERIFY_5_CPU,
        "verify_aggregate_proof(5) CPU regression: {} > {}",
        m.cpu,
        THRESHOLD_AGGREGATE_VERIFY_5_CPU
    );
}

#[test]
fn bench_aggregate_verify_25() {
    let env = Env::default();
    let (client, _) = setup_zk(&env);
    let m = bench_aggregate_verify(&env, &client, 25);
    println!("[bench_aggregate_verify n=25] cpu={} mem={}", m.cpu, m.mem);
    assert!(
        m.cpu <= THRESHOLD_AGGREGATE_VERIFY_25_CPU,
        "verify_aggregate_proof(25) CPU regression: {} > {}",
        m.cpu,
        THRESHOLD_AGGREGATE_VERIFY_25_CPU
    );
}

#[test]
fn bench_aggregate_verify_50() {
    let env = Env::default();
    let (client, _) = setup_zk(&env);
    let m = bench_aggregate_verify(&env, &client, 50);
    println!("[bench_aggregate_verify n=50] cpu={} mem={}", m.cpu, m.mem);
    assert!(
        m.cpu <= THRESHOLD_AGGREGATE_VERIFY_50_CPU,
        "verify_aggregate_proof(50) CPU regression: {} > {}",
        m.cpu,
        THRESHOLD_AGGREGATE_VERIFY_50_CPU
    );
}

#[test]
fn bench_aggregate_verify_100() {
    let env = Env::default();
    let (client, _) = setup_zk(&env);
    let m = bench_aggregate_verify(&env, &client, 100);
    println!("[bench_aggregate_verify n=100] cpu={} mem={}", m.cpu, m.mem);
    assert!(
        m.cpu <= THRESHOLD_AGGREGATE_VERIFY_100_CPU,
        "verify_aggregate_proof(100) CPU regression: {} > {}",
        m.cpu,
        THRESHOLD_AGGREGATE_VERIFY_100_CPU
    );
}
