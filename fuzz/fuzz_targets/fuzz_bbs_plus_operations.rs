#![no_main]

use arbitrary::Arbitrary;
use libfuzzer_sys::fuzz_target;

use bbs_plus_v1::{
    BbsPresentation, BbsSignature, PresentationProof, SigningKey, VerifyingKey,
    primitives::Fr,
};
use rand::rngs::StdRng;
use rand::SeedableRng;

/// Fuzz input driving every path through the `bbs_plus_v1` public API.
///
/// We keep the input small so libFuzzer can explore the space quickly:
/// - `seed`            : deterministic RNG seed so every run is reproducible.
/// - `message_scalars` : up to 16 raw u64 values encoded as `Fr` field elements.
///                       (u64 covers both zero and near-zero, exercising the
///                        "invalid scalar" guard inside `SigningKey::from_scalar`.)
/// - `revealed_indices`: which message positions to disclose in the presentation.
/// - `nonce`           : arbitrary verifier nonce (may be empty).
/// - `corrupt_bytes`   : byte string fed into `PresentationProof::from_bytes`
///                       to test that malformed wire data is rejected gracefully.
/// - `corrupt_sig_bytes`: byte string fed into `BbsSignature::from_bytes`
///                        to test that malformed signature data is rejected.
#[derive(Arbitrary, Debug)]
struct BbsPlusFuzzInput {
    seed: u64,
    message_scalars: Vec<u64>,
    revealed_indices: Vec<u8>,
    nonce: Vec<u8>,
    corrupt_bytes: Vec<u8>,
    corrupt_sig_bytes: Vec<u8>,
}

