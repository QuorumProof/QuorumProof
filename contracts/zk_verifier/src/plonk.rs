//! Genuine BLS12-381 KZG-based PLONK proof verification.
//!
//! This module implements the verifier side of vanilla (non-Turbo) PLONK
//! [Gabizon, Williamson, Ciobotaru 2019](https://eprint.iacr.org/2019/953),
//! using the KZG polynomial commitment scheme over BLS12-381 and the
//! "r0-direct" linearisation variant (the verifier computes the linearisation
//! polynomial's constant term itself rather than having the prover reveal an
//! extra `r̄` evaluation — the same approach used by production BLS12-381
//! PLONK implementations such as dusk-network/plonk). See
//! `docs/plonk-verification.md` for the full protocol specification
//! (transcript layout, byte encodings, domain/coset conventions).
//!
//! This module is pure (no `Env`, no storage access) so it can be unit
//! tested directly and reused independently of the Soroban host.
//!
//! Deliberately no `alloc`: the crate is built with
//! `bls12_381 = { features = ["groups", "pairings"] }` (no `"alloc"`
//! feature), so the batched multi-pairing helpers (`multi_miller_loop`,
//! `G2Prepared`) are unavailable. The final check instead uses two
//! independent calls to the single-pair `pairing()` function, which costs
//! one extra Miller loop + final exponentiation but needs no global
//! allocator inside the contract.

use bls12_381::{pairing, G1Affine, G1Projective, G2Affine, Scalar};
use ff::PrimeField;
use sha2::{Digest, Sha256};

/// Compressed G1 point size (BLS12-381).
pub const G1_LEN: usize = 48;
/// Compressed G2 point size (BLS12-381).
pub const G2_LEN: usize = 96;
/// Scalar (Fr) element size.
pub const SCALAR_LEN: usize = 32;
/// Number of G1 commitments carried in a proof.
pub const PROOF_G1_COUNT: usize = 9;
/// Number of scalar evaluations carried in a proof.
pub const PROOF_EVAL_COUNT: usize = 6;
/// Total PLONK proof length in bytes: 9 compressed G1 points + 6 scalars.
pub const PLONK_PROOF_LEN: u32 = (PROOF_G1_COUNT * G1_LEN + PROOF_EVAL_COUNT * SCALAR_LEN) as u32;

/// Permutation-argument coset constants `k1`, `k2` (standard PLONK choice).
const COSET_K1: u64 = 2;
const COSET_K2: u64 = 3;

/// Circuit-specific PLONK verifying key: selector and permutation
/// polynomial commitments derived (off-chain) from the universal SRS,
/// plus the circuit's domain size and public-input count.
#[derive(Clone)]
pub struct VerifyingKey {
    /// `n`, the number of gates / evaluation-domain size. Must be a power of two.
    pub domain_size: u32,
    /// `l`, the number of public-input wires (must match `public_inputs.len()/32`).
    pub num_public_inputs: u32,
    pub q_m: [u8; G1_LEN],
    pub q_l: [u8; G1_LEN],
    pub q_r: [u8; G1_LEN],
    pub q_o: [u8; G1_LEN],
    pub q_c: [u8; G1_LEN],
    pub s1: [u8; G1_LEN],
    pub s2: [u8; G1_LEN],
    pub s3: [u8; G1_LEN],
}

