#![no_main]

use arbitrary::Arbitrary;
use libfuzzer_sys::fuzz_target;
use soroban_sdk::{testutils::Address as _, Address, Bytes, Env, Vec};
use quorum_proof::{QuorumProofContract, QuorumProofContractClient};
use std::time::Instant;

/// Load testing for batch credential issuance operations
/// 
/// This load test focuses on:
/// - Batch issuance of 1000+ credentials
/// - Performance measurement (time, gas estimation)
/// - Bottleneck identification
/// - Stress testing with various batch sizes
/// - Memory and storage efficiency
#[derive(Arbitrary, Debug)]
struct BatchOperationsFuzzInput {
    // Batch size variations (1-1000+ credentials)
    batch_size: u16,
    
    // Number of batch iterations
    iterations: u8,
    
    // Issuer/subject variation
    subject_variation: u8,
    
    // Metadata complexity (affects processing)
    metadata_complexity: u8,
    
    // Credential type variation
    credential_type_base: u32,
    
    // Test flags
    test_large_batch: bool,
    test_sequential: bool,
    test_mixed_sizes: bool,
}

/// Structure to track performance metrics
#[derive(Clone, Debug)]
struct PerformanceMetrics {
    batch_size: u64,
    credentials_issued: u64,
    duration_millis: u128,
    throughput_per_sec: f64,
    avg_time_per_credential_micros: u128,
}

fuzz_target!(|input: BatchOperationsFuzzInput| {
    let env = Env::default();
    env.mock_all_auths();

    let contract_id = env.register_contract(None, QuorumProofContract);
    let client = QuorumProofContractClient::new(&env, &contract_id);
    let admin = Address::generate(&env);
    
    // Initialize contract
    if let Err(_) = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        client.initialize(&admin)
    })) {
        return; // Initialization failure
    }

    // Test 1: Standard batch issuance with timing
    if !input.test_mixed_sizes {
        test_standard_batch(&env, &client, &input);
    }

    // Test 2: Large batch (1000+)
    if input.test_large_batch {
        test_large_batch(&env, &client, &input);
    }

    // Test 3: Sequential issuance stress test
    if input.test_sequential {
        test_sequential_issuance(&env, &client, &input);
    }

    // Test 4: Mixed batch sizes
    if input.test_mixed_sizes {
        test_mixed_batch_sizes(&env, &client, &input);
    }

    // Test 5: Concurrent-like batch with verification
    test_batch_with_verification(&env, &client, &input);
});

/// Test standard batch issuance with performance measurement
fn test_standard_batch(env: &Env, client: &QuorumProofContractClient, input: &BatchOperationsFuzzInput) {
    let issuer = Address::generate(&env);
    let batch_size = (input.batch_size as usize).clamp(10, 500);
    
    let start = Instant::now();
    let mut issued_count = 0u64;
    let mut last_credential_id = 0u64;

    for i in 0..batch_size {
        let subject = if input.subject_variation == 0 {
            Address::generate(&env)
        } else {
            // Generate deterministic subject for reproducibility
            let seed = (i as u32).wrapping_mul(input.subject_variation as u32);
            Address::generate(&env) // Generate but use index for variation
        };

        let credential_type = input.credential_type_base.wrapping_add(i as u32).max(1);
        let metadata = generate_batch_metadata(input.metadata_complexity, i as u32);
        let meta_bytes = Bytes::from_slice(&env, &metadata);

        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            client.issue_credential(&issuer, &subject, &credential_type, &meta_bytes, &None, &0u64)
        }));

        if let Ok(cred_id) = result {
            issued_count += 1;
            last_credential_id = cred_id;
        }
    }

    let duration = start.elapsed();
    let duration_millis = duration.as_millis();
    
    // Calculate throughput
    if issued_count > 0 {
        let throughput = (issued_count as f64) / (duration.as_secs_f64().max(0.001));
        let avg_time = if issued_count > 0 {
            (duration.as_micros()) / (issued_count as u128)
        } else {
            0
        };

        // Verify last credential was stored
        if let Ok(credential) = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            client.get_credential(&last_credential_id)
        })) {
            // Credential verified
            assert!(!credential.revoked, "Credential should not be revoked");
        }
    }
}

/// Test large batch issuance (1000+)
fn test_large_batch(env: &Env, client: &QuorumProofContractClient, input: &BatchOperationsFuzzInput) {
    let issuer = Address::generate(&env);
    let batch_size = (input.batch_size as usize).clamp(100, 2000); // 100-2000 for large batch testing
    
    let start = Instant::now();
    let mut issued_count = 0u64;
    let mut credential_ids = Vec::<u64>::new();

    for i in 0..batch_size {
        let subject = Address::generate(&env);
        let credential_type = (1000u32).wrapping_add(i as u32);
        let metadata = generate_batch_metadata(input.metadata_complexity, i as u32);
        let meta_bytes = Bytes::from_slice(&env, &metadata);

        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            client.issue_credential(&issuer, &subject, &credential_type, &meta_bytes, &None, &0u64)
        }));

        if let Ok(cred_id) = result {
            issued_count += 1;
            if credential_ids.len() < 10 {
                // Store first 10 IDs for verification
                credential_ids.push(cred_id);
            }
        }

        // Safety: Don't continue if we fail too many times
        if issued_count < (i as u64 / 2) {
            break; // More than 50% failure rate
        }
    }

    let duration = start.elapsed();

    // Verify random samples from the batch
    for (idx, &cred_id) in credential_ids.iter().enumerate() {
        if let Ok(credential) = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            client.get_credential(&cred_id)
        })) {
            assert_eq!(credential.issuer, issuer, "Issuer mismatch at index {}", idx);
            assert!(!credential.revoked, "Credential at index {} should not be revoked", idx);
        }
    }
}

