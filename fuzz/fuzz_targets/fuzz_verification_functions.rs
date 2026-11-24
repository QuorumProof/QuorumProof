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

    // Build a non-empty metadata payload so the contract's non-empty assertion
    // is satisfied. Minimum 1 byte; maximum 256 bytes (MAX_METADATA_SIZE).
    let metadata = generate_fuzzy_metadata(input.proof_size);
    // Always at least 1 byte — the contract panics on empty metadata.
    let metadata_clamped = if metadata.is_empty() { vec![0u8] } else { metadata };

    // Create multiple credentials
    let mut credential_ids = Vec::new();
    for i in 0..cred_count {
        let issuer = Address::generate(&env);
        let subject = Address::generate(&env);
        // credential_type must be > 0
        let ctype = (i as u32).saturating_add(1);

        let meta = Bytes::from_slice(&env, &metadata_clamped);

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
        let mut attestors = SorobanVec::new(&env);
        // Weights: one weight-1 entry per attestor so threshold semantics are
        // straightforward.
        let mut weights = SorobanVec::<u32>::new(&env);

        for _ in 0..attestor_count_per_slice {
            attestors.push_back(Address::generate(&env));
            weights.push_back(1u32);
        }

        if attestors.is_empty() {
            continue;
        }

        // create_slice(creator, attestors, weights, threshold) → slice_id
        let slice_id = match std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            client.create_slice(&creator, &attestors, &weights, &threshold)
        })) {
            Ok(id) => id,
            Err(_) => continue,
        };

        // Test attestation for each credential
        for &credential_id in credential_ids.iter() {
            // Get the first attestor address from the SorobanVec.
            // SorobanVec::get returns Option<T>.
            if let Some(attestor) = attestors.get(0) {
                // attest(attestor, credential_id, slice_id, attestation_value, expires_at)
                let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                    client.attest(
                        &attestor,
                        &credential_id,
                        &slice_id,
                        &input.attestation_value,
                        &None::<u64>,
                    )
                }));

                // is_attested(credential_id, slice_id)
                let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                    client.is_attested(&credential_id, &slice_id)
                }));

                // get_attestors(credential_id) — takes only credential_id, not slice_id
                let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                    client.get_attestors(&credential_id)
                }));
            }
        }
    }
});

fn generate_fuzzy_metadata(size: u8) -> Vec<u8> {
    // MAX_METADATA_SIZE in the contract is 256 bytes; stay inside that limit.
    let meta_size = (size as usize).clamp(0, 255);
    let mut metadata = vec![0u8; meta_size];
    for i in 0..meta_size {
        metadata[i] = ((i as u8).wrapping_mul(size)).wrapping_add(i as u8);
    }
    metadata
}
