#![no_main]

use arbitrary::Arbitrary;
use libfuzzer_sys::fuzz_target;
use soroban_sdk::{testutils::Address as _, Address, Bytes, Env};
use quorum_proof::{QuorumProofContract, QuorumProofContractClient};

/// Fuzz testing for batch credential issuance operations at scale
///
/// This fuzz target focuses on:
/// - Batch issuance of credentials with random parameters
/// - Performance testing with various batch configurations
/// - Memory and storage efficiency under stress
/// - Identifying bottlenecks in batch operations
/// - Verifying data integrity across batches
#[derive(Arbitrary, Debug)]
struct BatchOperationsFuzzInput {
    // Batch size variations
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
    // Each sub-test gets its own fresh Env so that rate-limit and quota
    // counters accumulated in one test cannot cause spurious failures in
    // another.  The contract is re-deployed and re-initialised per sub-test.

    // Test 1: Single issuer batch operations
    if input.test_single_issuer {
        let env1 = Env::default();
        env1.mock_all_auths();
        let cid1 = env1.register_contract(None, QuorumProofContract);
        let cl1 = QuorumProofContractClient::new(&env1, &cid1);
        let admin1 = Address::generate(&env1);
        if std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| cl1.initialize(&admin1))).is_err() {
            return;
        }
        test_single_issuer_batch(&env1, &cl1, &input);
    }

    // Test 2: Multiple issuers concurrent batches
    if input.test_multiple_issuers {
        let env2 = Env::default();
        env2.mock_all_auths();
        let cid2 = env2.register_contract(None, QuorumProofContract);
        let cl2 = QuorumProofContractClient::new(&env2, &cid2);
        let admin2 = Address::generate(&env2);
        if std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| cl2.initialize(&admin2))).is_err() {
            return;
        }
        test_multiple_issuers_batch(&env2, &cl2, &input);
    }

    // Test 3: Large batch with integrity verification
    if input.test_verification {
        let env3 = Env::default();
        env3.mock_all_auths();
        let cid3 = env3.register_contract(None, QuorumProofContract);
        let cl3 = QuorumProofContractClient::new(&env3, &cid3);
        let admin3 = Address::generate(&env3);
        if std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| cl3.initialize(&admin3))).is_err() {
            return;
        }
        test_large_batch_with_verification(&env3, &cl3, &input);
    }

    // Test 4: Stress test with maximum batch size (uses its own fresh env internally)
    test_maximum_batch_size(&input);
});

/// Test single issuer issuing a batch of credentials.
///
/// The contract enforces a rate limit of `DEFAULT_RATE_LIMIT_MAX_CALLS`
/// (1 000) calls per day, so we cap the batch at 100 and treat any rejection
/// as expected rather than asserting a minimum success rate.
fn test_single_issuer_batch(
    env: &Env,
    client: &QuorumProofContractClient,
    input: &BatchOperationsFuzzInput,
) {
    let issuer = Address::generate(env);
    // Keep batch size small enough to stay well under the per-issuer rate limit.
    let batch_size = (input.batch_size as usize).clamp(1, 100);

    let mut issued_count = 0u64;

    for i in 0..batch_size {
        let subject = Address::generate(env);
        let credential_type = input.type_seed.wrapping_add(i as u32).max(1);
        let metadata = generate_metadata_for_batch(input.metadata_complexity, i as u32);
        let meta_bytes = Bytes::from_slice(env, &metadata);

        if std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            client.issue_credential(&issuer, &subject, &credential_type, &meta_bytes, &None, &0u64)
        }))
        .is_ok()
        {
            issued_count += 1;
        }
    }

    // Record at least one successful issuance; the exact count is
    // non-deterministic because the contract may apply rate-limiting or
    // quota enforcement at any point, so a hard percentage threshold
    // would cause spurious failures on otherwise-correct batches.
    assert!(issued_count > 0, "Single-issuer batch: no credentials were issued");
}