impl VerifyingKey {
    /// Canonical byte encoding used both for the registered `vk_hash` and as
    /// transcript input:
    /// `domain_size(4 LE) || num_public_inputs(4 LE) || q_m || q_l || q_r || q_o || q_c || s1 || s2 || s3`.
    pub fn canonical_bytes(&self) -> [u8; 8 + 8 * G1_LEN] {
        let mut out = [0u8; 8 + 8 * G1_LEN];
        out[0..4].copy_from_slice(&self.domain_size.to_le_bytes());
        out[4..8].copy_from_slice(&self.num_public_inputs.to_le_bytes());
        let pts = [
            &self.q_m, &self.q_l, &self.q_r, &self.q_o, &self.q_c, &self.s1, &self.s2, &self.s3,
        ];
        let mut off = 8;
        for p in pts {
            out[off..off + G1_LEN].copy_from_slice(p);
            off += G1_LEN;
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

/// Validates a compressed G2 point (used by admin-facing SRS registration).
pub fn is_valid_g2(bytes: &[u8; G2_LEN]) -> bool {
    g2_point(bytes).is_some()
}

/// Computes the `domain_size`-th root of unity `omega` used as the
/// multiplicative evaluation domain generator, by taking the field's fixed
/// 2^S-th root of unity and raising it to `2^(S - log2(domain_size))`.
/// Returns `None` if `domain_size` is zero, not a power of two, or exceeds
/// the field's 2-adicity.
pub(crate) fn domain_generator(domain_size: u32) -> Option<Scalar> {
    if domain_size == 0 || !domain_size.is_power_of_two() {
        return None;
    }
    let k = domain_size.trailing_zeros();
    let s = <Scalar as PrimeField>::S;
    if k > s {
        return None;
    }
    let shift = s - k;
    let exp: u64 = 1u64 << shift;
    Some(<Scalar as PrimeField>::ROOT_OF_UNITY.pow_vartime(&[exp, 0, 0, 0]))
}

/// A simple SHA-256-based Fiat-Shamir transcript. See
/// `docs/plonk-verification.md` for the exact absorb/challenge sequence.
pub(crate) struct Transcript {
    state: [u8; 32],
}

impl Transcript {
    pub(crate) fn new(domain_sep: &[u8]) -> Self {
        let mut h = Sha256::new();
        h.update(domain_sep);
        let mut state = [0u8; 32];
        state.copy_from_slice(&h.finalize());
        Transcript { state }
    }

    pub(crate) fn absorb(&mut self, label: &[u8], data: &[u8]) {
        let mut h = Sha256::new();
        h.update(self.state);
        h.update(label);
        h.update((data.len() as u64).to_le_bytes());
        h.update(data);
        self.state.copy_from_slice(&h.finalize());
    }

    /// Squeezes a uniformly-distributed scalar via wide (512-bit) reduction,
    /// then ratchets the transcript state forward so the next challenge
    /// (or absorb) is independent of this one.
    pub(crate) fn challenge(&mut self, label: &[u8]) -> Scalar {
        let mut h0 = Sha256::new();
        h0.update(self.state);
        h0.update(label);
        h0.update([0u8]);
        let d0 = h0.finalize();

        let mut h1 = Sha256::new();
        h1.update(self.state);
        h1.update(label);
        h1.update([1u8]);
        let d1 = h1.finalize();

        let mut wide = [0u8; 64];
        wide[..32].copy_from_slice(&d0);
        wide[32..].copy_from_slice(&d1);

        let mut h2 = Sha256::new();
        h2.update(self.state);
        h2.update(label);
        h2.update([2u8]);
        self.state.copy_from_slice(&h2.finalize());

        Scalar::from_bytes_wide(&wide)
    }
}

/// Verifies a vanilla-PLONK proof against a registered circuit-specific
/// verifying key and the universal SRS's G2 element `[tau]_2`.
///
/// `public_inputs` is a flat, non-empty, 32-byte-aligned byte string of
/// little-endian Fr scalars, one per public-input wire, in circuit signal
/// order (must match `vk.num_public_inputs` exactly).
///
/// `proof` must be exactly [`PLONK_PROOF_LEN`] bytes: 9 compressed G1 points
/// (`[a],[b],[c],[z],[t_lo],[t_mid],[t_hi],[W_zeta],[W_zeta_omega]`) followed
/// by 6 little-endian Fr scalars (`a_bar,b_bar,c_bar,s1_bar,s2_bar,zw_bar`).
///
/// Returns `false` (never panics) for any structurally, algebraically, or
/// cryptographically invalid input — malformed points/scalars, a
/// public-input count mismatch, or a failing pairing check are all
/// indistinguishable rejection outcomes to the caller.
pub fn verify(
    vk: &VerifyingKey,
    srs_tau_g2: &[u8; G2_LEN],
    public_inputs: &[u8],
    proof: &[u8],
) -> bool {
    if proof.len() != PLONK_PROOF_LEN as usize {
        return false;
    }
    if public_inputs.is_empty() || public_inputs.len() % SCALAR_LEN != 0 {
        return false;
    }
    let l = (public_inputs.len() / SCALAR_LEN) as u32;
    if l != vk.num_public_inputs || l > vk.domain_size {
        return false;
    }

    let n = vk.domain_size;
    let omega = match domain_generator(n) {
        Some(w) => w,
        None => return false,
    };

    let q_m = match g1_point(&vk.q_m) { Some(p) => p, None => return false };
    let q_l = match g1_point(&vk.q_l) { Some(p) => p, None => return false };
    let q_r = match g1_point(&vk.q_r) { Some(p) => p, None => return false };
    let q_o = match g1_point(&vk.q_o) { Some(p) => p, None => return false };
    let q_c = match g1_point(&vk.q_c) { Some(p) => p, None => return false };
    let s1_pt = match g1_point(&vk.s1) { Some(p) => p, None => return false };
    let s2_pt = match g1_point(&vk.s2) { Some(p) => p, None => return false };
    let s3_pt = match g1_point(&vk.s3) { Some(p) => p, None => return false };
    let x2 = match g2_point(srs_tau_g2) { Some(p) => p, None => return false };

    let g1_at = |i: usize| g1_point(&proof[i * G1_LEN..(i + 1) * G1_LEN]);
    let a = match g1_at(0) { Some(p) => p, None => return false };
    let b = match g1_at(1) { Some(p) => p, None => return false };
    let c = match g1_at(2) { Some(p) => p, None => return false };
    let z = match g1_at(3) { Some(p) => p, None => return false };
    let t_lo = match g1_at(4) { Some(p) => p, None => return false };
    let t_mid = match g1_at(5) { Some(p) => p, None => return false };
    let t_hi = match g1_at(6) { Some(p) => p, None => return false };
    let w_zeta = match g1_at(7) { Some(p) => p, None => return false };
    let w_zeta_omega = match g1_at(8) { Some(p) => p, None => return false };

    let eval_base = PROOF_G1_COUNT * G1_LEN;
    let sc_at = |i: usize| {
        scalar_from(&proof[eval_base + i * SCALAR_LEN..eval_base + (i + 1) * SCALAR_LEN])
    };
    let a_bar = match sc_at(0) { Some(s) => s, None => return false };
    let b_bar = match sc_at(1) { Some(s) => s, None => return false };
    let c_bar = match sc_at(2) { Some(s) => s, None => return false };
    let s1_bar = match sc_at(3) { Some(s) => s, None => return false };
    let s2_bar = match sc_at(4) { Some(s) => s, None => return false };
    let zw_bar = match sc_at(5) { Some(s) => s, None => return false };

    // ── Fiat-Shamir transcript ──────────────────────────────────────────
    let mut ts = Transcript::new(b"QuorumProof-PLONK-v1");
    ts.absorb(b"vk", &vk.canonical_bytes());
    ts.absorb(b"public_inputs", public_inputs);
    ts.absorb(b"a", &a.to_compressed());
    ts.absorb(b"b", &b.to_compressed());
    ts.absorb(b"c", &c.to_compressed());
    let beta = ts.challenge(b"beta");
    let gamma = ts.challenge(b"gamma");
    ts.absorb(b"z", &z.to_compressed());
    let alpha = ts.challenge(b"alpha");
    ts.absorb(b"t_lo", &t_lo.to_compressed());
    ts.absorb(b"t_mid", &t_mid.to_compressed());
    ts.absorb(b"t_hi", &t_hi.to_compressed());
    let zeta = ts.challenge(b"zeta");
    ts.absorb(b"a_bar", &a_bar.to_bytes());
    ts.absorb(b"b_bar", &b_bar.to_bytes());
    ts.absorb(b"c_bar", &c_bar.to_bytes());
    ts.absorb(b"s1_bar", &s1_bar.to_bytes());
    ts.absorb(b"s2_bar", &s2_bar.to_bytes());
    ts.absorb(b"zw_bar", &zw_bar.to_bytes());
    let v = ts.challenge(b"v");
    ts.absorb(b"w_zeta", &w_zeta.to_compressed());
    ts.absorb(b"w_zeta_omega", &w_zeta_omega.to_compressed());
    let u = ts.challenge(b"u");

    // ── Z_H(zeta), L_1(zeta), PI(zeta) ──────────────────────────────────
    let zeta_pow_n = zeta.pow_vartime(&[n as u64, 0, 0, 0]);
    let z_h_zeta = zeta_pow_n - Scalar::one();
    let n_scalar = Scalar::from(n as u64);
    let one = Scalar::one();

    let denom_l1 = n_scalar * (zeta - one);
    let inv_denom_l1 = match Option::<Scalar>::from(denom_l1.invert()) {
        Some(inv) => inv,
        None => return false,
    };
    let l1_zeta = z_h_zeta * inv_denom_l1;

    let mut pi_zeta = Scalar::zero();
    let mut omega_pow = Scalar::one();
    for i in 0..(l as usize) {
        let pi_i = match scalar_from(&public_inputs[i * SCALAR_LEN..(i + 1) * SCALAR_LEN]) {
            Some(s) => s,
            None => return false,
        };
        let denom = n_scalar * (zeta - omega_pow);
        let inv_denom = match Option::<Scalar>::from(denom.invert()) {
            Some(inv) => inv,
            None => return false,
        };
        let l_i = omega_pow * z_h_zeta * inv_denom;
        pi_zeta += pi_i * l_i;
        omega_pow *= omega;
    }

    // ── Linearisation constant term r0 and commitment coefficients ─────
    let k1 = Scalar::from(COSET_K1);
    let k2 = Scalar::from(COSET_K2);

    let r0 = pi_zeta
        - l1_zeta * alpha.square()
        - alpha
            * (a_bar + beta * s1_bar + gamma)
            * (b_bar + beta * s2_bar + gamma)
            * (c_bar + gamma)
            * zw_bar;

    let coeff_z = alpha
        * (a_bar + beta * zeta + gamma)
        * (b_bar + beta * k1 * zeta + gamma)
        * (c_bar + beta * k2 * zeta + gamma)
        + l1_zeta * alpha.square();

    let coeff_s3 =
        -(alpha * (a_bar + beta * s1_bar + gamma) * (b_bar + beta * s2_bar + gamma) * beta * zw_bar);

    // [D] = a_bar*b_bar*[q_m] + a_bar*[q_l] + b_bar*[q_r] + c_bar*[q_o] + [q_c]
    //     + coeff_z*[z] + coeff_s3*[s3]
    //     - Z_H(zeta)*([t_lo] + zeta^n*[t_mid] + zeta^{2n}*[t_hi])
    let zeta_2n = zeta_pow_n.square();

    let mut d = G1Projective::from(q_m) * (a_bar * b_bar);
    d += q_l * a_bar;
    d += q_r * b_bar;
    d += q_o * c_bar;
    d += q_c;
    d += z * coeff_z;
    d += s3_pt * coeff_s3;

    let mut t_combined = G1Projective::from(t_lo);
    t_combined += t_mid * zeta_pow_n;
    t_combined += t_hi * zeta_2n;
    d -= t_combined * z_h_zeta;

    // [F] = [D] + v*[a] + v^2*[b] + v^3*[c] + v^4*[s1] + v^5*[s2] + u*[z]
    let v2 = v.square();
    let v3 = v2 * v;
    let v4 = v3 * v;
    let v5 = v4 * v;

    let mut f = d;
    f += a * v;
    f += b * v2;
    f += c * v3;
    f += s1_pt * v4;
    f += s2_pt * v5;
    f += z * u;

    // E = -r0 + v*a_bar + v^2*b_bar + v^3*c_bar + v^4*s1_bar + v^5*s2_bar + u*zw_bar
    let e = -r0 + v * a_bar + v2 * b_bar + v3 * c_bar + v4 * s1_bar + v5 * s2_bar + u * zw_bar;

    // ── Batched KZG pairing check ────────────────────────────────────────
    // e([W_zeta] + u*[W_zeta_omega], [x]_2)
    //   == e(zeta*[W_zeta] + u*zeta*omega*[W_zeta_omega] + [F] - E*[1]_1, [1]_2)
    let zeta_omega = zeta * omega;

    let mut lhs_g1 = G1Projective::from(w_zeta);
    lhs_g1 += w_zeta_omega * u;

    let mut rhs_g1 = w_zeta * zeta;
    rhs_g1 += w_zeta_omega * (u * zeta_omega);
    rhs_g1 += f;
    rhs_g1 -= G1Affine::generator() * e;

    let lhs_affine = G1Affine::from(lhs_g1);
    let rhs_affine = G1Affine::from(rhs_g1);
    let g2_gen = G2Affine::generator();

    pairing(&lhs_affine, &x2) == pairing(&rhs_affine, &g2_gen)
}