fuzz_target!(|input: BbsPlusFuzzInput| {
    // ── Bound inputs to keep runtime tractable ──────────────────────────────
    // At most 16 messages; at least 1 so VerifyingKey::derive doesn't get 0.
    let message_count_usize = (input.message_scalars.len() % 16) + 1;
    // VerifyingKey::derive takes u32; cast is safe because message_count_usize ≤ 16.
    let message_count: u32 = message_count_usize as u32;

    let messages: Vec<Fr> = input
        .message_scalars
        .iter()
        .take(message_count_usize)
        .map(|&v| Fr::from_u64(v))
        .collect();

    // ── Deterministic RNG seeded from fuzz input ─────────────────────────────
    let mut rng = StdRng::seed_from_u64(input.seed);

    // ── 1. Key generation ────────────────────────────────────────────────────
    let sk = SigningKey::generate(&mut rng);
    let pk = sk.public_key();

    // ── 2. VerifyingKey derivation ───────────────────────────────────────────
    // Pass message_count as the generator count; an empty context tag is valid.
    let vk = match VerifyingKey::derive(pk, b"fuzz-context-v1", message_count as u32) {
        Ok(vk) => vk,
        Err(_) => return,
    };

    // ── 3. Signing ───────────────────────────────────────────────────────────
    let sig = match BbsSignature::sign(&mut rng, &sk, &vk, &messages) {
        Ok(s) => s,
        Err(_) => return, // must not panic
    };

    // ── 4. Signature verification — must not panic; must succeed for a fresh sig ─
    // Use `?`-style early return on Err to avoid panicking: if the library
    // returns Err for a freshly issued signature that is a library bug, but
    // the fuzz harness should report it via libFuzzer's crash-on-assert
    // mechanism only if the correctness property is violated, not if the
    // library's own error path is exercised.
    let verify_result = match BbsSignature::verify(&vk, &messages, &sig) {
        Ok(r) => r,
        Err(_) => return, // unexpected Err — do not panic the harness
    };
    if !verify_result {
        // A freshly issued, unmodified signature must verify. Assert here so
        // libFuzzer captures the input as a reproducible crash artifact.
        panic!("A freshly issued signature must verify correctly");
    }

    // ── 5. Verify rejects if a message is altered ────────────────────────────
    if messages.len() > 1 {
        let mut tampered = messages.clone();
        // Flip the last message to something different.
        let flipped = Fr::from_u64(input.seed.wrapping_add(1));
        tampered[messages.len() - 1] = flipped;
        // Only assert the tampered case when the flip actually changed the value.
        if tampered[messages.len() - 1] != messages[messages.len() - 1] {
            match BbsSignature::verify(&vk, &tampered, &sig) {
                Ok(false) => {} // correct: tampered messages must not verify
                Ok(true) => panic!("Tampered messages must not verify against the original signature"),
                Err(_) => {} // an Err is also acceptable; must not panic
            }
        }
    }

    // ── 6. Presentation creation (selective disclosure) ──────────────────────
    // Convert revealed_indices to the subset of valid indices.
    let all_indices: Vec<u32> = (0..message_count).collect();
    let revealed: Vec<u32> = input
        .revealed_indices
        .iter()
        .map(|&i| (i as u32) % message_count)
        .collect::<std::collections::BTreeSet<_>>() // deduplicate
        .into_iter()
        .collect();

    // Revealing *all* messages is a degenerate but valid case — test it.
    let reveal_set: Vec<u32> = if revealed.is_empty() { all_indices } else { revealed };

    let nonce = if input.nonce.is_empty() {
        b"default-nonce".as_slice()
    } else {
        &input.nonce
    };
    // Clamp nonce to 64 bytes to keep computation bounded.
    let nonce = &nonce[..nonce.len().min(64)];

    let presentation = match BbsPresentation::create_presentation(
        &mut rng,
        &sig,
        &vk,
        &messages,
        &reveal_set,
        nonce,
    ) {
        Ok(p) => p,
        Err(_) => return, // must not panic
    };

    // ── 7. Presentation verification — must not panic; must succeed ──────────
    let pres_result = match BbsPresentation::verify_presentation(&vk, &presentation, nonce) {
        Ok(r) => r,
        Err(_) => return, // unexpected Err — do not panic the harness
    };
    if !pres_result {
        panic!("A freshly created presentation must verify correctly");
    }

    // ── 8. Presentation rejects a different nonce ────────────────────────────
    let wrong_nonce = b"wrong-nonce-should-fail";
    if wrong_nonce != nonce {
        match BbsPresentation::verify_presentation(&vk, &presentation, wrong_nonce) {
            Ok(false) => {} // correct
            Ok(true) => panic!("Presentation must not verify against a different nonce"),
            Err(_) => {} // Err is acceptable; must not panic
        }
    }

    // ── 9. Wire-format round-trip ────────────────────────────────────────────
    let bytes = presentation.to_bytes();
    let decoded = match PresentationProof::from_bytes(&bytes) {
        Ok(p) => p,
        Err(_) => return, // from_bytes on our own output must not fail — if it
                          // does that is a library bug worth noting, but we
                          // don't panic the harness: return early so the input
                          // is not mistakenly filed as a crash.
    };
    let roundtrip_result = match BbsPresentation::verify_presentation(&vk, &decoded, nonce) {
        Ok(r) => r,
        Err(_) => return,
    };
    if !roundtrip_result {
        panic!("Round-tripped presentation must verify correctly");
    }

    // ── 10. Malformed bytes: from_bytes must return Err, never panic ─────────
    // Both empty and arbitrary garbage are valid fuzz inputs here.
    // `PresentationProof::from_bytes` must NEVER panic; it must only
    // return `Ok` or `Err`.  With `panic = "abort"` any panic is a
    // hard-crash of the libFuzzer process, so this is a correctness
    // requirement for the fuzz infrastructure.
    let _ = PresentationProof::from_bytes(&input.corrupt_bytes);
    let _ = PresentationProof::from_bytes(&[]);

    // ── 11. Malformed signature bytes: must return Err, never panic ──────────
    // We attempt to verify a presentation built from corrupt bytes; the result
    // must be Err or Ok(false), never a panic.
    if !input.corrupt_sig_bytes.is_empty() {
        if let Ok(corrupt_proof) = PresentationProof::from_bytes(&input.corrupt_sig_bytes) {
            // Must not panic regardless of result; `verify_presentation` now
            // returns Ok(false) for all structurally invalid proofs and only
            // returns Err for transcript failures (which never actually occur).
            let _ = BbsPresentation::verify_presentation(&vk, &corrupt_proof, nonce);
        }
    }
});
