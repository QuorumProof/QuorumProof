//! Test-only reference PLONK prover.
//!
//! Builds a tiny (`n = 4`) but *real* vanilla-PLONK circuit by hand — no
//! FFT, no external proving library — and produces genuinely valid proofs
//! against it, so `mod tests` in `lib.rs` can exercise
//! [`crate::plonk::verify`] with cryptographically meaningful inputs rather
//! than well-formed-looking garbage. Not part of the production contract;
//! compiled only under `#[cfg(test)]` or the `testutils` feature (so
//! downstream crates like benches/ can reuse it too). See
//! `docs/plonk-verification.md` for the protocol this mirrors.
#![cfg(any(test, feature = "testutils"))]
extern crate std;

use std::vec;
use std::vec::Vec;

use bls12_381::{G1Affine, G1Projective, G2Affine, G2Projective, Scalar};

use crate::plonk::{self, Transcript, G1_LEN, G2_LEN, PLONK_PROOF_LEN, SCALAR_LEN};
use crate::PlonkVerifyingKey;
use soroban_sdk::{Bytes, BytesN, Env};

/// Toy circuit domain size (must be a power of two).
pub const N: usize = 4;

// ── Minimal polynomial arithmetic (coefficients, low-to-high) ──────────────

fn poly_add(a: &[Scalar], b: &[Scalar]) -> Vec<Scalar> {
    let n = a.len().max(b.len());
    let mut out = Vec::with_capacity(n);
    for i in 0..n {
        let av = a.get(i).copied().unwrap_or(Scalar::zero());
        let bv = b.get(i).copied().unwrap_or(Scalar::zero());
        out.push(av + bv);
    }
    out
}

fn poly_sub(a: &[Scalar], b: &[Scalar]) -> Vec<Scalar> {
    let n = a.len().max(b.len());
    let mut out = Vec::with_capacity(n);
    for i in 0..n {
        let av = a.get(i).copied().unwrap_or(Scalar::zero());
        let bv = b.get(i).copied().unwrap_or(Scalar::zero());
        out.push(av - bv);
    }
    out
}

fn poly_scale(a: &[Scalar], s: Scalar) -> Vec<Scalar> {
    a.iter().map(|x| *x * s).collect()
}

fn poly_mul(a: &[Scalar], b: &[Scalar]) -> Vec<Scalar> {
    if a.is_empty() || b.is_empty() {
        return Vec::new();
    }
    let mut out = vec![Scalar::zero(); a.len() + b.len() - 1];
    for (i, ai) in a.iter().enumerate() {
        for (j, bj) in b.iter().enumerate() {
            out[i + j] += *ai * *bj;
        }
    }
    out
}

fn poly_eval(a: &[Scalar], x: Scalar) -> Scalar {
    let mut acc = Scalar::zero();
    for c in a.iter().rev() {
        acc = acc * x + *c;
    }
    acc
}

/// Divides `p` by the monic linear divisor `(X - r)`, returning `(quotient, remainder)`.
fn poly_div_by_linear(p: &[Scalar], r: Scalar) -> (Vec<Scalar>, Scalar) {
    if p.is_empty() {
        return (Vec::new(), Scalar::zero());
    }
    let deg = p.len() - 1;
    if deg == 0 {
        return (Vec::new(), p[0]);
    }
    let mut q = vec![Scalar::zero(); deg];
    q[deg - 1] = p[deg];
    for i in (0..deg - 1).rev() {
        q[i] = p[i + 1] + r * q[i + 1];
    }
    let remainder = p[0] + r * q[0];
    (q, remainder)
}

/// Divides `num` by a monic polynomial `den` (leading coefficient 1),
/// returning `(quotient, remainder)`.
fn poly_divmod_monic(num: &[Scalar], den: &[Scalar]) -> (Vec<Scalar>, Vec<Scalar>) {
    let den_deg = den.len() - 1;
    let mut rem = num.to_vec();
    if rem.len() <= den_deg {
        return (Vec::new(), rem);
    }
    let q_len = rem.len() - den_deg;
    let mut q = vec![Scalar::zero(); q_len];
    for i in (0..q_len).rev() {
        let coeff = rem[i + den_deg];
        q[i] = coeff;
        for (j, dj) in den.iter().enumerate() {
            rem[i + j] -= coeff * *dj;
        }
    }
    rem.truncate(den_deg.max(1));
    (q, rem)
}

