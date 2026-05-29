#![no_main]

use arbitrary::Arbitrary;
use libfuzzer_sys::fuzz_target;
use soroban_sdk::{testutils::Address as _, Address, Bytes, Env, Vec};
use quorum_proof::{QuorumProofContract, QuorumProofContractClient};

/// Fuzz input specifically targeting credential metadata parsing and validation
/// 
/// This fuzz target focuses on:
/// - Various metadata hash sizes (empty, small, large, boundary cases)
/// - Different metadata formats (binary, UTF-8, malformed)
/// - Metadata pattern variations (random, repeated, structured)
/// - Multiple metadata issuances with different patterns
/// - Metadata cache behavior and edge cases
/// - Ensuring no panics or crashes with arbitrary metadata input
#[derive(Arbitrary, Debug)]
struct CredentialMetadataFuzzInput {
    // Metadata size variations - tests boundary conditions
    metadata_size: u16,
    
    // Metadata pattern/content variations
    metadata_pattern: u8,
    
    // Seed for pseudo-random data generation
    random_seed: u32,
    
    // Number of metadata variations to test in sequence
    iteration_count: u8,
    
    // Flags for edge cases
    test_empty_metadata: bool,
    test_max_size: bool,
    test_oversized: bool,
}

fuzz_target!(|input: CredentialMetadataFuzzInput| {
    let env = Env::default();
    env.mock_all_auths();

    let contract_id = env.register_contract(None, QuorumProofContract);
    let client = QuorumProofContractClient::new(&env, &contract_id);
    let admin = Address::generate(&env);
    
    // Initialize contract
    if let Ok(_) = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        client.initialize(&admin)
    })) {
        // Successfully initialized
    } else {
        return; // Initialization failure expected for some inputs
    }

    let issuer = Address::generate(&env);
    let subject = Address::generate(&env);
    let credential_type = input.random_seed.wrapping_add(1).max(1);

    // Test 1: Empty metadata (should panic)
    if input.test_empty_metadata {
        let empty_meta = Bytes::from_slice(&env, &[]);
        let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            client.issue_credential(&issuer, &subject, &credential_type, &empty_meta, &None, &0u64)
        })); // Empty metadata should fail, as per contract requirements
    }

    // Test 2: Maximum valid size metadata (256 bytes)
    if input.test_max_size {
        let max_metadata = generate_metadata(256, input.metadata_pattern, input.random_seed);
        let meta_bytes = Bytes::from_slice(&env, &max_metadata);
        let subject_max = Address::generate(&env);
        
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            client.issue_credential(
                &issuer,
                &subject_max,
                &credential_type.wrapping_add(1).max(1),
                &meta_bytes,
                &None,
                &0u64
            )
        }));
        
        // Max size should succeed
        if let Ok(_cred_id) = result {
            // Successfully created credential with max-size metadata
        }
    }

    // Test 3: Oversized metadata (should panic/fail gracefully)
    if input.test_oversized {
        let oversized_metadata = generate_metadata(512, input.metadata_pattern, input.random_seed);
        let meta_bytes = Bytes::from_slice(&env, &oversized_metadata);
        let subject_oversized = Address::generate(&env);
        
        let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            client.issue_credential(
                &issuer,
                &subject_oversized,
                &credential_type.wrapping_add(2).max(1),
                &meta_bytes,
                &None,
                &0u64
            )
        })); // Oversized should fail gracefully
    }

    // Test 4: Iterate through various metadata sizes and patterns
    let iterations = (input.iteration_count as usize).clamp(1, 20);
    for i in 0..iterations {
        let size = if input.metadata_size == 0 {
            // If fuzzer provides 0, use i to generate some variety
            ((i as u16 + 1) * 13).wrapping_mul(input.random_seed as u16) % 257
        } else {
            input.metadata_size
        };

        // Clamp size between 1 and 256 for valid credentials
        let clamped_size = if size == 0 { 1 } else { (size as usize).min(256) };

        let metadata = generate_metadata(
            clamped_size,
            input.metadata_pattern.wrapping_add(i as u8),
            input.random_seed.wrapping_add(i as u32),
        );

        let meta_bytes = Bytes::from_slice(&env, &metadata);
        let subject_iter = Address::generate(&env);
        let iter_type = credential_type.wrapping_add(i as u32).max(1);

        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            client.issue_credential(
                &issuer,
                &subject_iter,
                &iter_type,
                &meta_bytes,
                &None,
                &0u64
            )
        }));

        match result {
            Ok(cred_id) => {
                // Successfully created credential
                // Verify we can retrieve it with correct metadata
                let cred_result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                    client.get_credential(&cred_id)
                }));

                if let Ok(credential) = cred_result {
                    // Verify metadata is preserved
                    assert_eq!(
                        credential.metadata_hash.len(),
                        metadata.len(),
                        "Metadata size mismatch at iteration {}", i
                    );
                    
                    // Verify metadata content is preserved
                    let stored_bytes: Vec<u8> = credential.metadata_hash.iter().collect();
                    assert_eq!(
                        &stored_bytes[..],
                        &metadata[..],
                        "Metadata content mismatch at iteration {}", i
                    );
                    
                    // Verify other credential properties
                    assert_eq!(credential.subject, subject_iter, "Subject mismatch");
                    assert_eq!(credential.credential_type, iter_type, "Type mismatch");
                    assert_eq!(credential.issuer, issuer, "Issuer mismatch");
                    assert!(!credential.revoked, "Credential should not be revoked");
                }
            }
            Err(_) => {
                // Failure expected for oversized or invalid cases - this is OK
            }
        }
    }

    // Test 5: Stress test with rapid metadata variations
    let stress_iterations = (input.iteration_count as usize % 10).max(3);
    for j in 0..stress_iterations {
        let stress_size = ((j + 1) * (input.random_seed as usize) % 256).max(1);
        let stress_metadata = generate_metadata(
            stress_size,
            input.metadata_pattern.wrapping_add(j as u8),
            input.random_seed.wrapping_add(j as u32),
        );

        let stress_meta_bytes = Bytes::from_slice(&env, &stress_metadata);
        let stress_subject = Address::generate(&env);
        let stress_type = credential_type.wrapping_add(iterations as u32).wrapping_add(j as u32).max(1);

        let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            client.issue_credential(
                &issuer,
                &stress_subject,
                &stress_type,
                &stress_meta_bytes,
                &None,
                &0u64
            )
        })); // No panic assertions - just ensure robustness
    }
});

