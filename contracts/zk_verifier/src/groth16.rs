//! Genuine BLS12-381 pairing-based Groth16 proof verification.
//!
//! Implements the standard Groth16 verification equation
//! [Groth 2016](https://eprint.iacr.org/2016/260):
//!
//! ```text
//! e(A, B) = e(alpha, beta) · e(vk_x, gamma) · e(C, delta)
//! ```
//!
//! where `vk_x = IC[0] + sum_i public_input_i * IC[i+1]` is the public-input
//! linear combination and `A`, `B`, `C` are the proof's three group elements.
//!
//! Instantiated over BLS12-381 (compressed points) rather than the textbook
//! BN254 curve, for the same reason the sibling [`crate::plonk`] module made
//! this switch: `bls12_381` is the only pairing-capable dependency available
//! in this workspace (there is no vetted BN254 crate here, and Soroban
//! exposes no BN254 host functions), so the pairing check runs in-contract
//! via this crate's pure Rust field/curve arithmetic. Unaudited upstream —
//! see `docs/plonk-verification.md` for the analogous BLS12-381 usage notes.
//!
//! This module is pure (no `Env`, no storage access) so it can be unit
//! tested directly and reused independently of the Soroban host.
//!
//! Deliberately no `alloc`, matching [`crate::plonk`]: the batched
//! multi-pairing helpers (`multi_miller_loop`, `G2Prepared`) require the
//! `bls12_381/alloc` feature, which needs a registered global allocator that
//! this `#![no_std]` contract does not set up. Every check here instead uses
//! independent calls to the single-pair `pairing()` function.

use bls12_381::{pairing, G1Affine, G1Projective, G2Affine, Gt, Scalar};
use sha2::{Digest, Sha256};

/// Compressed G1 point size (BLS12-381).
pub const G1_LEN: usize = 48;
/// Compressed G2 point size (BLS12-381).
pub const G2_LEN: usize = 96;
/// Scalar (Fr) element size.
pub const SCALAR_LEN: usize = 32;
/// Groth16 proof: `A` (G1) ‖ `B` (G2) ‖ `C` (G1), all compressed.
pub const PROOF_LEN: u32 = (2 * G1_LEN + G2_LEN) as u32;

/// Maximum number of public-input field elements (bounds the fixed stack
/// buffer used when copying `public_inputs`/`ic` out of host `Bytes`/`Vec`
/// objects in `lib.rs`). Real circuits rarely expose more than a handful of
/// public wires.
pub const MAX_PUBLIC_INPUTS: usize = 32;

/// Circuit-specific Groth16 verifying key (the four fixed elements; the
/// `IC` array — one G1 point per public input plus a constant term — is
/// variable-length and passed separately to [`verify`]).
#[derive(Clone)]
pub struct VerifyingKey {
    pub alpha_g1: [u8; G1_LEN],
    pub beta_g2: [u8; G2_LEN],
    pub gamma_g2: [u8; G2_LEN],
    pub delta_g2: [u8; G2_LEN],
}

impl VerifyingKey {
    /// Canonical byte encoding of the four fixed VK elements:
    /// `alpha_g1 || beta_g2 || gamma_g2 || delta_g2`. Callers that need a
    /// `vk_hash` must also bind the (variable-length) `IC` array — see
    /// `ZkVerifierContract::groth16_vk_hash`.
    pub fn canonical_bytes(&self) -> [u8; G1_LEN + 3 * G2_LEN] {
        let mut out = [0u8; G1_LEN + 3 * G2_LEN];
        out[0..G1_LEN].copy_from_slice(&self.alpha_g1);
        let mut off = G1_LEN;
        for p in [&self.beta_g2, &self.gamma_g2, &self.delta_g2] {
            out[off..off + G2_LEN].copy_from_slice(p);
            off += G2_LEN;
        }
        out
    }
}

fn g1_point(bytes: &[u8]) -> Option<G1Affine> {
    let arr: &[u8; G1_LEN] = bytes.try_into().ok()?;
    Option::<G1Affine>::from(G1Affine::from_compressed(arr))
}

