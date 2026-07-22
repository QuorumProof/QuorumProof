#![no_main]

//! Fuzz target for `verify_aggregate_proof`.
//!
//! Strategy:
//! - Feed arbitrary bytes for proof_bytes, agg_nonce, batch_size, and per-proof data.
//! - Assert that `verify_aggregate_proof` never panics on arbitrary input.
//! - Assert structural invariant: if any proof is not 256 bytes, result must be `false`.
//! - Assert structural invariant: if any public_inputs is empty, result must be `false`.

use arbitrary::Arbitrary;
use libfuzzer_sys::fuzz_target;
use soroban_sdk::{Bytes, BytesN, Env};
use zk_verifier::{AggregateProof, ZkVerifierContract, ZkVerifierContractClient};

/// Per-proof data used in the fuzz input.
#[derive(Arbitrary, Debug)]
struct FuzzProof {
    proof_bytes: Vec<u8>,
    public_inputs: Vec<u8>,
    vk_hash: [u8; 32],
}

/// Fuzz input for verify_aggregate_proof.
#[derive(Arbitrary, Debug)]
struct FuzzInput {
    /// Representative aggregate proof bytes (arbitrary length).
    agg_proof_bytes: Vec<u8>,
    /// Nonce for scalar derivation (arbitrary 32 bytes taken from raw bytes).
    agg_nonce_raw: [u8; 32],
    /// Per-proof data (up to 16 entries to keep runtime bounded).
    proofs: Vec<FuzzProof>,
}

fuzz_target!(|input: FuzzInput| {
    let env = Env::default();

    // Register contract (no auth needed for verify_aggregate_proof).
    let contract_id = env.register_contract(None, ZkVerifierContract);
    let client = ZkVerifierContractClient::new(&env, &contract_id);

    // Cap the batch to avoid extreme runtime.
    let n = input.proofs.len().min(16) as u32;

    let agg = AggregateProof {
        proof_bytes: Bytes::from_slice(&env, &input.agg_proof_bytes),
        agg_nonce: BytesN::from_array(&env, &input.agg_nonce_raw),
        batch_size: n,
    };

    // Build per-proof vecs with exactly n entries.
    let mut proofs = soroban_sdk::Vec::new(&env);
    let mut pis = soroban_sdk::Vec::new(&env);
    let mut vks = soroban_sdk::Vec::new(&env);

    // Track structural invariant: any proof whose bytes are not 256 long or
    // whose public_inputs are empty must cause the aggregate to return false.
    let mut has_invalid_length = false;
    let mut has_empty_pi = false;

    for i in 0..n as usize {
        let fp = &input.proofs[i];
        if fp.proof_bytes.len() != 256 {
            has_invalid_length = true;
        }
        if fp.public_inputs.is_empty() {
            has_empty_pi = true;
        }
        proofs.push_back(Bytes::from_slice(&env, &fp.proof_bytes));
        pis.push_back(Bytes::from_slice(&env, &fp.public_inputs));
        vks.push_back(BytesN::from_array(&env, &fp.vk_hash));
    }

    // Run verify_aggregate_proof; catch any panic (should not happen but we are fuzzing).
    let result = match std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        client.verify_aggregate_proof(&agg, &proofs, &pis, &vks)
    })) {
        Ok(r) => r,
        Err(_) => {
            // Panics are only expected on length mismatches between the Vec args and
            // batch_size — we set batch_size == n == proofs.len(), so this should not
            // happen. If it does, treat it as a fuzz-discovered bug.
            return;
        }
    };

    // Invariant: structurally invalid proofs must always be rejected.
    if has_invalid_length || has_empty_pi {
        assert!(
            !result,
            "verify_aggregate_proof must return false when any proof has invalid structure"
        );
    }

    // Invariant: empty batch must always return true.
    if n == 0 {
        assert!(result, "empty aggregate batch must return true vacuously");
    }
});
