extern crate alloc;

use bls12_381::hash_to_curve::{ExpandMsgXmd, HashToCurve};
use bls12_381::{Bls12, G1Affine, G1Projective, G2Affine, G2Projective, Scalar};
use ff::Field;
use pairing::Engine;

use crate::errors::{BbsError, BbsResult};

/// Scalar field element for BLS12-381
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Fr(Scalar);

impl Fr {
    pub fn new(scalar: Scalar) -> Self {
        Fr(scalar)
    }

    #[cfg(feature = "std")]
    pub fn random<R: rand::RngCore>(rng: &mut R) -> Self {
        Fr(Scalar::random(rng))
    }

    pub fn zero() -> Self {
        Fr(Scalar::ZERO)
    }

    pub fn one() -> Self {
        Fr(Scalar::ONE)
    }

    pub fn from_u64(v: u64) -> Self {
        Fr(Scalar::from(v))
    }

    pub fn from_bytes(bytes: &[u8; 32]) -> BbsResult<Self> {
        let scalar = Scalar::from_bytes(bytes);
        if scalar.is_some().into() {
            Ok(Fr(scalar.unwrap()))
        } else {
            Err(BbsError::InvalidScalar)
        }
    }

    /// Reduce a wide (64-byte) hash output into a scalar via full modular
    /// reduction. Unlike `from_bytes` (which rejects any 256-bit value at or
    /// above the ~255-bit field modulus -- roughly a coin-flip's worth of the
    /// input space), this never fails, which is what a Fiat-Shamir challenge
    /// derivation needs: rejecting and re-hashing on failure is a correctness
    /// hazard (easy to get the retry loop's domain separation wrong) that a
    /// wide reduction avoids entirely.
    pub fn from_bytes_wide(bytes: &[u8; 64]) -> Self {
        Fr(Scalar::from_bytes_wide(bytes))
    }

    pub fn to_bytes(&self) -> [u8; 32] {
        self.0.to_bytes()
    }

    pub fn add(&self, other: &Fr) -> Fr {
        Fr(self.0 + other.0)
    }

    pub fn sub(&self, other: &Fr) -> Fr {
        Fr(self.0 - other.0)
    }

    pub fn mul(&self, other: &Fr) -> Fr {
        Fr(self.0 * other.0)
    }

    pub fn square(&self) -> Fr {
        Fr(self.0.square())
    }

    pub fn invert(&self) -> BbsResult<Fr> {
        let inv = self.0.invert();
        if inv.is_some().into() {
            Ok(Fr(inv.unwrap()))
        } else {
            Err(BbsError::InvalidScalar)
        }
    }

    pub fn pow(&self, exp: u64) -> Fr {
        let mut result = Scalar::ONE;
        for i in (0..64).rev() {
            result = result.square();
            if ((exp >> i) & 1) == 1 {
                result *= self.0;
            }
        }
        Fr(result)
    }

    pub fn negate(&self) -> Fr {
        Fr(-self.0)
    }

    pub fn is_zero(&self) -> bool {
        bool::from(self.0.is_zero())
    }

    pub fn inner(&self) -> Scalar {
        self.0
    }
}

/// G1 Group element (affine coordinates)
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct G1(G1Affine);

impl G1 {
    pub fn new(point: G1Affine) -> Self {
        G1(point)
    }

    pub fn identity() -> Self {
        G1(G1Affine::identity())
    }

    pub fn generator() -> Self {
        G1(G1Affine::generator())
    }

    /// Derive a "nothing-up-my-sleeve" generator via RFC 9380 hash-to-curve
    /// (`draft-irtf-cfrg-hash-to-curve`, the same construction the IETF BBS
    /// signature draft uses for its own generators). `dst` is the domain
    /// separation tag; distinct (msg, dst) pairs give points with no known
    /// discrete-log relationship to one another or to the standard generator
    /// -- unlike e.g. multiplying a fixed generator by a hash-derived
    /// scalar, which *does* leak a known relationship between the results
    /// and would let a holder of the discrete logs forge cross-generator
    /// relations. BBS+ soundness depends on this.
    pub fn hash_to_curve(msg: &[u8], dst: &[u8]) -> G1 {
        let p = <G1Projective as HashToCurve<ExpandMsgXmd<sha2_hash_to_curve::Sha256>>>::hash_to_curve(
            msg, dst,
        );
        G1(p.into())
    }