/// Lagrange-interpolates the unique degree-`<domain.len()` polynomial taking
/// `values[i]` at `domain[i]`.
fn lagrange_interpolate(domain: &[Scalar], values: &[Scalar]) -> Vec<Scalar> {
    let n = domain.len();
    let mut result = vec![Scalar::zero(); n];
    for i in 0..n {
        let mut basis: Vec<Scalar> = vec![Scalar::one()];
        let mut denom = Scalar::one();
        for j in 0..n {
            if j == i {
                continue;
            }
            basis = poly_mul(&basis, &[-domain[j], Scalar::one()]);
            denom *= domain[i] - domain[j];
        }
        let inv_denom = Option::<Scalar>::from(denom.invert()).expect("distinct domain points");
        let scaled = poly_scale(&basis, values[i] * inv_denom);
        result = poly_add(&result, &scaled);
    }
    result
}

fn commit(coeffs: &[Scalar], srs_g1: &[G1Projective]) -> G1Affine {
    let mut acc = G1Projective::identity();
    for (i, c) in coeffs.iter().enumerate() {
        if i >= srs_g1.len() {
            panic!("toy SRS too small for polynomial degree");
        }
        acc += srs_g1[i] * *c;
    }
    G1Affine::from(acc)
}

/// A fixed, deterministic (non-random) toxic-waste scalar for the toy
/// trusted setup. Fine for tests — a real deployment must run an actual
/// multi-party ceremony (see `docs/plonk-verification.md`).
fn test_tau(seed: u64) -> Scalar {
    Scalar::from(0x51e_c0de_u64.wrapping_mul(seed).wrapping_add(424_242))
}

struct ToySrs {
    g1: Vec<G1Projective>,
    tau_g2: G2Affine,
}

fn build_srs(seed: u64, max_degree: usize) -> ToySrs {
    let tau = test_tau(seed);
    let mut g1 = Vec::with_capacity(max_degree + 1);
    let mut tau_pow = Scalar::one();
    for _ in 0..=max_degree {
        g1.push(G1Projective::from(G1Affine::generator()) * tau_pow);
        tau_pow *= tau;
    }
    let tau_g2 = G2Affine::from(G2Projective::from(G2Affine::generator()) * tau);
    ToySrs { g1, tau_g2 }
}

/// The five selector polynomials (evaluation form over the toy domain) for
/// a tiny 4-row circuit:
///   row0: public-input row      a0 = pi1                (q_l=1)
///   row1: multiplication gate   a1*b1 = c1               (q_m=1, q_o=-1)
///   row2: addition gate         a2+b2 = c2  (variant 1: a2-b2=c2)
///   row3: unconstrained         (all selectors zero)
/// Permutation is the identity (no cross-wire copy constraints), so the
/// grand-product polynomial z(X) is identically 1 — still a fully genuine,
/// if unglamorous, instance of the general protocol.
fn selector_evals(variant: u8) -> ([Scalar; N], [Scalar; N], [Scalar; N], [Scalar; N], [Scalar; N]) {
    let one = Scalar::one();
    let zero = Scalar::zero();
    let neg_one = -Scalar::one();
    let q_m = [zero, one, zero, zero];
    let q_l = [one, zero, one, zero];
    let q_c = [zero, zero, zero, zero];
    if variant == 0 {
        let q_r = [zero, zero, one, zero];
        let q_o = [zero, neg_one, neg_one, zero];
        (q_m, q_l, q_r, q_o, q_c)
    } else {
        // Distinct circuit: row2 becomes a2 - b2 = c2 instead of a2 + b2 = c2.
        let q_r = [zero, zero, neg_one, zero];
        let q_o = [zero, neg_one, neg_one, zero];
        (q_m, q_l, q_r, q_o, q_c)
    }
}

/// A generated toy proof plus every piece of on-chain state needed to
/// register and verify it.
pub struct ToyProofFixture {
    pub vk: PlonkVerifyingKey,
    pub vk_hash: BytesN<32>,
    pub srs_tau_g2: BytesN<96>,
    pub public_inputs: Bytes,
    pub proof: Bytes,
}

