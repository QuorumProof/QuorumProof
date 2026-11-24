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
    let threshold = (input.slice_threshold as u32).clamp(1, 5);

    // Create multiple credentials
    let mut credential_ids = Vec::new();
    for i in 0..cred_count {
        let issuer = Address::generate(&env);
        let subject = Address::generate(&env);
        let ctype = (i as u32).wrapping_add(1);

        let metadata = generate_fuzzy_metadata(input.proof_size);
        let meta = Bytes::from_slice(&env, &metadata);

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

        // Build attestor list and a matching weights vector (each weight = 1).
        let mut attestors = SorobanVec::new(&env);
        let mut weights = SorobanVec::new(&env);
        for _ in 0..attestor_count {
            attestors.push_back(Address::generate(&env));
            weights.push_back(1u32);
        }

        if attestors.is_empty() {
            continue;
        }

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

                // Test attestation status check
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
