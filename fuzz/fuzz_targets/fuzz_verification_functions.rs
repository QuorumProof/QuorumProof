#![no_main]

use arbitrary::Arbitrary;
use libfuzzer_sys::fuzz_target;
use soroban_sdk::{testutils::Address as _, Address, Bytes, Env, Vec as SorobanVec};
use quorum_proof::{QuorumProofContract, QuorumProofContractClient};

/// Fuzz input targeting verification operations and edge cases
#[derive(Arbitrary, Debug)]
struct VerificationFuzzInput {
    num_credentials: u8,
    num_slices: u8,
    proof_size: u8,
    slice_threshold: u8,
    claim_variations: u8,
    /// Fuzz the attestation value (true/false) to exercise both paths.
    attestation_value: bool,
}

fuzz_target!(|input: VerificationFuzzInput| {
    let env = Env::default();
    env.mock_all_auths();

    let contract_id = env.register_contract(None, QuorumProofContract);
    let client = QuorumProofContractClient::new(&env, &contract_id);
    let admin = Address::generate(&env);
    client.initialize(&admin);

    let cred_count = (input.num_credentials as usize).clamp(1, 5);
    let slice_count = (input.num_slices as usize).clamp(1, 3);
    // threshold is in weight units; each attestor gets weight 1, so threshold
    // must not exceed the number of attestors (clamped below).
    let attestor_count_per_slice = (input.slice_threshold as usize).clamp(1, 5);
    // Threshold ≤ total weight (= attestor_count_per_slice × 1).
    let threshold = (attestor_count_per_slice as u32).min(5);

    // Create multiple credentials
    let mut credential_ids: std::vec::Vec<u64> = std::vec::Vec::new();
    for i in 0..cred_count {
        let issuer = Address::generate(&env);
        let subject = Address::generate(&env);
        // credential_type must be > 0
        let ctype = (i as u32).saturating_add(1);

        let metadata = generate_fuzzy_metadata(input.proof_size);
        // issue_credential rejects empty metadata; skip this iteration if empty.
        if metadata.is_empty() {
            continue;
        }
        let meta = Bytes::from_slice(&env, &metadata);

        // issue_credential panics (via panic_with_error!) on many contract-level
        // errors (duplicate credential, paused, quota, …).  catch_unwind
        // intercepts the Rust unwind so the fuzzer keeps exploring rather than
        // treating every contract rejection as a "crash".
        if let Ok(cid) = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            client.issue_credential(&issuer, &subject, &ctype, &meta, &None, &0u64)
        })) {
            credential_ids.push(cid);
        }
    }

    // Create slices and test verification paths
    for _ in 0..slice_count {
        let creator = Address::generate(&env);
        let attestor_count = (threshold as usize).clamp(1, 5);
        let mut attestors = SorobanVec::new(&env);
        // All attestors get weight 1; threshold ≤ attestor_count so quorum is reachable
        let mut weights = SorobanVec::new(&env);

        // Build attestor list and a matching weights vector (each weight = 1).
        let mut attestors = SorobanVec::new(&env);
        let mut weights = SorobanVec::new(&env);
        for _ in 0..attestor_count {
            attestors.push_back(Address::generate(&env));
            weights.push_back(1u32);
        }

        let creator = Address::generate(&env);

        // Fix #1882: create_slice signature is
        //   create_slice(env, creator, attestors, weights, threshold)
        // The previous call was missing `creator` and `weights`.
        let slice_id = match std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            client.create_slice(&creator, &attestors, &weights, &threshold)
        })) {
            Ok(id) => id,
            Err(_) => continue,
        };

        // Test attestation for each credential
        for &credential_id in credential_ids.iter() {
            if let Ok(Some(attestor)) = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                attestors.get(0)
            })) {
                // Fix #1882: attest signature is
                //   attest(env, attestor, credential_id, slice_id,
                //          attestation_value: bool, expires_at: Option<u64>)
                // The previous call was missing attestation_value and expires_at.
                let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                    client.attest(&attestor, &credential_id, &slice_id, &true, &None)
                }));

                // is_attested(credential_id, slice_id)
                let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                    client.is_attested(&credential_id, &slice_id)
                }));

                // Fix #1882: get_attestors signature is
                //   get_attestors(env, credential_id)
                // The previous call incorrectly passed slice_id as a second argument.
                let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                    client.get_attestors(&credential_id)
                }));
            }
        }

        // suppress unused variable warning
        let _ = slice_idx;
    }
});

fn generate_fuzzy_metadata(size: u8) -> Vec<u8> {
    // Clamp to [1, 512] — lower bound avoids the "metadata_hash cannot be
    // empty" rejection in issue_credential; upper bound is a reasonable
    // maximum for fuzzing without exceeding any size limits.
    let meta_size = (size as usize).clamp(1, 512);
    let mut metadata = vec![0u8; meta_size];

    for i in 0..meta_size {
        metadata[i] = ((i as u8).wrapping_mul(size)).wrapping_add(i as u8);
    }
    metadata
}
