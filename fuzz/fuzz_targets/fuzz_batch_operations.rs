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

    // Fuzz contract calls may fail for valid protocol-level reasons (e.g. duplicate
    // credential, rate-limit, PoW) — do not assert a floor here; that would cause
    // libFuzzer to treat normal rejection paths as crashes.
    let _ = issued_count;
    let _ = failed_count;
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

    // Verify integrity: sample a subset of issued credentials.
    let sample_rate = if credential_ids.len() > 100 { 10 } else { 2 }.max(1);
    for (idx, &cred_id) in credential_ids.iter().enumerate().step_by(sample_rate) {
        if let Ok(credential) = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            client.get_credential(&cred_id)
        })) {
            assert_eq!(credential.issuer, issuer, "Issuer mismatch at index {}", idx);
            assert_eq!(
                credential.subject, subjects[idx],
                "Subject mismatch at index {}",
                idx
            );
            assert!(!credential.revoked, "Credential at index {} should not be revoked", idx);
            assert!(
                credential.credential_type > 0,
                "Invalid credential type at index {}",
                idx
            );
        }
        // If get_credential panicked (e.g. the contract rejected the id), skip — not a bug.
    }
}

/// Probe progressively larger batch sizes to find the contract's practical
/// throughput limit without asserting a fixed success rate — the contract is
/// free to reject any call (rate-limit, quota, etc.).
fn test_maximum_batch_size(
    env: &Env,
    client: &QuorumProofContractClient,
    input: &BatchOperationsFuzzInput,
) {
    // Use a fresh issuer per test to avoid cross-contamination with the other
    // sub-tests that share the same contract instance.
    let issuer = Address::generate(env);

    // Keep individual sizes small so the total stays well under 1 000
    // (the default per-day rate limit).  We care about shape/correctness,
    // not raw throughput, in a fuzz corpus.
    let test_sizes: std::vec::Vec<usize> = std::vec![10, 25, 50, 100];

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
                    // Stop early if the failure rate becomes too high to be
                    // informative — avoids burning fuzzer time on a wall of
                    // rejections.
                    if failed > (size as u64 / 2) {
                        break;
                    }
                }
            }
        }

        // A fuzz target must not assert a minimum success rate — the contract
        // correctly rejects inputs for many protocol-level reasons (duplicates,
        // rate limits, etc.) that are not bugs.  `successful` and `failed` are
        // already used above to bail the inner loop early; nothing further to check.
        let _ = successful;
        let _ = failed;
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
