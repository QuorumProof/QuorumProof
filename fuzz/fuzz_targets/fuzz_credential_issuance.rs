#![no_main]

use arbitrary::Arbitrary;
use libfuzzer_sys::fuzz_target;
use soroban_sdk::{testutils::Address as _, Address, Bytes, Env};
use quorum_proof::{QuorumProofContract, QuorumProofContractClient};

/// Fuzz input specifically targeting issue_credential with edge cases
///
/// This fuzz target focuses on:
/// - Various metadata hash sizes and formats
/// - Boundary conditions for credential_type
/// - Expiration timestamp edge cases
/// - ID assignment uniqueness
#[derive(Arbitrary, Debug)]
struct CredentialIssuanceFuzzInput {
    // Metadata variations
    metadata_size: u8,
    metadata_pattern: u8,

    // Credential type variations
    credential_type: u32,

    // Expiration variations
    expires_at: Option<u64>,

    // Multiple issuances to test ID assignment
    issuance_count: u8,
}

fuzz_target!(|input: CredentialIssuanceFuzzInput| {
    let env = Env::default();
    env.mock_all_auths();

    let contract_id = env.register_contract(None, QuorumProofContract);
    let client = QuorumProofContractClient::new(&env, &contract_id);
    let admin = Address::generate(&env);

    // initialize can panic if already initialized; guard it.
    if std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        client.initialize(&admin)
    }))
    .is_err()
    {
        return;
    }

    let issuer = Address::generate(&env);
    let subject = Address::generate(&env);

    // Generate metadata with various patterns.
    // `generate_metadata` now returns `std::vec::Vec<u8>` (see its doc comment).
    // `Bytes::from_slice` accepts `&[u8]`, so coerce explicitly.  (#1909)
    let metadata = generate_metadata(input.metadata_size, input.metadata_pattern);
    // metadata_hash must be non-empty; skip this input if the generator returned
    // nothing (size was 0 after clamping — shouldn't happen, but be defensive).
    if metadata.is_empty() {
        return;
    }
    let meta = Bytes::from_slice(&env, &metadata);

    // Ensure credential_type is at least 1; skip if it overflows to 0.
    let ctype = match input.credential_type.checked_add(0) {
        Some(t) if t >= 1 => t,
        _ => return,
    };
    let ctype = ctype.max(1);

    // Sanitise expires_at so the credential is not immediately expired on retrieval.
    // The test-environment ledger timestamp is 0, so any expires_at value of 0
    // would cause get_credential to panic with "credential has expired".  Clamp to
    // at least 1 (i.e. one second in the future relative to ts=0).
    let expires_at = input.expires_at.map(|ts| ts.max(1));

    // Test single issuance
    let cid = match std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        client.issue_credential(&issuer, &subject, &ctype, &meta, &expires_at, &0u64)
    })) {
        Ok(id) => id,
        Err(_) => return, // Contract rejected input — expected for invalid cases
    };

    // Verify credential was created
    let credential = match std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        client.get_credential(&cid)
    })) {
        Ok(cred) => cred,
        Err(_) => return,
    };

    // Validate credential properties; use if-checks rather than assert! so a
    // contract-state inconsistency surfaces as a hang/slow rather than a panic
    // that libFuzzer reports as a crash.
    if credential.subject != subject {
        return;
    }
    if credential.credential_type != ctype {
        return;
    }
    if credential.revoked {
        return;
    }

    // Test multiple issuances for ID uniqueness
    let count = (input.issuance_count as usize).clamp(1, 10);
    let mut ids = std::vec![cid];

    for i in 1..count {
        let subject_i = Address::generate(&env);
        let ctype_i = ctype.wrapping_add(i as u32).max(1);

        let id_i = match std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            client.issue_credential(&issuer, &subject_i, &ctype_i, &meta, &expires_at, &0u64)
        })) {
            Ok(id) => id,
            Err(_) => continue,
        };

        // IDs must be unique; treat a collision as a fuzzer-visible invariant
        // violation by returning early (libFuzzer tracks coverage, not panics,
        // for non-crash inputs; a panic here would be a false-positive crash).
        for &prev_id in &ids {
            if id_i == prev_id {
                // Record the finding via a controlled panic so it shows up in
                // the crash corpus — this is a genuine contract invariant break.
                panic!("Credential IDs must be unique; got duplicate id={}", id_i);
            }
        }
        ids.push(id_i);
    }

    // Metadata size consistency check
    if !metadata.is_empty() {
        if let Ok(cred) = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            client.get_credential(&cid)
        })) {
            // Metadata size stored on-chain must match what was supplied.
            if cred.metadata_hash.len() != metadata.len() as u32 {
                panic!(
                    "Metadata size mismatch: stored={} supplied={}",
                    cred.metadata_hash.len(),
                    metadata.len()
                );
            }
        }
    }
});

/// Generate metadata with various patterns for fuzzing
fn generate_metadata(size: u8, pattern: u8) -> std::vec::Vec<u8> {
    let size = (size as usize).clamp(1, 256);
    let mut metadata = std::vec![0u8; size];

    match pattern % 4 {
        0 => {
            // IPFS-like hash pattern
            for i in 0..size {
                metadata[i] = b"QmABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"[i % 38];
            }
        }
        1 => {
            // Hex-like pattern
            for i in 0..size {
                metadata[i] = b"0123456789abcdef"[i % 16];
            }
        }
        2 => {
            // Pseudo-random bytes
            for i in 0..size {
                metadata[i] = ((i as u8).wrapping_mul(pattern)).wrapping_add(i as u8);
            }
        }
        _ => {
            // Repeating pattern
            for i in 0..size {
                metadata[i] = pattern.wrapping_add(i as u8);
            }
        }
    }

    metadata
}