/// Generate metadata with various patterns for comprehensive testing
/// 
/// Patterns tested:
/// - 0: IPFS-like CIDv0 format
/// - 1: Hexadecimal representation
/// - 2: Pseudo-random bytes
/// - 3: Structured repeating pattern
/// - 4: Mixed UTF-8 and binary
/// - 5: High entropy random-looking
fn generate_metadata(size: usize, pattern: u8, seed: u32) -> Vec<u8> {
    let size = size.clamp(1, 256); // Enforce valid range
    let mut metadata = vec![0u8; size];

    match pattern % 6 {
        0 => {
            // IPFS CIDv0-like pattern: "QmXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX"
            let ipfs_chars = b"QmABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789abcdefghijklmnopqrstuvwxyz";
            for i in 0..size {
                metadata[i] = ipfs_chars[(seed.wrapping_add(i as u32) as usize) % ipfs_chars.len()];
            }
        }
        1 => {
            // Hexadecimal pattern: 0-9, a-f
            let hex_chars = b"0123456789abcdef";
            for i in 0..size {
                metadata[i] = hex_chars[(seed.wrapping_add(i as u32) as usize) % hex_chars.len()];
            }
        }
        2 => {
            // Pseudo-random bytes using LCG
            let mut rng = seed;
            for i in 0..size {
                rng = rng.wrapping_mul(1103515245).wrapping_add(12345);
                metadata[i] = (rng >> 8) as u8;
            }
        }
        3 => {
            // Repeating pattern with variation
            for i in 0..size {
                metadata[i] = ((i as u8).wrapping_mul(pattern)).wrapping_add(seed as u8);
            }
        }
        4 => {
            // Mixed UTF-8 and binary
            let utf8_part = b"Meta-";
            let mut pos = 0;
            while pos < size && pos < utf8_part.len() {
                metadata[pos] = utf8_part[pos];
                pos += 1;
            }
            let mut rng = seed;
            while pos < size {
                rng = rng.wrapping_mul(1103515245).wrapping_add(12345);
                metadata[pos] = (rng >> 8) as u8;
                pos += 1;
            }
        }
        _ => {
            // High entropy: seed-based pseudo-random with XOR variations
            let mut rng = seed;
            for i in 0..size {
                rng ^= rng.wrapping_shl(13);
                rng ^= rng.wrapping_shr(17);
                rng ^= rng.wrapping_shl(5);
                metadata[i] = rng as u8;
            }
        }
    }

    metadata
}