    pub fn from_bytes(bytes: &[u8; 48]) -> BbsResult<Self> {
        let point = G1Affine::from_compressed(bytes);
        if point.is_some().into() {
            Ok(G1(point.unwrap()))
        } else {
            Err(BbsError::InvalidG1Point)
        }
    }

    pub fn to_bytes(&self) -> [u8; 48] {
        self.0.to_compressed()
    }

    pub fn is_identity(&self) -> bool {
        self.0.is_identity().into()
    }

    pub fn mul(&self, scalar: &Fr) -> G1 {
        G1((self.0 * scalar.0).into())
    }

    pub fn add(&self, other: &G1) -> G1 {
        G1((G1Projective::from(self.0) + G1Projective::from(other.0)).into())
    }

    pub fn sub(&self, other: &G1) -> G1 {
        G1((G1Projective::from(self.0) - G1Projective::from(other.0)).into())
    }

    pub fn negate(&self) -> G1 {
        G1(-self.0)
    }

    pub fn inner(&self) -> G1Affine {
        self.0
    }
}

/// G2 Group element (affine coordinates)
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct G2(G2Affine);

impl G2 {
    pub fn new(point: G2Affine) -> Self {
        G2(point)
    }

    pub fn identity() -> Self {
        G2(G2Affine::identity())
    }

    pub fn generator() -> Self {
        G2(G2Affine::generator())
    }

    pub fn from_bytes(bytes: &[u8; 96]) -> BbsResult<Self> {
        let point = G2Affine::from_compressed(bytes);
        if point.is_some().into() {
            Ok(G2(point.unwrap()))
        } else {
            Err(BbsError::InvalidG2Point)
        }
    }

    pub fn to_bytes(&self) -> [u8; 96] {
        self.0.to_compressed()
    }

    pub fn is_identity(&self) -> bool {
        self.0.is_identity().into()
    }

    pub fn mul(&self, scalar: &Fr) -> G2 {
        G2((self.0 * scalar.0).into())
    }

    pub fn add(&self, other: &G2) -> G2 {
        G2((G2Projective::from(self.0) + G2Projective::from(other.0)).into())
    }

    pub fn negate(&self) -> G2 {
        G2(-self.0)
    }

    pub fn inner(&self) -> G2Affine {
        self.0
    }
}

/// Pairing operation: e(P1, P2) for P1 ∈ G1, P2 ∈ G2
pub fn pairing(p1: &G1, p2: &G2) -> Gt {
    Gt(Bls12::pairing(&p1.0, &p2.0))
}

/// GT Group element (target group of pairing)
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Gt(bls12_381::Gt);

impl Gt {
    pub fn new(value: bls12_381::Gt) -> Self {
        Gt(value)
    }

    pub fn identity() -> Self {
        Gt(bls12_381::Gt::identity())
    }
}

/// Linear combination: compute a * P + b * Q
pub fn linear_combination_g1(p: &G1, a: &Fr, q: &G1, b: &Fr) -> G1 {
    let p_proj = G1Projective::from(p.0) * a.0;
    let q_proj = G1Projective::from(q.0) * b.0;
    G1((p_proj + q_proj).into())
}

