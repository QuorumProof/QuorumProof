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

    // Create multiple credentials; use a plain std::vec to collect IDs.
    let mut credential_ids: std::vec::Vec<u64> = std::vec::Vec::new();
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
        let attestor_count = (threshold as usize).clamp(1, 5);

        // Build the attestors and weights vectors for create_slice
        let mut attestors: SorobanVec<Address> = SorobanVec::new(&env);
        let mut weights: SorobanVec<u32> = SorobanVec::new(&env);
        for _ in 0..attestor_count {
            attestors.push_back(Address::generate(&env));
            weights.push_back(1u32);
        }

        if attestors.is_empty() {
            continue;
        }

        // The creator of the slice (required by create_slice)
        let creator = Address::generate(&env);

        // create_slice(env, creator, attestors, weights, threshold) -> u64
        let slice_id = match std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            client.create_slice(&creator, &attestors, &weights, &threshold)
        })) {
            Ok(id) => id,
            Err(_) => continue,
        };

        // Test attestation for each credential
        for &credential_id in &credential_ids {
            // Get first attestor from the slice
            if let Ok(Some(attestor)) = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                attestors.get(0)
            })) {
                // attest(env, attestor, credential_id, slice_id, attestation_value, expires_at)
                let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                    client.attest(&attestor, &credential_id, &slice_id, &true, &None)
                }));

                // is_attested(env, credential_id, slice_id)
                let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                    client.is_attested(&credential_id, &slice_id)
                }));

                // get_attestors(env, credential_id)  — takes only credential_id
                let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                    client.get_attestors(&credential_id)
                }));
            }
        }
    }
});

/// Returns a plain `std::vec::Vec<u8>` — callers convert to `soroban_sdk::Bytes`
/// via `Bytes::from_slice`.
fn generate_fuzzy_metadata(size: u8) -> std::vec::Vec<u8> {
    let meta_size = (size as usize).clamp(1, 256);
    let mut metadata = std::vec![0u8; meta_size];

    for i in 0..meta_size {
        metadata[i] = ((i as u8).wrapping_mul(size)).wrapping_add(i as u8);
    }

    metadata
}