/// Generates a genuinely valid PLONK proof for the toy circuit identified
/// by `variant` (0 or 1 — see [`selector_evals`]), using SRS `seed` as the
/// (deterministic, test-only) trusted-setup toxic waste.
pub fn generate_valid_proof(
    env: &Env,
    variant: u8,
    srs_seed: u64,
    pi1: u64,
    a1: u64,
    b1: u64,
    a2: u64,
    b2: u64,
) -> ToyProofFixture {
    let n_u32 = N as u32;
    let omega = plonk::domain_generator(n_u32).expect("N must be a power of two");
    let domain = [Scalar::one(), omega, omega * omega, omega * omega * omega];

    let pi1_s = Scalar::from(pi1);
    let a1_s = Scalar::from(a1);
    let b1_s = Scalar::from(b1);
    let c1_s = a1_s * b1_s;
    let a2_s = Scalar::from(a2);
    let b2_s = Scalar::from(b2);
    let c2_s = if variant == 0 { a2_s + b2_s } else { a2_s - b2_s };

    let a_evals = [pi1_s, a1_s, a2_s, Scalar::zero()];
    let b_evals = [Scalar::zero(), b1_s, b2_s, Scalar::zero()];
    let c_evals = [Scalar::zero(), c1_s, c2_s, Scalar::zero()];
    let pi_evals = [-pi1_s, Scalar::zero(), Scalar::zero(), Scalar::zero()];

    let (q_m_e, q_l_e, q_r_e, q_o_e, q_c_e) = selector_evals(variant);

    let a_poly = lagrange_interpolate(&domain, &a_evals);
    let b_poly = lagrange_interpolate(&domain, &b_evals);
    let c_poly = lagrange_interpolate(&domain, &c_evals);
    let pi_poly = lagrange_interpolate(&domain, &pi_evals);
    let q_m_poly = lagrange_interpolate(&domain, &q_m_e);
    let q_l_poly = lagrange_interpolate(&domain, &q_l_e);
    let q_r_poly = lagrange_interpolate(&domain, &q_r_e);
    let q_o_poly = lagrange_interpolate(&domain, &q_o_e);
    let q_c_poly = lagrange_interpolate(&domain, &q_c_e);

    let s1_poly = vec![Scalar::zero(), Scalar::one()]; // Sigma1(X) = X
    let s2_poly = vec![Scalar::zero(), Scalar::from(2u64)]; // Sigma2(X) = k1*X
    let s3_poly = vec![Scalar::zero(), Scalar::from(3u64)]; // Sigma3(X) = k2*X
    let z_poly = vec![Scalar::one()]; // z(X) = 1 (identity permutation)

    // GateEval(X) = q_m*a*b + q_l*a + q_r*b + q_o*c + q_c + PI
    let mut gate = poly_mul(&poly_mul(&q_m_poly, &a_poly), &b_poly);
    gate = poly_add(&gate, &poly_mul(&q_l_poly, &a_poly));
    gate = poly_add(&gate, &poly_mul(&q_r_poly, &b_poly));
    gate = poly_add(&gate, &poly_mul(&q_o_poly, &c_poly));
    gate = poly_add(&gate, &q_c_poly);
    gate = poly_add(&gate, &pi_poly);

    for &x in &domain {
        assert_eq!(poly_eval(&gate, x), Scalar::zero(), "toy circuit gate identity does not vanish on domain");
    }

    let mut z_h = vec![Scalar::zero(); N + 1];
    z_h[0] = -Scalar::one();
    z_h[N] = Scalar::one();
    let (t_poly, remainder) = poly_divmod_monic(&gate, &z_h);
    for r in &remainder {
        assert_eq!(*r, Scalar::zero(), "gate poly not exactly divisible by Z_H");
    }
    assert!(t_poly.len() <= 3 * N, "toy circuit quotient degree exceeds 3n-1");

    let mut t_lo = vec![Scalar::zero(); N];
    let mut t_mid = vec![Scalar::zero(); N];
    let mut t_hi = vec![Scalar::zero(); N];
    for (i, c) in t_poly.iter().enumerate() {
        if i < N {
            t_lo[i] = *c;
        } else if i < 2 * N {
            t_mid[i - N] = *c;
        } else {
            t_hi[i - 2 * N] = *c;
        }
    }

    let srs = build_srs(srs_seed, 3 * N);

    let q_m_c = commit(&q_m_poly, &srs.g1);
    let q_l_c = commit(&q_l_poly, &srs.g1);
    let q_r_c = commit(&q_r_poly, &srs.g1);
    let q_o_c = commit(&q_o_poly, &srs.g1);
    let q_c_c = commit(&q_c_poly, &srs.g1);
    let s1_c = commit(&s1_poly, &srs.g1);
    let s2_c = commit(&s2_poly, &srs.g1);
    let s3_c = commit(&s3_poly, &srs.g1);

    let a_c = commit(&a_poly, &srs.g1);
    let b_c = commit(&b_poly, &srs.g1);
    let c_c = commit(&c_poly, &srs.g1);
    let z_c = commit(&z_poly, &srs.g1);
    let t_lo_c = commit(&t_lo, &srs.g1);
    let t_mid_c = commit(&t_mid, &srs.g1);
    let t_hi_c = commit(&t_hi, &srs.g1);

    let core_vk = plonk::VerifyingKey {
        domain_size: n_u32,
        num_public_inputs: 1,
        q_m: q_m_c.to_compressed(),
        q_l: q_l_c.to_compressed(),
        q_r: q_r_c.to_compressed(),
        q_o: q_o_c.to_compressed(),
        q_c: q_c_c.to_compressed(),
        s1: s1_c.to_compressed(),
        s2: s2_c.to_compressed(),
        s3: s3_c.to_compressed(),
    };

    let mut public_inputs_bytes = [0u8; SCALAR_LEN];
    public_inputs_bytes.copy_from_slice(&pi1_s.to_bytes());

    // ── Transcript (must mirror plonk::verify exactly) ──────────────────
    let mut ts = Transcript::new(b"QuorumProof-PLONK-v1");
    ts.absorb(b"vk", &core_vk.canonical_bytes());
    ts.absorb(b"public_inputs", &public_inputs_bytes);
    ts.absorb(b"a", &a_c.to_compressed());
    ts.absorb(b"b", &b_c.to_compressed());
    ts.absorb(b"c", &c_c.to_compressed());
    let beta = ts.challenge(b"beta");
    let gamma = ts.challenge(b"gamma");
    ts.absorb(b"z", &z_c.to_compressed());
    let alpha = ts.challenge(b"alpha");
    ts.absorb(b"t_lo", &t_lo_c.to_compressed());
    ts.absorb(b"t_mid", &t_mid_c.to_compressed());
    ts.absorb(b"t_hi", &t_hi_c.to_compressed());
    let zeta = ts.challenge(b"zeta");

    let a_bar = poly_eval(&a_poly, zeta);
    let b_bar = poly_eval(&b_poly, zeta);
    let c_bar = poly_eval(&c_poly, zeta);
    let s1_bar = poly_eval(&s1_poly, zeta);
    let s2_bar = poly_eval(&s2_poly, zeta);
    let zeta_omega = zeta * omega;
    let zw_bar = poly_eval(&z_poly, zeta_omega);

    ts.absorb(b"a_bar", &a_bar.to_bytes());
    ts.absorb(b"b_bar", &b_bar.to_bytes());
    ts.absorb(b"c_bar", &c_bar.to_bytes());
    ts.absorb(b"s1_bar", &s1_bar.to_bytes());
    ts.absorb(b"s2_bar", &s2_bar.to_bytes());
    ts.absorb(b"zw_bar", &zw_bar.to_bytes());
    let v = ts.challenge(b"v");

    // ── Linearisation polynomial D(X) (must mirror plonk::verify's [D]) ──
    let n_scalar = Scalar::from(N as u64);
    let zeta_pow_n = zeta.pow_vartime(&[N as u64, 0, 0, 0]);
    let z_h_zeta = zeta_pow_n - Scalar::one();
    let l1_zeta = z_h_zeta * Option::<Scalar>::from((n_scalar * (zeta - Scalar::one())).invert()).unwrap();
    let k1 = Scalar::from(2u64);
    let k2 = Scalar::from(3u64);

    let coeff_z = alpha
        * (a_bar + beta * zeta + gamma)
        * (b_bar + beta * k1 * zeta + gamma)
        * (c_bar + beta * k2 * zeta + gamma)
        + l1_zeta * alpha.square();
    let coeff_s3 = -(alpha * (a_bar + beta * s1_bar + gamma) * (b_bar + beta * s2_bar + gamma) * beta * zw_bar);

    let mut d_poly = poly_scale(&q_m_poly, a_bar * b_bar);
    d_poly = poly_add(&d_poly, &poly_scale(&q_l_poly, a_bar));
    d_poly = poly_add(&d_poly, &poly_scale(&q_r_poly, b_bar));
    d_poly = poly_add(&d_poly, &poly_scale(&q_o_poly, c_bar));
    d_poly = poly_add(&d_poly, &q_c_poly);
    d_poly = poly_add(&d_poly, &poly_scale(&z_poly, coeff_z));
    d_poly = poly_add(&d_poly, &poly_scale(&s3_poly, coeff_s3));

    let zeta_2n = zeta_pow_n.square();
    let mut t_combined = poly_add(&t_lo, &poly_scale(&t_mid, zeta_pow_n));
    t_combined = poly_add(&t_combined, &poly_scale(&t_hi, zeta_2n));
    d_poly = poly_sub(&d_poly, &poly_scale(&t_combined, z_h_zeta));

    // Fzeta(X) = D(X) + v*a(X) + v^2*b(X) + v^3*c(X) + v^4*s1(X) + v^5*s2(X)
    let v2 = v.square();
    let v3 = v2 * v;
    let v4 = v3 * v;
    let v5 = v4 * v;
    let mut f_zeta_poly = d_poly;
    f_zeta_poly = poly_add(&f_zeta_poly, &poly_scale(&a_poly, v));
    f_zeta_poly = poly_add(&f_zeta_poly, &poly_scale(&b_poly, v2));
    f_zeta_poly = poly_add(&f_zeta_poly, &poly_scale(&c_poly, v3));
    f_zeta_poly = poly_add(&f_zeta_poly, &poly_scale(&s1_poly, v4));
    f_zeta_poly = poly_add(&f_zeta_poly, &poly_scale(&s2_poly, v5));

    let e_zeta = poly_eval(&f_zeta_poly, zeta);
    let mut num_zeta = f_zeta_poly;
    num_zeta[0] -= e_zeta;
    let (w_zeta_poly, rem_zeta) = poly_div_by_linear(&num_zeta, zeta);
    assert_eq!(rem_zeta, Scalar::zero(), "Fzeta(X) does not vanish at zeta after subtracting claimed eval");

    let mut num_zeta_omega = z_poly;
    num_zeta_omega[0] -= zw_bar;
    let (w_zeta_omega_poly, rem_zw) = poly_div_by_linear(&num_zeta_omega, zeta_omega);
    assert_eq!(rem_zw, Scalar::zero(), "z(X) does not vanish at zeta*omega after subtracting claimed eval");

    let w_zeta_c = commit(&w_zeta_poly, &srs.g1);
    let w_zeta_omega_c = commit(&w_zeta_omega_poly, &srs.g1);

    // ── Assemble proof bytes ─────────────────────────────────────────────
    let mut buf = [0u8; PLONK_PROOF_LEN as usize];
    let g1s = [a_c, b_c, c_c, z_c, t_lo_c, t_mid_c, t_hi_c, w_zeta_c, w_zeta_omega_c];
    for (i, p) in g1s.iter().enumerate() {
        buf[i * G1_LEN..(i + 1) * G1_LEN].copy_from_slice(&p.to_compressed());
    }
    let scalars = [a_bar, b_bar, c_bar, s1_bar, s2_bar, zw_bar];
    let base = 9 * G1_LEN;
    for (i, s) in scalars.iter().enumerate() {
        buf[base + i * SCALAR_LEN..base + (i + 1) * SCALAR_LEN].copy_from_slice(&s.to_bytes());
    }

    let vk_hash_bytes: [u8; 32] = sha2::Sha256::digest(&core_vk.canonical_bytes()).into();

    let vk = PlonkVerifyingKey {
        domain_size: core_vk.domain_size,
        num_public_inputs: core_vk.num_public_inputs,
        q_m: BytesN::from_array(env, &core_vk.q_m),
        q_l: BytesN::from_array(env, &core_vk.q_l),
        q_r: BytesN::from_array(env, &core_vk.q_r),
        q_o: BytesN::from_array(env, &core_vk.q_o),
        q_c: BytesN::from_array(env, &core_vk.q_c),
        s1: BytesN::from_array(env, &core_vk.s1),
        s2: BytesN::from_array(env, &core_vk.s2),
        s3: BytesN::from_array(env, &core_vk.s3),
    };

    let mut srs_bytes = [0u8; G2_LEN];
    srs_bytes.copy_from_slice(&srs.tau_g2.to_compressed());

    ToyProofFixture {
        vk,
        vk_hash: BytesN::from_array(env, &vk_hash_bytes),
        srs_tau_g2: BytesN::from_array(env, &srs_bytes),
        public_inputs: Bytes::from_slice(env, &public_inputs_bytes),
        proof: Bytes::from_slice(env, &buf),
    }
}

use sha2::Digest as _;
