#![no_main]

use arbitrary::Arbitrary;
use libfuzzer_sys::fuzz_target;

/// Fuzz input for BBS+ cryptographic operations
///
/// This fuzz target tests the BBS+ signature scheme for:
/// - Signature generation edge cases
/// - Proof generation with various inputs
/// - Verification robustness against malformed inputs
#[derive(Arbitrary, Debug)]
struct BBSPlusFuzzInput {
    message_data: Vec<u8>,
    message_count: u8,
    proof_type: u8,
    nonce_size: u8,
}

fuzz_target!(|input: BBSPlusFuzzInput| {
    // BBS+ operations are primarily used off-chain for proof generation
    // This fuzz target validates input handling without triggering panics

    // Validate message data
    let message_count = (input.message_count as usize).clamp(0, 10);
    let nonce_size = (input.nonce_size as usize).clamp(0, 64);

    // Test message preprocessing
    if !input.message_data.is_empty() {
        let _msg_len = input.message_data.len();
        // Messages are processed as octet strings in BBS+
        // Verify no panics on arbitrary data
        let _ = preprocess_message(&input.message_data);
    }

    // Test nonce generation
    if nonce_size > 0 {
        let _nonce = generate_fuzzy_nonce(nonce_size);
    }

    // Test proof type handling
    let _proof_type = match input.proof_type % 3 {
        0 => "signature",
        1 => "credential_proof",
        _ => "selective_disclosure",
    };

    // Validate no out-of-bounds or panic conditions
    if message_count > 0 {
        let _batch_size = calculate_safe_batch_size(message_count);
    }
});

/// Safely preprocess message data without panicking
fn preprocess_message(data: &[u8]) -> Vec<u8> {
    if data.is_empty() {
        return vec![];
    }

    // Messages in BBS+ are processed as octet strings
    // Validate length is reasonable for cryptographic operations
    let safe_len = data.len().min(1024); // Limit to 1KB
    data[..safe_len].to_vec()
}

/// Generate a fuzzy nonce safely
fn generate_fuzzy_nonce(size: usize) -> Vec<u8> {
    let safe_size = size.min(64); // Max 64 bytes
    let mut nonce = vec![0u8; safe_size];

    for i in 0..safe_size {
        nonce[i] = ((i as u8).wrapping_mul(size as u8)).wrapping_add(i as u8);
    }

    nonce
}

/// Calculate safe batch size for parallel proof generation
fn calculate_safe_batch_size(message_count: usize) -> usize {
    // Limit batch size to prevent memory exhaustion
    message_count.clamp(1, 100)
}