fn g2_point(bytes: &[u8; G2_LEN]) -> Option<G2Affine> {
    Option::<G2Affine>::from(G2Affine::from_compressed(bytes))
}

fn scalar_from(bytes: &[u8]) -> Option<Scalar> {
    let arr: &[u8; SCALAR_LEN] = bytes.try_into().ok()?;
    Option::<Scalar>::from(Scalar::from_bytes(arr))
}

/// Validates a compressed G1 point (used by admin-facing key registration).
pub fn is_valid_g1(bytes: &[u8; G1_LEN]) -> bool {
    g1_point(bytes).is_some()
}

/// Validates a compressed G2 point (used by admin-facing key registration).
pub fn is_valid_g2(bytes: &[u8; G2_LEN]) -> bool {
    g2_point(bytes).is_some()
}

/// Computes `vk_x = IC[0] + sum_i public_input_i * IC[i+1]`.
///
/// `ic` must have exactly `public_inputs.len()/32 + 1` entries (the constant
/// term plus one per public input). Returns `None` on any malformed point,
/// scalar, or length mismatch.
fn compute_vk_x(ic: &[[u8; G1_LEN]], public_inputs: &[u8]) -> Option<G1Affine> {
    if ic.is_empty() {
        return None;
    }
    let l = public_inputs.len() / SCALAR_LEN;
    if l + 1 != ic.len() {
        return None;
    }

    let mut acc = G1Projective::from(g1_point(&ic[0])?);
    for i in 0..l {
        let s = scalar_from(&public_inputs[i * SCALAR_LEN..(i + 1) * SCALAR_LEN])?;
        let p = g1_point(&ic[i + 1])?;
        acc += p * s;
    }
    Some(G1Affine::from(acc))
}

/// Verifies a single Groth16 proof against a circuit-specific verifying key.
///
/// `public_inputs` is a flat, 32-byte-aligned byte string of little-endian
/// Fr scalars, one per public-input wire (may be empty for a circuit with no
/// public inputs, in which case `ic` must have exactly one entry — the
/// constant term).
///
/// `proof` must be exactly [`PROOF_LEN`] bytes: compressed `A` (G1) ‖ `B`
/// (G2) ‖ `C` (G1).
///
/// Returns `false` (never panics) for any structurally, algebraically, or
/// cryptographically invalid input.
pub fn verify(vk: &VerifyingKey, ic: &[[u8; G1_LEN]], public_inputs: &[u8], proof: &[u8]) -> bool {
    if proof.len() != PROOF_LEN as usize {
        return false;
    }
    if public_inputs.len() % SCALAR_LEN != 0 {
        return false;
    }

    let a = match g1_point(&proof[0..G1_LEN]) {
        Some(p) => p,
        None => return false,
    };
    let b_bytes: &[u8; G2_LEN] = match proof[G1_LEN..G1_LEN + G2_LEN].try_into() {
        Ok(a) => a,
        Err(_) => return false,
    };
    let b = match g2_point(b_bytes) {
        Some(p) => p,
        None => return false,
    };
    let c = match g1_point(&proof[G1_LEN + G2_LEN..PROOF_LEN as usize]) {
        Some(p) => p,
        None => return false,
    };

    let alpha = match g1_point(&vk.alpha_g1) {
        Some(p) => p,
        None => return false,
    };
    let beta = match g2_point(&vk.beta_g2) {
        Some(p) => p,
        None => return false,
    };
    let gamma = match g2_point(&vk.gamma_g2) {
        Some(p) => p,
        None => return false,
    };
    let delta = match g2_point(&vk.delta_g2) {
        Some(p) => p,
        None => return false,
    };

    let vk_x = match compute_vk_x(ic, public_inputs) {
        Some(p) => p,
        None => return false,
    };

    // e(A,B) == e(alpha,beta) · e(vk_x,gamma) · e(C,delta)
    //
    // `bls12_381::Gt` is written additively (see its own docs), so the
    // multiplicative pairing-target product is expressed as `+` here.
    let lhs = pairing(&a, &b);
    let rhs = pairing(&alpha, &beta) + pairing(&vk_x, &gamma) + pairing(&c, &delta);
    lhs == rhs
}

