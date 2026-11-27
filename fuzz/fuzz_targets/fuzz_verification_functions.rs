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
    // threshold is a weight unit; each attestor gets weight 1, so clamp to
    // the maximum attestor count so a valid threshold is always reachable.
    let threshold = (input.slice_threshold as u32).clamp(1, 5);

    // Create multiple credentials
    let mut credential_ids = std::vec::Vec::new();
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
    for slice_idx in 0..slice_count {
        let attestor_count = (threshold as usize).clamp(1, 5);

        let mut attestors = SorobanVec::new(&env);
        let mut weights = SorobanVec::<u32>::new(&env);

        for _ in 0..attestor_count {
            attestors.push_back(Address::generate(&env));
            weights.push_back(1u32);
        }

        if attestors.is_empty() {
            continue;
        }

        // The creator of a slice can be any address (uses require_auth, mocked).
        let creator = Address::generate(&env);

        // Create slice — signature: create_slice(creator, attestors, weights, threshold)
        let slice_id = match std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            client.create_slice(&creator, &attestors, &weights, &threshold)
        })) {
            Ok(id) => id,
            Err(_) => continue,
        };

        // Test attestation for each credential
        for &credential_id in credential_ids.iter() {
            // Get first attestor from the slice
            if let Some(attestor) = attestors.get(0) {
                // Test attestation — signature: attest(attestor, credential_id, slice_id,
                //                                      attestation_value, expires_at)
                let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                    client.attest(&attestor, &credential_id, &slice_id, &true, &None)
                }));

                // Test attestation status check — signature: is_attested(credential_id, slice_id)
                let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                    client.is_attested(&credential_id, &slice_id)
                }));

                // Test get_attestors — signature: get_attestors(credential_id)
                // Note: get_attestors returns all attestors for a credential across all
                // slices; it does not accept a slice_id parameter.
                let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                    client.get_attestors(&credential_id)
                }));
            }
        }

        // suppress unused variable warning
        let _ = slice_idx;
    }
});

fn generate_fuzzy_metadata(size: u8) -> std::vec::Vec<u8> {
    let meta_size = (size as usize).clamp(1, 256);
    let mut metadata = std::vec![0u8; meta_size];

    for i in 0..meta_size {
        metadata[i] = ((i as u8).wrapping_mul(size)).wrapping_add(i as u8);
    }

    metadata
}
