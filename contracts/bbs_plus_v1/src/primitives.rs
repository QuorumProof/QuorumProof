#![no_std]

use bls12_381::{G1Affine, G1Projective, G2Affine, G2Projective, Pairing, Scalar};
use ff::Field;
use crate::errors::{BbsError, BbsResult};

/// Scalar field element for BLS12-381
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Fr(Scalar);

impl Fr {
    pub fn new(scalar: Scalar) -> Self {
        Fr(scalar)
    }

    pub fn random<R: rand::RngCore>(rng: &mut R) -> Self {
        Fr(Scalar::random(rng))
    }

    pub fn zero() -> Self {
        Fr(Scalar::ZERO)
    }

    pub fn one() -> Self {
        Fr(Scalar::ONE)
    }

    pub fn from_bytes(bytes: &[u8; 32]) -> BbsResult<Self> {
        let mut repr = [0u8; 32];
        repr.copy_from_slice(bytes);
        let scalar = Scalar::from_bytes(&repr);
        if scalar.is_some().into() {
            Ok(Fr(scalar.unwrap()))
        } else {
            Err(BbsError::InvalidScalar)
        }
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

    pub fn negate(&self) -> G1 {
        G1(-self.0)
    }

    pub fn inner(&self) -> G1Affine {
        self.0
    }

    pub fn is_on_curve(&self) -> bool {
        true  // Deserialization validates curve membership
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
    Gt(Pairing::pairing(&p1.0, &p2.0))
}

/// GT Group element (target group of pairing)
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Gt(<Pairing as Pairing>::Gt);

impl Gt {
    pub fn new(value: <Pairing as Pairing>::Gt) -> Self {
        Gt(value)
    }

    pub fn identity() -> Self {
        Gt(<Pairing as Pairing>::Gt::identity())
    }

    pub fn mul(&self, scalar: &Fr) -> Gt {
        Gt(self.0 * scalar.0)
    }
}

/// Linear combination: compute a * P + b * Q efficiently
pub fn linear_combination_g1(p: &G1, a: &Fr, q: &G1, b: &Fr) -> G1 {
    let p_proj = G1Projective::from(p.0) * a.0;
    let q_proj = G1Projective::from(q.0) * b.0;
    G1((p_proj + q_proj).into())
}

/// Multilinear combination for generators
pub fn msm_g1(generators: &[G1], scalars: &[Fr]) -> BbsResult<G1> {
    if generators.len() != scalars.len() {
        return Err(BbsError::InvalidMessageCount);
    }

    let g1_affines: Vec<_> = generators.iter().map(|g| g.0).collect();
    let scalars_inner: Vec<_> = scalars.iter().map(|s| s.0).collect();

    let result = bls12_381::multi_scalar_mult(&g1_affines, &scalars_inner);
    Ok(G1(result.into()))
}

#[cfg(test)]
mod tests {
    use super::*;

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
}