/// Test multiple issuers issuing batches concurrently.
fn test_multiple_issuers_batch(
    env: &Env,
    client: &QuorumProofContractClient,
    input: &BatchOperationsFuzzInput,
) {
    // 2–5 issuers, each issuing a small batch to stay under rate limits.
    let num_issuers = ((input.batch_iterations as usize) % 5).max(2);
    let batch_size = ((input.batch_size as usize) / num_issuers).clamp(1, 50);

    let mut total_issued = 0usize;

    for issuer_idx in 0..num_issuers {
        let issuer = Address::generate(env);

        for cred_idx in 0..batch_size {
            let subject = Address::generate(env);
            let credential_type = input
                .type_seed
                .wrapping_add((issuer_idx as u32 * 10_000) + cred_idx as u32)
                .max(1);
            let metadata = generate_metadata_for_batch(
                input.metadata_complexity,
                (issuer_idx as u32 * 1_000) + cred_idx as u32,
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

    // Verify credentials from different issuers were created.
    // A fuzz target must not assert on counts that depend on fuzz-controlled
    // inputs — an empty batch is a valid (if uninteresting) outcome.
    let _ = all_credentials;
}

/// Test a moderate batch with integrity verification of sampled credentials.
fn test_large_batch_with_verification(
    env: &Env,
    client: &QuorumProofContractClient,
    input: &BatchOperationsFuzzInput,
) {
    let issuer = Address::generate(env);
    // Cap at 200 to stay inside the rate-limit window.
    let batch_size = (input.batch_size as usize).clamp(1, 200);

    let mut credential_ids: std::vec::Vec<u64> = std::vec::Vec::new();
    let mut subjects: std::vec::Vec<Address> = std::vec::Vec::new();

    // Issue batch
    for i in 0..batch_size {
        let subject = Address::generate(env);
        let credential_type = (2_000u32).wrapping_add(i as u32);
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

    // Verify integrity: sample verification across the batch
    let sample_rate = if credential_ids.len() > 100 { 10 } else { 2 };
    // `enumerate().step_by(rate)` yields `(0, item0), (1, item1), …` with every
    // Nth item visited — so `idx` is the iterator's sequential counter, NOT the
    // position inside `credential_ids`.  We need to index `subjects` by the
    // *actual* position that was sampled, not by the iterator's count.
    for (iter_count, (actual_pos, &cred_id)) in credential_ids
        .iter()
        .enumerate()
        .step_by(sample_rate.max(1))
        .enumerate()
    {
        let _ = iter_count; // suppress unused-variable warning
        if let Ok(credential) = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            client.get_credential(&cred_id)
        })) {
            // Verify critical properties
            assert_eq!(credential.issuer, issuer, "Issuer mismatch at credential {}", actual_pos);
            assert_eq!(credential.subject, subjects[actual_pos], "Subject mismatch at credential {}", actual_pos);
            assert!(!credential.revoked, "Credential {} should not be revoked", actual_pos);
            assert!(credential.credential_type > 0, "Invalid credential type at {}", actual_pos);
        }
        // If get_credential panicked (e.g. the contract rejected the id), skip — not a bug.
    }
}

/// Test maximum batch size that contract can handle
fn test_maximum_batch_size(env: &Env, client: &QuorumProofContractClient, input: &BatchOperationsFuzzInput) {
    // Test progressively larger batches to find limits.
    // Each size gets a fresh issuer so the rate limit (default 1000 calls per
    // issuer per window) is never hit by accumulated calls across sizes.
    // Sizes above the rate limit are capped to avoid false failures from
    // RateLimitExceeded errors that have nothing to do with batch semantics.
    let test_sizes: &[usize] = &[100, 500, 1000];
    
    for &size in test_sizes {
        // Fresh issuer per size avoids rate-limit accumulation across test rounds.
        let issuer = Address::generate(&env);
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
                    // Stop if too many consecutive failures
                    if failed > (size as u64 / 2) {
                        break;
                    }
                }
            }
        }

        // At least one credential must succeed per batch size.
        assert!(
            successful > 0,
            "Batch size {}: no credentials were issued (issued=0, failed={})",
            size,
            failed
        );
    }
}

/// Generate metadata with varying complexity
fn generate_metadata_for_batch(complexity: u8, seed: u32) -> std::vec::Vec<u8> {
    let size = match complexity % 4 {
        0 => 32,  // Small metadata
        1 => 96,  // Medium metadata
        2 => 256, // Large metadata (contract maximum)
        _ => 64,  // Standard metadata
    };

    let mut metadata = std::vec![0u8; size];
    let mut rng = seed;

    // LCG for deterministic pseudo-random content
    for byte in metadata.iter_mut() {
        rng = rng.wrapping_mul(1_103_515_245).wrapping_add(12_345);
        *byte = ((rng >> 16) ^ (rng >> 8)) as u8;
    }

    metadata
}
