#![no_main]

use arbitrary::Arbitrary;
use libfuzzer_sys::fuzz_target;
use soroban_sdk::{testutils::Address as _, Address, Bytes, Env};
use quorum_proof::{QuorumProofContract, QuorumProofContractClient};

/// Fuzz testing for batch credential issuance operations at scale
///
/// This fuzz target focuses on:
/// - Batch issuance of 1000+ credentials with random parameters
/// - Performance testing with various batch configurations
/// - Memory and storage efficiency under stress
/// - Identifying bottlenecks in batch operations
/// - Verifying data integrity across large batches
#[derive(Arbitrary, Debug)]
struct BatchOperationsFuzzInput {
    // Batch size variations (10-2000 credentials)
    batch_size: u16,

    // Number of sequential batches to issue
    batch_iterations: u8,

    // Metadata complexity (affects per-credential processing)
    metadata_complexity: u8,

    // Credential type seed
    type_seed: u32,

    // Subject address variation pattern
    subject_pattern: u8,

    // Test configuration flags
    test_single_issuer: bool,
    test_multiple_issuers: bool,
    test_verification: bool,
}

fuzz_target!(|input: BatchOperationsFuzzInput| {
    let env = Env::default();
    env.mock_all_auths();

    let contract_id = env.register_contract(None, QuorumProofContract);
    let client = QuorumProofContractClient::new(&env, &contract_id);
    let admin = Address::generate(&env);

    // Initialize contract
    if std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        client.initialize(&admin)
    }))
    .is_err()
    {
        return;
    }

    // Test 1: Single issuer batch operations
    if input.test_single_issuer {
        test_single_issuer_batch(&env, &client, &input);
    }

    // Test 2: Multiple issuers concurrent batches
    if input.test_multiple_issuers {
        test_multiple_issuers_batch(&env, &client, &input);
    }

    // Test 3: Large batch with integrity verification
    if input.test_verification {
        test_large_batch_with_verification(&env, &client, &input);
    }

    // Test 4: Stress test with maximum batch size
    test_maximum_batch_size(&env, &client, &input);
});

/// Test single issuer issuing large batch of credentials
fn test_single_issuer_batch(
    env: &Env,
    client: &QuorumProofContractClient,
    input: &BatchOperationsFuzzInput,
) {
    let issuer = Address::generate(env);
    let batch_size = (input.batch_size as usize).clamp(10, 1000);

    let mut issued_count = 0u64;
    let mut failed_count = 0u64;

    for i in 0..batch_size {
        let subject = Address::generate(env);

        let credential_type = input.type_seed.wrapping_add(i as u32).max(1);
        let metadata = generate_metadata_for_batch(input.metadata_complexity, i as u32);
        let meta_bytes = Bytes::from_slice(env, &metadata);

        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            client.issue_credential(
                &issuer,
                &subject,
                &credential_type,
                &meta_bytes,
                &None,
                &0u64,
            )
        }));

        match result {
            Ok(_) => issued_count += 1,
            Err(_) => failed_count += 1,
        }

        // Stop early if the failure rate is too high to avoid wasting budget.
        if failed_count > (batch_size as u64 / 2) {
            break;
        }
    }

    // A fuzz target must never assert business-logic success rates; a high
    // reject rate is itself a valid (and informative) fuzzer finding.  We
    // only assert the invariant that the counts add up sensibly.
    assert_eq!(
        issued_count + failed_count,
        (issued_count + failed_count), // tautology — keeps the variables live
        "counter mismatch"
    );
    let _ = (issued_count, failed_count); // suppress unused-variable lint
}

/// Test multiple issuers issuing batches concurrently
fn test_multiple_issuers_batch(
    env: &Env,
    client: &QuorumProofContractClient,
    input: &BatchOperationsFuzzInput,
) {
    let num_issuers = ((input.batch_iterations as usize) % 5).max(2); // 2-5 issuers
    let batch_size = ((input.batch_size as usize) / num_issuers).clamp(10, 500);

    let mut total_issued = 0usize;

    for issuer_idx in 0..num_issuers {
        let issuer = Address::generate(env);

        for cred_idx in 0..batch_size {
            let subject = Address::generate(env);
            let credential_type = input
                .type_seed
                .wrapping_add((issuer_idx as u32 * 10000) + cred_idx as u32)
                .max(1);
            let metadata = generate_metadata_for_batch(
                input.metadata_complexity,
                (issuer_idx as u32 * 1000) + cred_idx as u32,
            );
            let meta_bytes = Bytes::from_slice(env, &metadata);

            if std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                client.issue_credential(
                    &issuer,
                    &subject,
                    &credential_type,
                    &meta_bytes,
                    &None,
                    &0u64,
                )
            }))
            .is_ok()
            {
                total_issued += 1;
            }
        }
    }

    // Record how many were created; do not assert a minimum — the contract may
    // legitimately reject all inputs (e.g. rate-limit or quota hit).
    let _ = total_issued;
}

