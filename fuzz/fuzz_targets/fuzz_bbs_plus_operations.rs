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
/// - `seed`             : deterministic RNG seed so every run is reproducible.
/// - `message_scalars`  : up to 16 raw u64 values encoded as `Fr` field elements.
/// - `revealed_indices` : which message positions to disclose in the presentation.
/// - `nonce`            : arbitrary verifier nonce (may be empty).
/// - `corrupt_bytes`    : fed into `PresentationProof::from_bytes` to test that
///                        malformed wire data is rejected gracefully (never panics).
/// - `corrupt_sig_bytes`: fed into `BbsSignature`-related paths similarly.
#[derive(Arbitrary, Debug)]
struct BbsPlusFuzzInput {
    seed: u64,
    message_scalars: std::vec::Vec<u64>,
    revealed_indices: std::vec::Vec<u8>,
    nonce: std::vec::Vec<u8>,
    corrupt_bytes: std::vec::Vec<u8>,
    corrupt_sig_bytes: std::vec::Vec<u8>,
}

fuzz_target!(|input: BbsPlusFuzzInput| {
    // ── Bound inputs to keep runtime tractable ──────────────────────────────
    // At least 1 message so VerifyingKey::derive doesn't get 0.
    let message_count = (input.message_scalars.len() % 16) + 1;
    let messages: std::vec::Vec<Fr> = input
        .message_scalars
        .iter()
        .take(message_count as usize)
        .map(|&v| Fr::from_u64(v))
        .collect();

    // ── Deterministic RNG ────────────────────────────────────────────────────
    let mut rng = StdRng::seed_from_u64(input.seed);

    // ── 1. Key generation ────────────────────────────────────────────────────
    let sk = SigningKey::generate(&mut rng);
    let pk = sk.public_key();

    // ── 2. VerifyingKey derivation ───────────────────────────────────────────
    let vk = match VerifyingKey::derive(pk, b"fuzz-context-v1", message_count) {
        Ok(vk) => vk,
        Err(_) => return,
    };

    // ── 3. Signing ───────────────────────────────────────────────────────────
    let sig = match BbsSignature::sign(&mut rng, &sk, &vk, &messages) {
        Ok(s) => s,
        Err(_) => return,
    };

    // ── 4. Signature verification — must succeed for a fresh, unmodified sig ─
    // If verify returns Err (unexpected internal error), treat as a fuzzer
    // finding — panic so it lands in the crash corpus.
    match BbsSignature::verify(&vk, &messages, &sig) {
        Ok(true) => {} // expected
        Ok(false) => {
            // A fresh signature that doesn't verify is a genuine bug.
            panic!("A freshly issued signature must verify correctly");
        }
        Err(e) => {
            // An Err from verify on a fresh, well-formed signature is unexpected.
            panic!("BbsSignature::verify returned unexpected Err on fresh sig: {:?}", e);
        }
    }

    // ── 5. Verify rejects if a message is altered ────────────────────────────
    if messages.len() > 1 {
        let mut tampered = messages.clone();
        tampered[messages.len() - 1] = Fr::from_u64(input.seed.wrapping_add(1));
        // Only assert rejection when the tampered value is actually different.
        if tampered[messages.len() - 1] != messages[messages.len() - 1] {
            match BbsSignature::verify(&vk, &tampered, &sig) {
                Ok(false) => {} // expected: tampered messages must not verify
                Ok(true) => {
                    panic!("Tampered messages must not verify against the original signature");
                }
                Err(_) => {
                    // An Err on tampered input is acceptable (graceful rejection).
                }
            }
        }
    }

    // ── 6. Presentation creation (selective disclosure) ──────────────────────
    let all_indices: std::vec::Vec<u32> = (0..message_count as u32).collect();
    let revealed: std::vec::Vec<u32> = input
        .revealed_indices
        .iter()
        .map(|&i| (i as u32) % message_count as u32)
        .collect::<std::collections::BTreeSet<_>>()
        .into_iter()
        .collect();

    let reveal_set: std::vec::Vec<u32> = if revealed.is_empty() {
        all_indices
    } else {
        revealed
    };

    let nonce: &[u8] = if input.nonce.is_empty() {
        b"default-nonce"
    } else {
        &input.nonce
    };
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
        Err(_) => return,
    };

    // ── 7. Presentation verification — must succeed ──────────────────────────
    match BbsPresentation::verify_presentation(&vk, &presentation, nonce) {
        Ok(true) => {} // expected
        Ok(false) => {
            panic!("A freshly created presentation must verify correctly");
        }
        Err(e) => {
            // An Err on a fresh, well-formed presentation is a bug.
            panic!("verify_presentation returned unexpected Err on fresh presentation: {:?}", e);
        }
    }

    // ── 8. Presentation rejects a different nonce ────────────────────────────
    let wrong_nonce = b"wrong-nonce-should-fail";
    if wrong_nonce != nonce {
        match BbsPresentation::verify_presentation(&vk, &presentation, wrong_nonce) {
            Ok(false) => {} // expected
            Ok(true) => {
                panic!("Presentation must not verify against a different nonce");
            }
            Err(_) => {
                // Err is acceptable here — different nonce may cause internal error.
            }
        }
    }

    // ── 9. Wire-format round-trip ────────────────────────────────────────────
    // `PresentationProof::from_bytes` previously had an undercount in its
    // minimum-size guard: it checked `FIXED_LEN + 8` (280 bytes) but the
    // actual fixed section is 304 bytes (3×G1 + 5×Fr, including `challenge`).
    // Bytes in the 280–303 range slipped past the guard, `read_fr` returned
    // `Err`, and the `.expect()` below turned that into a panic.  The
    // constant in `presentation.rs` has been corrected to 48*3 + 32*5 = 304;
    // here we also switch to `match` for the same defensive reason.  (#1908)
    let bytes = presentation.to_bytes();
    let decoded = match PresentationProof::from_bytes(&bytes) {
        Ok(p) => p,
        Err(e) => {
            // from_bytes on bytes produced by to_bytes must never fail.
            panic!("from_bytes must not fail on bytes produced by to_bytes: {:?}", e);
        }
    };
    match BbsPresentation::verify_presentation(&vk, &decoded, nonce) {
        Ok(true) => {} // expected
        Ok(false) => {
            panic!("Round-tripped presentation must verify correctly");
        }
        Err(e) => {
            panic!("verify_presentation returned Err on round-tripped presentation: {:?}", e);
        }
    }

    // ── 10. Malformed bytes: from_bytes must return Err, never panic ─────────
    let _ = PresentationProof::from_bytes(&input.corrupt_bytes);
    let _ = PresentationProof::from_bytes(&[]);

    // ── 11. Malformed signature bytes: must not panic ────────────────────────
    if !input.corrupt_sig_bytes.is_empty() {
        if let Ok(corrupt_proof) = PresentationProof::from_bytes(&input.corrupt_sig_bytes) {
            // Must not panic — result (Ok or Err) is irrelevant.
            let _ = BbsPresentation::verify_presentation(&vk, &corrupt_proof, nonce);
        }
    }
});
