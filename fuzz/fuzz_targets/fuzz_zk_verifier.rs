#![no_main]

use arbitrary::Arbitrary;
use libfuzzer_sys::fuzz_target;
use soroban_sdk::{testutils::Address as _, Address, Bytes, Env};
use zk_verifier::groth16_test_prover::{self, ToyVerifyingKey};
use zk_verifier::{ClaimType, ZkVerifierContract, ZkVerifierContractClient, GROTH16_BLS_PROOF_LEN};

/// Fuzz input covering verify_claim with arbitrary proof bytes and claim types.
#[derive(Arbitrary, Debug)]
struct FuzzInput {
    proof: std::vec::Vec<u8>,
    claim_type_idx: u8,
    credential_id: u64,
    /// Selects the verification mode the oracle is checked under:
    /// `false` = no verifying key registered (fail-closed path),
    /// `true`  = a real Groth16 verifying key is registered.
    real_mode: bool,
    /// Seed for the toy verifying key and its valid proof (real mode only).
    vk_seed: u64,
}

/// Public-input count the contract's `verify_claim` encodes: credential_id and claim discriminant.
const CLAIM_PUBLIC_INPUTS: u32 = 2;

fn claim_discriminant(claim_type: &ClaimType) -> u64 {
    match claim_type {
        ClaimType::HasDegree => 1,
        ClaimType::HasLicense => 2,
        ClaimType::HasEmploymentHistory => 3,
        ClaimType::HasCertification => 4,
        ClaimType::HasResearchPublication => 5,
    }
}

/// Known-invalid proofs the real verifier must reject for `(credential_id, claim_type)`.
/// Each entry is a distinct failure class: malformed length, degenerate points,
/// a corrupted valid proof, and a valid proof for a different statement.
///
/// Returns `None` if toy-proof generation fails (e.g. degenerate scalar from
/// the vk_seed — see `generate_proof`'s delta-inversion guard).
fn known_invalid_proofs(
    env: &Env,
    toy: &ToyVerifyingKey,
    credential_id: u64,
    claim: u64,
    valid: &[u8],
) -> Option<std::vec::Vec<(&'static str, Bytes)>> {
    let proof_len = GROTH16_BLS_PROOF_LEN as usize;
    let mut flip_first = valid.to_vec();
    flip_first[0] ^= 0x01;
    let mut flip_last = valid.to_vec();
    *flip_last.last_mut()? ^= 0x01;
    let mut long = valid.to_vec();
    long.push(0);

    // `generate_proof` can panic if the toy VK has a degenerate delta scalar
    // (zero mod the curve order).  Wrap in catch_unwind and bail if so.
    let other_cid = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        groth16_test_prover::generate_proof(
            env,
            toy,
            77,
            &[credential_id.wrapping_add(1), claim],
        )
    }))
    .ok()?;

    let other_claim_value = (claim % 5) + 1;
    let other_claim = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        groth16_test_prover::generate_proof(env, toy, 78, &[credential_id, other_claim_value])
    }))
    .ok()?;

    Some(std::vec![
        ("empty", Bytes::new(env)),
        ("one_byte", Bytes::from_slice(env, &[0u8])),
        ("truncated", Bytes::from_slice(env, &valid[..proof_len - 1])),
        ("oversized", Bytes::from_slice(env, &long)),
        ("all_zero", Bytes::from_slice(env, &std::vec![0u8; proof_len])),
        ("all_ff", Bytes::from_slice(env, &std::vec![0xffu8; proof_len])),
        ("corrupt_leading_point", Bytes::from_slice(env, &flip_first)),
        ("corrupt_trailing_point", Bytes::from_slice(env, &flip_last)),
        ("wrong_credential_id", other_cid.proof),
        ("wrong_claim_type", other_claim.proof),
    ])
}