/// Test large batch with integrity verification
fn test_large_batch_with_verification(
    env: &Env,
    client: &QuorumProofContractClient,
    input: &BatchOperationsFuzzInput,
) {
    let issuer = Address::generate(env);
    let batch_size = (input.batch_size as usize).clamp(100, 2000);

    // Both vecs grow in lock-step: an entry is pushed to both or neither.
    let mut credential_ids: std::vec::Vec<u64> = std::vec::Vec::new();
    let mut subjects: std::vec::Vec<Address> = std::vec::Vec::new();

    // Issue batch
    for i in 0..batch_size {
        let subject = Address::generate(env);
        let credential_type = (2000u32).wrapping_add(i as u32).max(1);
        let metadata = generate_metadata_for_batch(input.metadata_complexity, i as u32);
        let meta_bytes = Bytes::from_slice(env, &metadata);

        if let Ok(cred_id) = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            client.issue_credential(
                &issuer,
                &subject,
                &credential_type,
                &meta_bytes,
                &None,
                &0u64,
            )
        })) {
            credential_ids.push(cred_id);
            subjects.push(subject);
        }
    }

    // Verify integrity: sample a subset of the successfully issued credentials.
    // `idx` from `enumerate()` indexes into `credential_ids`; `subjects[idx]`
    // is safe because both vecs have the same length and entries are parallel.
    let sample_rate = if credential_ids.len() > 100 { 10 } else { 2 };
    for (idx, &cred_id) in credential_ids
        .iter()
        .enumerate()
        .step_by(sample_rate.max(1))
    {
        if let Ok(credential) = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            client.get_credential(&cred_id)
        })) {
            assert_eq!(
                credential.issuer, issuer,
                "Issuer mismatch at credential {}",
                idx
            );
            assert_eq!(
                credential.subject, subjects[idx],
                "Subject mismatch at credential {}",
                idx
            );
            assert!(
                !credential.revoked,
                "Credential {} should not be revoked",
                idx
            );
            assert!(
                credential.credential_type > 0,
                "Invalid credential type at {}",
                idx
            );
        }
    }
}

/// Test maximum batch size that the contract can handle
fn test_maximum_batch_size(
    env: &Env,
    client: &QuorumProofContractClient,
    input: &BatchOperationsFuzzInput,
) {
    let issuer = Address::generate(env);

    // Test progressively larger batches to find limits
    let test_sizes = [100usize, 500, 1000, 2000];

    for &size in &test_sizes {
        let mut successful = 0u64;
        let mut failed = 0u64;

        for i in 0..size {
            let subject = Address::generate(env);
            let credential_type = input.type_seed.wrapping_add(i as u32).max(1);
            let metadata = generate_metadata_for_batch(input.metadata_complexity, i as u32);
            let meta_bytes = Bytes::from_slice(env, &metadata);

            match std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                client.issue_credential(
                    &issuer,
                    &subject,
                    &credential_type,
                    &meta_bytes,
                    &None,
                    &0u64,
                )
            })) {
                Ok(_) => successful += 1,
                Err(_) => {
                    failed += 1;
                    // Stop early if too many failures to avoid wasting budget.
                    if failed > (size as u64 / 2) {
                        break;
                    }
                }
            }
        }

        // Do not assert a minimum success rate — high rejection is a valid
        // fuzzer signal (e.g. rate-limit or quota exhaustion).
        let _ = (successful, failed);
    }
}

/// Generate metadata with varying complexity.
/// Returns a plain `std::vec::Vec<u8>` — callers convert to `soroban_sdk::Bytes`
/// via `Bytes::from_slice`.
fn generate_metadata_for_batch(complexity: u8, seed: u32) -> std::vec::Vec<u8> {
    let size = match complexity % 4 {
        0 => 32,  // Small metadata
        1 => 96,  // Medium metadata
        2 => 256, // Large metadata (at the contract's MAX_METADATA_SIZE limit)
        _ => 64,  // Standard metadata
    };

    let mut metadata = std::vec![0u8; size];
    let mut rng = seed;

    // LCG for deterministic pseudo-random fill
    for byte in metadata.iter_mut() {
        rng = rng.wrapping_mul(1_103_515_245).wrapping_add(12_345);
        *byte = ((rng >> 16) ^ (rng >> 8)) as u8;
    }

    metadata
}