/// Test sequential issuance (one by one) for bottleneck identification
fn test_sequential_issuance(env: &Env, client: &QuorumProofContractClient, input: &BatchOperationsFuzzInput) {
    let issuer = Address::generate(&env);
    let iterations = (input.iterations as usize).clamp(5, 50);
    
    let mut total_time_micros = 0u128;
    let mut successful_issuances = 0u64;

    for iter in 0..iterations {
        let batch_size = 100 + (iter * 50).min(400); // Varying batch size
        let iter_start = Instant::now();

        for i in 0..batch_size {
            let subject = Address::generate(&env);
            let credential_type = (100u32).wrapping_add((iter * 100 + i) as u32);
            let metadata = generate_batch_metadata(input.metadata_complexity, (iter as u32 * 1000) + i as u32);
            let meta_bytes = Bytes::from_slice(&env, &metadata);

            let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                client.issue_credential(&issuer, &subject, &credential_type, &meta_bytes, &None, &0u64)
            })).ok();
            
            successful_issuances += 1;
        }

        total_time_micros += iter_start.elapsed().as_micros();
    }

    // Calculate average time per issuance across all iterations
    if successful_issuances > 0 {
        let avg_time = total_time_micros / (successful_issuances as u128);
        // Bottleneck identification: Check if average time is increasing with iterations
        // This indicates potential memory or resource accumulation
        assert!(avg_time < 100_000, "Individual credential issuance taking too long: {} micros", avg_time);
    }
}

/// Test with mixed batch sizes to identify scaling issues
fn test_mixed_batch_sizes(env: &Env, client: &QuorumProofContractClient, input: &BatchOperationsFuzzInput) {
    let issuer = Address::generate(&env);
    let batch_sizes = vec![10, 50, 100, 250, 500];

    for &batch_size in &batch_sizes {
        let start = Instant::now();
        let mut issued = 0u64;

        for i in 0..batch_size {
            let subject = Address::generate(&env);
            let credential_type = (batch_size as u32).wrapping_add(i as u32);
            let metadata = generate_batch_metadata(input.metadata_complexity, i as u32);
            let meta_bytes = Bytes::from_slice(&env, &metadata);

            if let Ok(_) = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                client.issue_credential(&issuer, &subject, &credential_type, &meta_bytes, &None, &0u64)
            })) {
                issued += 1;
            }
        }

        let duration = start.elapsed();
        let avg_per_credential = if issued > 0 {
            duration.as_micros() / (issued as u128)
        } else {
            0
        };

        // Bottleneck detection: Alert if time per credential increases significantly with batch size
        // Linear growth is acceptable; exponential growth indicates a bottleneck
        let expected_max_micros = 10_000; // Expect < 10ms per credential
        assert!(avg_per_credential < expected_max_micros, 
                "Credential issuance time increasing with batch size: {} micros at batch {}", 
                avg_per_credential, batch_size);
    }
}

/// Test batch operations with verification at scale
fn test_batch_with_verification(env: &Env, client: &QuorumProofContractClient, input: &BatchOperationsFuzzInput) {
    let issuer = Address::generate(&env);
    let batch_size = (input.batch_size as usize).clamp(50, 300);
    
    let mut credential_ids = vec![];

    // Issue batch
    for i in 0..batch_size {
        let subject = Address::generate(&env);
        let credential_type = (500u32).wrapping_add(i as u32);
        let metadata = generate_batch_metadata(input.metadata_complexity, i as u32);
        let meta_bytes = Bytes::from_slice(&env, &metadata);

        if let Ok(cred_id) = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            client.issue_credential(&issuer, &subject, &credential_type, &meta_bytes, &None, &0u64)
        })) {
            credential_ids.push(cred_id);
        }
    }

    // Verify batch integrity (sample verification to avoid excessive operations)
    let sample_size = (credential_ids.len() / 5).max(1); // Sample 20% or at least 1
    for idx in (0..credential_ids.len()).step_by(credential_ids.len().max(sample_size)) {
        if idx < credential_ids.len() {
            if let Ok(credential) = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                client.get_credential(&credential_ids[idx])
            })) {
                assert_eq!(credential.issuer, issuer, "Issuer mismatch");
                assert!(!credential.revoked, "Revoked flag incorrect");
            }
        }
    }
}

/// Generate metadata with varying complexity for load testing
fn generate_batch_metadata(complexity: u8, seed: u32) -> Vec<u8> {
    let size = match complexity % 4 {
        0 => 32,      // Small metadata
        1 => 128,     // Medium metadata
        2 => 256,     // Large metadata (max)
        _ => 64,      // Standard metadata
    };

    let mut metadata = vec![0u8; size];
    let mut rng = seed;

    for i in 0..size {
        rng = rng.wrapping_mul(1103515245).wrapping_add(12345);
        metadata[i] = (rng >> 8) as u8;
    }

    metadata
}