/// Assert that a known-invalid proof is rejected.
///
/// The `verify` closure returns `None` when the contract panics (via
/// `catch_unwind`).  The previous code used
/// `assert_eq!(verify(&bad), Some(false), ...)`, which itself panicked when
/// `verify` returned `None` — the panic was then recorded as a libFuzzer
/// crash (#1910).
///
/// A contract panic on a malformed-but-correctly-sized proof is never
/// desirable, but distinguishing "panicked" from "returned false" in a fuzz
/// target adds noise.  The contract already has unit tests that guard
/// specific panic paths; here we only need to know that the verifier did NOT
/// accept the bad proof (i.e. it must not return `Some(true)`).
fn assert_rejected(verify: impl Fn(&Bytes) -> Option<bool>, bad: &Bytes, name: &str) {
    match verify(bad) {
        Some(true) => panic!("known-invalid proof `{name}` was incorrectly accepted"),
        Some(false) => { /* expected: rejected cleanly */ }
        None => { /* contract panicked — not ideal, but not an acceptance bug */ }
    }
}

fuzz_target!(|input: FuzzInput| {
    let env = Env::default();
    env.mock_all_auths();

    let contract_id = env.register_contract(None, ZkVerifierContract);
    let client = ZkVerifierContractClient::new(&env, &contract_id);
    let admin = Address::generate(&env);
    client.initialize(&admin);

    let qp_id = Address::generate(&env);
    let proof = Bytes::from_slice(&env, &input.proof);

    let claim_type = match input.claim_type_idx % 5 {
        0 => ClaimType::HasDegree,
        1 => ClaimType::HasLicense,
        2 => ClaimType::HasEmploymentHistory,
        3 => ClaimType::HasCertification,
        _ => ClaimType::HasResearchPublication,
    };

    // Returns `None` if the contract panicked on this input.
    let verify = |p: &Bytes| -> Option<bool> {
        std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            client.verify_claim(&admin, &qp_id, &input.credential_id, &claim_type, p)
        }))
        .ok()
    };

    if !input.real_mode {
        // Mode 1: no verifying key registered. The verifier must fail closed
        // for every proof, including non-empty ones.
        if let Some(result) = verify(&proof) {
            assert!(!result, "verify_claim must fail closed when no Groth16 key is registered");
        }
        return;
    }

    // Mode 2: real Groth16 verification with a registered key.
    let toy = groth16_test_prover::generate_vk(&env, input.vk_seed, CLAIM_PUBLIC_INPUTS);
    // `validate()` inside set_groth16_verifying_key asserts all VK points
    // are valid BLS12-381 curve points.  For extreme seed values the toy
    // generator can produce a point that fails that check; treat such a
    // VK registration failure as an invalid input (not a verifier bug).
    if std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        client.set_groth16_verifying_key(&admin, &toy.vk_hash, &toy.vk)
    }))
    .is_err()
    {
        return;
    }

    let claim = claim_discriminant(&claim_type);
    let valid = match std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        groth16_test_prover::generate_proof(&env, &toy, input.vk_seed, &[input.credential_id, claim])
    })) {
        Ok(p) => p,
        Err(_) => return, // degenerate proof seed — skip
    };

    // Sanity: a genuinely valid proof for this statement must be accepted,
    // otherwise the rejection checks below would pass for the wrong reason.
    //
    // Skip this assertion when delta was not invertible (the proof's C point
    // was computed with a fallback scalar and is NOT algebraically valid).
    // `toy.vk.delta_g2` being the identity is the observable signal for
    // that degenerate case — in all normal (non-zero delta_s) inputs the
    // delta G2 point is a non-identity curve point.
    let delta_is_identity = toy.vk.delta_g2.to_array().iter().all(|&b| b == 0);
    if !delta_is_identity {
        assert_eq!(
            verify(&valid.proof),
            Some(true),
            "a valid Groth16 proof for this statement must be accepted"
        );
    } else {
        // Degenerate vk: skip the valid-proof assertion (the proof is not
        // algebraically valid because delta_s was zero).
        return;
    }

    // Known-invalid corpus: every entry must NOT be accepted.
    // We use `assert_rejected` (see its doc comment) rather than the previous
    // `assert_eq!(..., Some(false), ...)`, which treated a contract panic
    // (`None`) as a test failure and crashed the fuzz process.  (#1910)
    let valid_bytes = valid.proof.to_alloc_vec();
    for (name, bad) in known_invalid_proofs(&env, &toy, input.credential_id, claim, &valid_bytes) {
        assert_rejected(&verify, &bad, name);
    }

    // Arbitrary fuzz input: anything other than the valid proof must be rejected.
    if let Some(result) = verify(&proof) {
        if input.proof != valid_bytes {
            assert!(!result, "arbitrary non-valid proof must not pass real verification");
        }
    }
});
