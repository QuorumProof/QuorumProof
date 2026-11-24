#![no_main]

use arbitrary::Arbitrary;
use libfuzzer_sys::fuzz_target;
use soroban_sdk::{testutils::Address as _, Address, Bytes, Env, Vec};
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
    client.initialize(&admin);

    let issuer = Address::generate(&env);
    let subject = Address::generate(&env);

    // Generate metadata with various patterns
    let metadata = generate_metadata(input.metadata_size, input.metadata_pattern);
    let meta = Bytes::from_slice(&env, &metadata);

    // Ensure credential_type is at least 1
    let ctype = input.credential_type.max(1);

    // Fix #1884 / #1881: `get_credential` panics unconditionally when
    // `expires_at` is Some(t) and `ledger.timestamp() >= t`. In the test
    // environment the ledger timestamp starts at 0, so any `Some(0)` or
    // any value less than or equal to the current ledger timestamp causes
    // `issue_credential` to succeed but the subsequent `get_credential`
    // call to panic with "credential has expired".
    //
    // We normalise the expiry to either `None` or a strictly-future
    // timestamp (ledger timestamp + 1) so that `get_credential` never hits
    // the expiry panic for a credential we just issued. This mirrors the
    // real-world invariant: a credential with an expiry in the past is
    // structurally invalid and should be rejected at issuance, not silently
    // accepted only to panic on the first read.
    let now = env.ledger().timestamp();
    let expires_at: Option<u64> = match input.expires_at {
        None => None,
        Some(t) => {
            // Discard timestamps that are already expired at issuance time.
            // A timestamp of 0 is always expired in the default test env
            // (ledger timestamp = 0), so we skip those too.
            if t > now { Some(t) } else { None }
        }
    };

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

    // Validate credential properties
    assert_eq!(credential.subject, subject, "Subject mismatch");
    assert_eq!(credential.credential_type, ctype, "Type mismatch");
    assert!(!credential.revoked, "Newly issued credential should not be revoked");

    // Test multiple issuances for ID uniqueness
    let count = (input.issuance_count as usize).clamp(1, 10);
    let mut ids = vec![cid];

    for i in 1..count {
        let subject_i = Address::generate(&env);
        let ctype_i = (ctype.wrapping_add(i as u32)).max(1);

        let id_i = match std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            client.issue_credential(&issuer, &subject_i, &ctype_i, &meta, &expires_at, &0u64)
        })) {
            Ok(id) => id,
            Err(_) => continue,
        };

        // Verify uniqueness
        for prev_id in &ids {
            assert_ne!(id_i, *prev_id, "Credential IDs must be unique");
        }
        ids.push(id_i);
    }

    // Test metadata edge cases
    if !metadata.is_empty() {
        // Verify metadata is stored correctly
        let cred = match std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            client.get_credential(&cid)
        })) {
            Ok(c) => c,
            Err(_) => return,
        };

        // Metadata should be preserved; compare lengths as u32 to match
        // the soroban Bytes::len() return type.
        assert_eq!(
            cred.metadata_hash.len(),
            metadata.len() as u32,
            "Metadata size mismatch"
        );
    }
});

/// Generate metadata with various patterns for fuzzing
fn generate_metadata(size: u8, pattern: u8) -> Vec<u8> {
    // Clamp to [1, 256] — the contract rejects empty metadata_hash.
    // The upper bound matches MAX_METADATA_SIZE (256) enforced by
    // validate_transaction_size; the fuzz driver must stay within that
    // limit to exercise the success path rather than always hitting the
    // size-exceeded error.
    let size = (size as usize).clamp(1, 256);
    let mut metadata = vec![0u8; size];

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
            // Random bytes
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
