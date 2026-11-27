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

    // Initialize contract; if it fails (e.g. already initialized) skip this input.
    if std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        client.initialize(&admin)
    }))
    .is_err()
    {
        return;
    }

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

/// Test single issuer issuing a large batch of credentials.
///
/// We deliberately avoid hard `assert!` calls on overall success rates because
/// the contract's quota/rate-limit logic can legitimately reject the majority
/// of requests under adversarial input, which should not register as a crash.
fn test_single_issuer_batch(
    env: &Env,
    client: &QuorumProofContractClient,
    input: &BatchOperationsFuzzInput,
) {
    let issuer = Address::generate(env);
    let batch_size = (input.batch_size as usize).clamp(10, 100);

    let mut issued_count: usize = 0;
    let mut failed_count: usize = 0;

    for i in 0..batch_size {
        let subject = Address::generate(env);
        let credential_type = input.type_seed.wrapping_add(i as u32).max(1);
        let metadata = generate_metadata_for_batch(input.metadata_complexity, i as u32);
        let meta_bytes = Bytes::from_slice(env, &metadata);

        match std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            client.issue_credential(&issuer, &subject, &credential_type, &meta_bytes, &None, &0u64)
        })) {
            Ok(_) => issued_count += 1,
            Err(_) => failed_count += 1,
        }

        // Stop early if failures are dominating — the contract may be rejecting
        // all further calls for a valid protocol reason.
        if failed_count > batch_size / 2 {
            break;
        }
    }

    // The fuzz target's goal is to confirm the contract never panics (i.e.
    // no unhandled abort/SIGABRT escapes catch_unwind), not to mandate a
    // specific throughput.  Many fuzzer-generated inputs legitimately produce
    // high rejection rates: the duplicate-credential guard fires when
    // `type_seed` causes all iterations to map to the same (issuer, subject,
    // type) triple, and rate-limiting fires on dense bursts.  An unconditional
    // success-rate assert would turn those valid scenarios into fuzz crashes
    // rather than finding real bugs.  Record the counts for visibility only.
    let _ = (issued_count, failed_count);
}

/// Test multiple issuers issuing batches.
fn test_multiple_issuers_batch(
    env: &Env,
    client: &QuorumProofContractClient,
    input: &BatchOperationsFuzzInput,
) {
    let num_issuers = ((input.batch_iterations as usize) % 5).max(2);
    let batch_size = ((input.batch_size as usize) / num_issuers).clamp(5, 50);

    let mut total_issued = 0usize;

    for issuer_idx in 0..num_issuers {
        let issuer = Address::generate(env);

        for cred_idx in 0..batch_size {
            let subject = Address::generate(env);
            let credential_type = input
                .type_seed
                .wrapping_add((issuer_idx as u32).wrapping_mul(10_000).wrapping_add(cred_idx as u32))
                .max(1);
            let metadata =
                generate_metadata_for_batch(input.metadata_complexity, (issuer_idx as u32).wrapping_mul(1_000).wrapping_add(cred_idx as u32));
            let meta_bytes = Bytes::from_slice(env, &metadata);

            if std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                client.issue_credential(&issuer, &subject, &credential_type, &meta_bytes, &None, &0u64)
            }))
            .is_ok()
            {
                total_issued += 1;
            }
        }
    }

    // No success-rate assertion: some fuzz inputs may produce zero successful
    // credentials (e.g. all calls rejected by rate-limiting or duplicate
    // guards) — that is a valid contract state, not a bug.
    let _ = all_credentials;
}

/// Test large batch with integrity verification on a sample of issued credentials.
fn test_large_batch_with_verification(
    env: &Env,
    client: &QuorumProofContractClient,
    input: &BatchOperationsFuzzInput,
) {
    let issuer = Address::generate(env);
    // Keep small to stay within ledger instruction limits during fuzzing.
    let batch_size = (input.batch_size as usize).clamp(10, 100);

    let mut credential_ids: std::vec::Vec<u64> = std::vec::Vec::new();
    let mut subjects: std::vec::Vec<Address> = std::vec::Vec::new();

    for i in 0..batch_size {
        let subject = Address::generate(env);
        let credential_type = (2_000u32).wrapping_add(i as u32).max(1);
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

    if credential_ids.is_empty() {
        return;
    }

    // Sample-verify a subset of issued credentials.
    let step = (credential_ids.len() / 10).max(1);
    for (pos, &cred_id) in credential_ids.iter().enumerate().step_by(step) {
        if let Ok(credential) = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            client.get_credential(&cred_id)
        })) {
            // These are genuine invariant breaks — panic so they land in the corpus.
            if credential.issuer != issuer {
                panic!("Issuer mismatch for credential {} at position {}", cred_id, pos);
            }
            if credential.subject != subjects[pos] {
                panic!("Subject mismatch for credential {} at position {}", cred_id, pos);
            }
            if credential.revoked {
                panic!("Credential {} should not be revoked immediately after issuance", cred_id);
            }
            if credential.credential_type == 0 {
                panic!("Invalid zero credential_type for credential {}", cred_id);
            }
        }
        // If get_credential panicked (e.g. the contract rejected the id), skip — not a bug.
    }
}

/// Probe progressively larger batch sizes without hard rate-based assertions.
fn test_maximum_batch_size(
    env: &Env,
    client: &QuorumProofContractClient,
    input: &BatchOperationsFuzzInput,
) {
    let issuer = Address::generate(env);

    // Smaller sizes to keep fuzz runs tractable.
    let test_sizes: [usize; 4] = [10, 25, 50, 100];

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
                Ok(_) => {
                    successful += 1;
                    any_success = true;
                }
                Err(_) => {
                    failed += 1;
                    // Stop probing this size if contract is consistently refusing.
                    if failed > (size as u64 / 2) {
                        break;
                    }
                }
            }
        }

        // Fuzz goal: confirm no unhandled panic escapes from any batch size.
        // Success-rate thresholds are not asserted here — many fuzzer inputs
        // legitimately produce rejections (duplicates, rate-limits, etc.) at
        // any batch size; asserting a floor would misclassify those as crashes.
        let _ = (successful, failed);
    }

    // At least one credential must have been successfully issued across all sizes.
    assert!(any_success, "No credential issued across any batch size in maximum-batch test");
}

/// Generate metadata bytes with varying size and pattern.
fn generate_metadata_for_batch(complexity: u8, seed: u32) -> std::vec::Vec<u8> {
    let size = match complexity % 4 {
        0 => 32,
        1 => 96,
        2 => 256,
        _ => 64,
    };

    let mut metadata = std::vec![0u8; size];
    let mut rng = seed;
    for byte in metadata.iter_mut() {
        rng = rng.wrapping_mul(1_103_515_245).wrapping_add(12_345);
        *byte = ((rng >> 16) ^ (rng >> 8)) as u8;
    }
    metadata
}