/// Derives the Fiat-Shamir batching scalar `r_i` for proof index `i` from a
/// 32-byte seed, via wide (512-bit) reduction so every output is a
/// uniformly-distributed, always-valid `Scalar` (mirrors
/// `crate::plonk::Transcript::challenge`).
fn batch_scalar(seed: &[u8; 32], i: u32) -> Scalar {
    let mut h0 = Sha256::new();
    h0.update(seed);
    h0.update(i.to_le_bytes());
    h0.update([0u8]);
    let d0 = h0.finalize();

    let mut h1 = Sha256::new();
    h1.update(seed);
    h1.update(i.to_le_bytes());
    h1.update([1u8]);
    let d1 = h1.finalize();

    let mut wide = [0u8; 64];
    wide[..32].copy_from_slice(&d0);
    wide[32..].copy_from_slice(&d1);
    Scalar::from_bytes_wide(&wide)
}

/// Verifies a batch of Groth16 proofs, all against the same verifying key
/// `vk`/`ic`, using a single randomized linear-combination pairing check
/// instead of `n` independent ones (standard batch-verification technique,
/// e.g. Bellare-Garay-Rabin 1998).
///
/// # Batching
///
/// Each proof individually must satisfy
/// `e(A_i,B_i) = e(alpha,beta)·e(vk_x_i,gamma)·e(C_i,delta)`. Raising
/// equation `i` to a Fiat-Shamir scalar `r_i` (derived from `seed`, which
/// the caller must compute over *all* proof/public-input material so no
/// party can predict `r_i` before the batch is fixed — see
/// `ZkVerifierContract::verify_aggregated_proofs`) and taking the product
/// over `i` collapses the three fixed-key pairings into one call each,
/// shared across the whole batch:
///
/// ```text
/// Π_i e(r_i·A_i, B_i)  ==  e((Σr_i)·alpha, beta) · e(Σr_i·vk_x_i, gamma) · e(Σr_i·C_i, delta)
/// ```
///
/// This performs `n + 3` calls to `pairing()` instead of the naive `4n`,
/// amortizing the fixed-key cost across the batch — the per-proof marginal
/// pairing cost converges to 1 (down from 4) as the batch grows. The `n`
/// left-hand-side pairings still each run their own Miller loop + final
/// exponentiation: collapsing those too (down to a single multi-Miller
/// loop) would need `bls12_381`'s `alloc` feature and a registered global
/// allocator, which this `#![no_std]` contract deliberately does not add
/// (see module docs).
///
/// Fails closed: any single malformed or invalid proof rejects the whole
/// batch (no partial-batch success), and an empty or mismatched-length
/// batch is rejected.
pub fn verify_batch(
    vk: &VerifyingKey,
    ic: &[[u8; G1_LEN]],
    proofs: &[&[u8]],
    public_inputs: &[&[u8]],
    seed: &[u8; 32],
) -> bool {
    let n = proofs.len();
    if n == 0 || n != public_inputs.len() {
        return false;
    }

    let alpha = match g1_point(&vk.alpha_g1) { Some(p) => p, None => return false };
    let beta = match g2_point(&vk.beta_g2) { Some(p) => p, None => return false };
    let gamma = match g2_point(&vk.gamma_g2) { Some(p) => p, None => return false };
    let delta = match g2_point(&vk.delta_g2) { Some(p) => p, None => return false };

    let mut lhs = Gt::identity();
    let mut agg_alpha_scalar = Scalar::zero();
    let mut agg_vk_x = G1Projective::identity();
    let mut agg_c = G1Projective::identity();

    for i in 0..n {
        let proof = proofs[i];
        let pi = public_inputs[i];
        if proof.len() != PROOF_LEN as usize {
            return false;
        }
        let a = match g1_point(&proof[0..G1_LEN]) { Some(p) => p, None => return false };
        let b_bytes: &[u8; G2_LEN] = match proof[G1_LEN..G1_LEN + G2_LEN].try_into() {
            Ok(a) => a,
            Err(_) => return false,
        };
        let b = match g2_point(b_bytes) { Some(p) => p, None => return false };
        let c = match g1_point(&proof[G1_LEN + G2_LEN..PROOF_LEN as usize]) {
            Some(p) => p,
            None => return false,
        };
        let vk_x = match compute_vk_x(ic, pi) { Some(p) => p, None => return false };

        let r_i = batch_scalar(seed, i as u32);
        lhs += pairing(&G1Affine::from(a * r_i), &b);
        agg_alpha_scalar += r_i;
        agg_vk_x += vk_x * r_i;
        agg_c += c * r_i;
    }

    let rhs = pairing(&G1Affine::from(alpha * agg_alpha_scalar), &beta)
        + pairing(&G1Affine::from(agg_vk_x), &gamma)
        + pairing(&G1Affine::from(agg_c), &delta);

    lhs == rhs
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_proof_len_matches_layout() {
        assert_eq!(PROOF_LEN, 192);
    }

    #[test]
    fn test_verify_rejects_wrong_length_proof() {
        let vk = VerifyingKey {
            alpha_g1: [0u8; G1_LEN],
            beta_g2: [0u8; G2_LEN],
            gamma_g2: [0u8; G2_LEN],
            delta_g2: [0u8; G2_LEN],
        };
        let ic = [[0u8; G1_LEN]; 1];
        assert!(!verify(&vk, &ic, &[], &[0u8; 10]));
    }

    #[test]
    fn test_verify_rejects_garbage_points() {
        let vk = VerifyingKey {
            alpha_g1: [0u8; G1_LEN],
            beta_g2: [0u8; G2_LEN],
            gamma_g2: [0u8; G2_LEN],
            delta_g2: [0u8; G2_LEN],
        };
        let ic = [[0u8; G1_LEN]; 1];
        let proof = [0u8; PROOF_LEN as usize];
        // All-zero compressed points don't decode to valid curve points
        // (compression flag bits are unset), so this must be rejected
        // structurally, never treated as a "valid" identity-element proof.
        assert!(!verify(&vk, &ic, &[], &proof));
    }

    /// Builds a genuine algebraically-satisfying (vk, ic, proof, public_inputs)
    /// instance by picking the trapdoor scalars (alpha, beta, gamma, delta,
    /// the IC coefficients, and the proof's `a`,`b` exponents) directly and
    /// solving for `C` such that the verification equation holds exactly —
    /// the same technique a simulator uses in the Groth16 zero-knowledge
    /// proof, and the strongest test available without standing up a full
    /// circuit + trusted setup: it proves the verifier's pairing equation
    /// (operand order, signs, vk_x accumulation) is actually correct, not
    /// just that it rejects garbage.
    fn satisfying_instance() -> (VerifyingKey, [[u8; G1_LEN]; 2], [u8; 32], [u8; PROOF_LEN as usize]) {
        let alpha_s = Scalar::from(7u64);
        let beta_s = Scalar::from(11u64);
        let gamma_s = Scalar::from(13u64);
        let delta_s = Scalar::from(17u64);
        let ic0_s = Scalar::from(19u64);
        let ic1_s = Scalar::from(23u64);
        let pi1 = Scalar::from(29u64);
        let a_s = Scalar::from(3u64);
        let b_s = Scalar::from(5u64);

        let g1 = G1Affine::generator();
        let g2 = G2Affine::generator();

        let alpha_g1 = G1Affine::from(g1 * alpha_s);
        let beta_g2 = G2Affine::from(g2 * beta_s);
        let gamma_g2 = G2Affine::from(g2 * gamma_s);
        let delta_g2 = G2Affine::from(g2 * delta_s);
        let ic0 = G1Affine::from(g1 * ic0_s);
        let ic1 = G1Affine::from(g1 * ic1_s);

        let a = G1Affine::from(g1 * a_s);
        let b = G2Affine::from(g2 * b_s);

        let vk_x_s = ic0_s + pi1 * ic1_s;
        let delta_inv = match Option::<Scalar>::from(delta_s.invert()) {
            Some(v) => v,
            None => panic!("delta must be invertible"),
        };
        // Solve for C such that a*b == alpha*beta + vk_x*gamma + c_exp*delta.
        let c_exp = (a_s * b_s - alpha_s * beta_s - vk_x_s * gamma_s) * delta_inv;
        let c = G1Affine::from(g1 * c_exp);

        let vk = VerifyingKey {
            alpha_g1: alpha_g1.to_compressed(),
            beta_g2: beta_g2.to_compressed(),
            gamma_g2: gamma_g2.to_compressed(),
            delta_g2: delta_g2.to_compressed(),
        };
        let ic = [ic0.to_compressed(), ic1.to_compressed()];

        let mut proof = [0u8; PROOF_LEN as usize];
        proof[0..G1_LEN].copy_from_slice(&a.to_compressed());
        proof[G1_LEN..G1_LEN + G2_LEN].copy_from_slice(&b.to_compressed());
        proof[G1_LEN + G2_LEN..PROOF_LEN as usize].copy_from_slice(&c.to_compressed());

        let mut public_inputs = [0u8; 32];
        public_inputs.copy_from_slice(&pi1.to_bytes());

        (vk, ic, public_inputs, proof)
    }

    #[test]
    fn test_verify_accepts_genuine_satisfying_instance() {
        let (vk, ic, public_inputs, proof) = satisfying_instance();
        assert!(verify(&vk, &ic, &public_inputs, &proof));
    }

    #[test]
    fn test_verify_rejects_tampered_public_input() {
        let (vk, ic, public_inputs, proof) = satisfying_instance();
        let mut bad_inputs = public_inputs;
        bad_inputs[0] ^= 1;
        assert!(!verify(&vk, &ic, &bad_inputs, &proof));
    }

    #[test]
    fn test_verify_rejects_tampered_proof() {
        let (vk, ic, public_inputs, proof) = satisfying_instance();
        let mut bad_proof = proof;
        bad_proof[G1_LEN + G2_LEN] ^= 1; // flip a byte inside C
        assert!(!verify(&vk, &ic, &public_inputs, &bad_proof));
    }

    #[test]
    fn test_verify_rejects_wrong_verifying_key() {
        let (vk, ic, public_inputs, proof) = satisfying_instance();
        let mut wrong_vk = vk;
        wrong_vk.alpha_g1 = G1Affine::from(G1Affine::generator() * Scalar::from(999u64)).to_compressed();
        assert!(!verify(&wrong_vk, &ic, &public_inputs, &proof));
    }

    #[test]
    fn test_verify_rejects_public_input_count_mismatch() {
        let (vk, ic, public_inputs, proof) = satisfying_instance();
        let mut two_inputs = [0u8; 64];
        two_inputs[..32].copy_from_slice(&public_inputs);
        // ic only has 2 entries (constant + 1 input); 2 public inputs needs 3.
        assert!(!verify(&vk, &ic, &two_inputs, &proof));
    }

    #[test]
    fn test_verify_batch_accepts_genuine_instances() {
        let (vk, ic, public_inputs, proof) = satisfying_instance();
        let seed = [42u8; 32];
        let proofs: [&[u8]; 3] = [&proof, &proof, &proof];
        let pis: [&[u8]; 3] = [&public_inputs, &public_inputs, &public_inputs];
        assert!(verify_batch(&vk, &ic, &proofs, &pis, &seed));
    }

    #[test]
    fn test_verify_batch_rejects_if_any_proof_invalid() {
        let (vk, ic, public_inputs, proof) = satisfying_instance();
        let seed = [42u8; 32];
        let mut bad_proof = proof;
        bad_proof[0] ^= 1;
        let proofs: [&[u8]; 2] = [&proof, &bad_proof];
        let pis: [&[u8]; 2] = [&public_inputs, &public_inputs];
        assert!(!verify_batch(&vk, &ic, &proofs, &pis, &seed));
    }

    #[test]
    fn test_verify_batch_rejects_empty_batch() {
        let (vk, ic, _public_inputs, _proof) = satisfying_instance();
        let proofs: [&[u8]; 0] = [];
        let pis: [&[u8]; 0] = [];
        assert!(!verify_batch(&vk, &ic, &proofs, &pis, &[0u8; 32]));
    }
}