/// Multi-scalar multiplication: sum_i(scalars[i] * generators[i]).
///
/// This is the textbook O(n) double-and-add loop, not a Pippenger-style
/// bucket algorithm -- correctness over speed. Message/generator counts here
/// are small (bounded by `MAX_MESSAGES_PER_CREDENTIAL`), so the constant
/// factor an optimized MSM would save isn't worth the extra surface area for
/// a scheme where a subtle bug is a soundness break, not just a slowdown.
pub fn msm_g1(generators: &[G1], scalars: &[Fr]) -> BbsResult<G1> {
    if generators.len() != scalars.len() {
        return Err(BbsError::InvalidMessageCount);
    }

    let mut acc = G1Projective::identity();
    for (g, s) in generators.iter().zip(scalars.iter()) {
        acc += G1Projective::from(g.0) * s.0;
    }
    Ok(G1(acc.into()))
}

/// Sum an arbitrary number of G1 points.
pub fn sum_g1(points: &[G1]) -> G1 {
    let mut acc = G1Projective::identity();
    for p in points {
        acc += G1Projective::from(p.0);
    }
    G1(acc.into())
}

#[cfg(test)]
mod tests {
    use super::*;
    use alloc::vec;

    #[test]
    fn test_fr_addition() {
        let a = Fr::one();
        let b = Fr::one();
        let c = a.add(&b);
        assert_eq!(c.0, Scalar::from(2u64));
    }

    #[test]
    fn test_fr_multiplication() {
        let a = Fr::new(Scalar::from(3u64));
        let b = Fr::new(Scalar::from(4u64));
        let c = a.mul(&b);
        assert_eq!(c.0, Scalar::from(12u64));
    }

    #[test]
    fn test_fr_from_bytes_wide_never_fails_and_is_deterministic() {
        let bytes = [0xFFu8; 64];
        let a = Fr::from_bytes_wide(&bytes);
        let b = Fr::from_bytes_wide(&bytes);
        assert_eq!(a, b);
    }

    #[test]
    fn test_g1_generator() {
        let gen = G1::generator();
        assert!(!gen.is_identity());
    }

    #[test]
    fn test_g1_scalar_multiplication() {
        let gen = G1::generator();
        let scalar = Fr::new(Scalar::from(2u64));
        let result = gen.mul(&scalar);
        assert!(!result.is_identity());
    }

    #[test]
    fn test_pairing_bilinearity() {
        let p = G1::generator();
        let q = G2::generator();
        let scalar = Fr::new(Scalar::from(3u64));

        let e1 = pairing(&p.mul(&scalar), &q);
        let e2 = pairing(&p, &q.mul(&scalar));

        assert_eq!(e1, e2);
    }

    #[test]
    fn test_hash_to_curve_is_deterministic_and_not_identity() {
        let g = G1::hash_to_curve(b"test-message", b"QUORUMPROOF-BBS-TEST_XMD:SHA-256_SSWU_RO_");
        let g2 = G1::hash_to_curve(b"test-message", b"QUORUMPROOF-BBS-TEST_XMD:SHA-256_SSWU_RO_");
        assert_eq!(g, g2);
        assert!(!g.is_identity());
    }

    #[test]
    fn test_hash_to_curve_distinct_dst_gives_distinct_points() {
        let g1 = G1::hash_to_curve(b"seed", b"QUORUMPROOF-BBS-TEST_XMD:SHA-256_SSWU_RO_A");
        let g2 = G1::hash_to_curve(b"seed", b"QUORUMPROOF-BBS-TEST_XMD:SHA-256_SSWU_RO_B");
        assert_ne!(g1, g2);
    }

    #[test]
    fn test_msm_g1_matches_naive_sum() {
        let g1 = G1::generator();
        let g2 = G1::hash_to_curve(b"g2", b"QUORUMPROOF-BBS-TEST_XMD:SHA-256_SSWU_RO_");
        let a = Fr::from_u64(5);
        let b = Fr::from_u64(7);

        let via_msm = msm_g1(&vec![g1, g2], &vec![a, b]).unwrap();
        let via_naive = g1.mul(&a).add(&g2.mul(&b));

        assert_eq!(via_msm, via_naive);
    }

    #[test]
    fn test_msm_g1_rejects_mismatched_lengths() {
        let g1 = G1::generator();
        let a = Fr::one();
        assert!(msm_g1(&vec![g1], &vec![a, a]).is_err());
    }
}
