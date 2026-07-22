
extern crate alloc;

use alloc::vec::Vec;

use crate::errors::{BbsError, BbsResult};
use crate::primitives::{msm_g1, Fr, G1, G2};

/// Domain-separation tags for generator derivation. Distinct tags (fed
/// through RFC 9380 hash-to-curve) guarantee P1/Q1/H_i have no discoverable
/// discrete-log relationship to one another -- see `G1::hash_to_curve`.
const DST_BASE_P1: &[u8] = b"QUORUMPROOF-BBS-BASE_XMD:SHA-256_SSWU_RO_P1_";
const DST_BLINDING_Q1: &[u8] = b"QUORUMPROOF-BBS-BASE_XMD:SHA-256_SSWU_RO_Q1_";
const DST_MESSAGE_GEN: &[u8] = b"QUORUMPROOF-BBS-BASE_XMD:SHA-256_SSWU_RO_H_";

/// The library-wide base generator P1. Fixed (not per-signer, not
/// per-credential-type) so every verifier reconstructs the identical point.
pub fn base_generator() -> G1 {
    G1::hash_to_curve(b"P1", DST_BASE_P1)
}

/// BBS+ Signing Key (secret scalar). Never zero -- SK=0 would make the
/// public key the identity, which breaks unforgeability entirely.
#[derive(Clone)]
pub struct SigningKey {
    sk: Fr,
}

impl SigningKey {
    /// Generate a fresh signing key. Only available under `std`: Soroban
    /// contracts have no entropy source, so key generation -- like signing
    /// and presentation-proof generation -- is a host-side/wallet-side
    /// operation by design. On-chain code only ever calls `verify`.
    #[cfg(feature = "std")]
    pub fn generate<R: rand::RngCore>(rng: &mut R) -> Self {
        loop {
            let sk = Fr::random(rng);
            if !sk.is_zero() {
                return SigningKey { sk };
            }
        }
    }

    /// Construct from an existing scalar (e.g. loaded from secure storage).
    pub fn from_scalar(scalar: Fr) -> BbsResult<Self> {
        if scalar.is_zero() {
            return Err(BbsError::InvalidScalar);
        }
        Ok(SigningKey { sk: scalar })
    }

    /// Derive the public key: W = SK * BP2 (in G2 -- see module docs on why
    /// this must not be G1).
    pub fn public_key(&self) -> G2 {
        G2::generator().mul(&self.sk)
    }

    pub fn scalar(&self) -> &Fr {
        &self.sk
    }
}

/// BBS+ Verifying Key: the signer's public key plus the message generators
/// for this signing context (credential type / schema). Generators are
/// always derived deterministically via `derive` -- there is no constructor
/// that accepts caller-supplied raw points, because doing so would let a
/// careless caller pick generators with a known discrete-log relationship
/// to each other, which breaks signature unforgeability outright.
#[derive(Clone)]
pub struct VerifyingKey {
    /// W = SK * BP2 ∈ G2.
    pub w: G2,
    /// Blinding generator for the signer-chosen `s` scalar.
    pub q1: G1,
    /// One generator per message slot, in order.
    pub message_generators: Vec<G1>,
}

impl VerifyingKey {
    /// Derive a verifying key for a public key and a signing context.
    /// `context_id` scopes the generators to e.g. a credential type/schema
    /// id, so two schemas never accidentally share a message layout; two
    /// calls with the same (context_id, message_count) always reproduce the
    /// same generators, so any verifier can regenerate them independently
    /// from public information -- no generator transport/storage needed.
    pub fn derive(public_key: G2, context_id: &[u8], message_count: u32) -> BbsResult<Self> {
        if message_count > crate::MAX_MESSAGES_PER_CREDENTIAL {
            return Err(BbsError::InvalidMessageCount);
        }
        let q1 = G1::hash_to_curve(context_id, DST_BLINDING_Q1);
        let mut message_generators = Vec::with_capacity(message_count as usize);
        for i in 0..message_count {
            let mut msg = Vec::with_capacity(context_id.len() + 4);
            msg.extend_from_slice(context_id);
            msg.extend_from_slice(&i.to_le_bytes());
            message_generators.push(G1::hash_to_curve(&msg, DST_MESSAGE_GEN));
        }
        Ok(VerifyingKey {
            w: public_key,
            q1,
            message_generators,
        })
    }

    pub fn message_count(&self) -> u32 {
        self.message_generators.len() as u32
    }

    /// Serialize to bytes: w(96) || q1(48) || g1 || g2 || ... || g_n
    pub fn to_bytes(&self) -> Vec<u8> {
        let mut bytes = Vec::new();
        bytes.extend_from_slice(&self.w.to_bytes());
        bytes.extend_from_slice(&self.q1.to_bytes());
        for gen in &self.message_generators {
            bytes.extend_from_slice(&gen.to_bytes());
        }
        bytes
    }

    pub fn from_bytes(bytes: &[u8]) -> BbsResult<Self> {
        if bytes.len() < 96 + 48 {
            return Err(BbsError::DeserializationError);
        }
        let mut offset = 0;

        let mut w_bytes = [0u8; 96];
        w_bytes.copy_from_slice(&bytes[offset..offset + 96]);
        let w = G2::from_bytes(&w_bytes)?;
        offset += 96;

        let mut q1_bytes = [0u8; 48];
        q1_bytes.copy_from_slice(&bytes[offset..offset + 48]);
        let q1 = G1::from_bytes(&q1_bytes)?;
        offset += 48;

        let mut message_generators = Vec::new();
        while offset + 48 <= bytes.len() {
            let mut g_bytes = [0u8; 48];
            g_bytes.copy_from_slice(&bytes[offset..offset + 48]);
            message_generators.push(G1::from_bytes(&g_bytes)?);
            offset += 48;
        }

        Ok(VerifyingKey {
            w,
            q1,
            message_generators,
        })
    }
}

/// BBS+ Signature (A, e, s).
#[derive(Clone)]
pub struct Signature {
    pub a: G1,
    pub e: Fr,
    pub s: Fr,
}

impl Signature {
    pub fn to_bytes(&self) -> [u8; 112] {
        let mut bytes = [0u8; 112];
        bytes[0..48].copy_from_slice(&self.a.to_bytes());
        bytes[48..80].copy_from_slice(&self.e.to_bytes());
        bytes[80..112].copy_from_slice(&self.s.to_bytes());
        bytes
    }

    pub fn from_bytes(bytes: &[u8; 112]) -> BbsResult<Self> {
        let mut a_bytes = [0u8; 48];
        a_bytes.copy_from_slice(&bytes[0..48]);
        let a = G1::from_bytes(&a_bytes)?;

        let mut e_bytes = [0u8; 32];
        e_bytes.copy_from_slice(&bytes[48..80]);
        let e = Fr::from_bytes(&e_bytes)?;

        let mut s_bytes = [0u8; 32];
        s_bytes.copy_from_slice(&bytes[80..112]);
        let s = Fr::from_bytes(&s_bytes)?;

        Ok(Signature { a, e, s })
    }
}

/// B = P1 + Q1*s + sum(H_i * m_i). The message commitment that gets signed.
pub(crate) fn compute_b(vk: &VerifyingKey, messages: &[Fr], s: &Fr) -> BbsResult<G1> {
    if messages.len() != vk.message_generators.len() {
        return Err(BbsError::InvalidMessageCount);
    }
    let msg_term = if messages.is_empty() {
        G1::identity()
    } else {
        msm_g1(&vk.message_generators, messages)?
    };
    Ok(base_generator().add(&vk.q1.mul(s)).add(&msg_term))
}

/// BBS+ Core Scheme.
pub struct BbsSignature;

impl BbsSignature {
    /// Sign with an explicit (e, s) rather than freshly sampling them.
    /// `sign` (below) is the normal entry point; this lower-level form
    /// exists so `accumulator` can sign a *chosen* exponent (the member
    /// handle) rather than a random one, while sharing this exact,
    /// already-verified core-signing algebra instead of re-deriving it.
    pub fn sign_with_exponent(
        signing_key: &SigningKey,
        verifying_key: &VerifyingKey,
        messages: &[Fr],
        e: &Fr,
        s: &Fr,
    ) -> BbsResult<Signature> {
        let b = compute_b(verifying_key, messages, s)?;
        let denom = e.add(&signing_key.sk);
        // denom == 0 iff e == -sk, i.e. astronomically unlikely for random e
        // and impossible to arrange without knowing sk; treat it as an
        // ordinary invalid-input case the caller can retry.
        let inv = denom.invert()?;
        let a = b.mul(&inv);
        Ok(Signature {
            a,
            e: *e,
            s: *s,
        })
    }

    /// Sign a list of messages with BBS+, sampling fresh randomness for
    /// (e, s) as the scheme requires -- signing with fixed/predictable (e,s)
    /// breaks unforgeability, since an attacker who ever sees two
    /// signatures sharing e can recover algebraic relationships between
    /// them.
    #[cfg(feature = "std")]
    pub fn sign<R: rand::RngCore>(
        rng: &mut R,
        signing_key: &SigningKey,
        verifying_key: &VerifyingKey,
        messages: &[Fr],
    ) -> BbsResult<Signature> {
        if messages.len() != verifying_key.message_generators.len() {
            return Err(BbsError::InvalidMessageCount);
        }
        loop {
            let e = Fr::random(rng);
            let s = Fr::random(rng);
            match Self::sign_with_exponent(signing_key, verifying_key, messages, &e, &s) {
                Ok(sig) => return Ok(sig),
                Err(BbsError::InvalidScalar) => continue,
                Err(other) => return Err(other),
            }
        }
    }

    /// Verify a BBS+ signature: check e(A, W + e*BP2) == e(B, BP2).
    pub fn verify(
        verifying_key: &VerifyingKey,
        messages: &[Fr],
        signature: &Signature,
    ) -> BbsResult<bool> {
        if messages.len() != verifying_key.message_generators.len() {
            return Err(BbsError::InvalidMessageCount);
        }
        if signature.a.is_identity() {
            return Ok(false);
        }

        let b = compute_b(verifying_key, messages, &signature.s)?;
        let w_plus_e_bp2 = verifying_key.w.add(&G2::generator().mul(&signature.e));

        let lhs = crate::primitives::pairing(&signature.a, &w_plus_e_bp2);
        let rhs = crate::primitives::pairing(&b, &G2::generator());

        Ok(lhs == rhs)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use alloc::vec;
    use rand::rngs::StdRng;
    use rand::SeedableRng;

    fn rng() -> StdRng {
        StdRng::seed_from_u64(42)
    }

    #[test]
    fn test_signing_key_generation() {
        let sk = SigningKey::generate(&mut rng());
        let w = sk.public_key();
        assert!(!w.is_identity());
    }

    #[test]
    fn test_signature_serialization() {
        let sig = Signature {
            a: G1::generator(),
            e: Fr::one(),
            s: Fr::one(),
        };

        let bytes = sig.to_bytes();
        let sig2 = Signature::from_bytes(&bytes).unwrap();
        assert_eq!(sig.a, sig2.a);
        assert_eq!(sig.e, sig2.e);
        assert_eq!(sig.s, sig2.s);
    }

    #[test]
    fn test_verifying_key_serialization_roundtrip() {
        let sk = SigningKey::generate(&mut rng());
        let vk = VerifyingKey::derive(sk.public_key(), b"credential-type-1", 3).unwrap();
        let bytes = vk.to_bytes();
        let vk2 = VerifyingKey::from_bytes(&bytes).unwrap();
        assert_eq!(vk.w, vk2.w);
        assert_eq!(vk.q1, vk2.q1);
        assert_eq!(vk.message_generators, vk2.message_generators);
    }

    #[test]
    fn test_derive_is_deterministic() {
        let sk = SigningKey::generate(&mut rng());
        let vk1 = VerifyingKey::derive(sk.public_key(), b"credential-type-1", 3).unwrap();
        let vk2 = VerifyingKey::derive(sk.public_key(), b"credential-type-1", 3).unwrap();
        assert_eq!(vk1.q1, vk2.q1);
        assert_eq!(vk1.message_generators, vk2.message_generators);
    }

    #[test]
    fn test_derive_different_context_gives_different_generators() {
        let sk = SigningKey::generate(&mut rng());
        let vk1 = VerifyingKey::derive(sk.public_key(), b"credential-type-1", 3).unwrap();
        let vk2 = VerifyingKey::derive(sk.public_key(), b"credential-type-2", 3).unwrap();
        assert_ne!(vk1.q1, vk2.q1);
        assert_ne!(vk1.message_generators, vk2.message_generators);
    }

    #[test]
    fn test_sign_and_verify() {
        let mut r = rng();
        let sk = SigningKey::generate(&mut r);
        let vk = VerifyingKey::derive(sk.public_key(), b"ctx", 2).unwrap();

        let messages = vec![Fr::from_u64(7), Fr::from_u64(9)];
        let sig = BbsSignature::sign(&mut r, &sk, &vk, &messages).unwrap();

        let valid = BbsSignature::verify(&vk, &messages, &sig).unwrap();
        assert!(valid);
    }

    #[test]
    fn test_verify_rejects_tampered_message() {
        let mut r = rng();
        let sk = SigningKey::generate(&mut r);
        let vk = VerifyingKey::derive(sk.public_key(), b"ctx", 2).unwrap();

        let messages = vec![Fr::from_u64(7), Fr::from_u64(9)];
        let sig = BbsSignature::sign(&mut r, &sk, &vk, &messages).unwrap();

        let tampered = vec![Fr::from_u64(8), Fr::from_u64(9)];
        let valid = BbsSignature::verify(&vk, &tampered, &sig).unwrap();
        assert!(!valid);
    }

    #[test]
    fn test_verify_rejects_wrong_key() {
        let mut r = rng();
        let sk = SigningKey::generate(&mut r);
        let other_sk = SigningKey::generate(&mut r);
        let vk = VerifyingKey::derive(sk.public_key(), b"ctx", 2).unwrap();
        let other_vk = VerifyingKey::derive(other_sk.public_key(), b"ctx", 2).unwrap();

        let messages = vec![Fr::from_u64(7), Fr::from_u64(9)];
        let sig = BbsSignature::sign(&mut r, &sk, &vk, &messages).unwrap();

        let valid = BbsSignature::verify(&other_vk, &messages, &sig).unwrap();
        assert!(!valid);
    }

    #[test]
    fn test_verify_rejects_forged_identity_a() {
        // A trivial forgery attempt: identity A always fails structurally,
        // regardless of e/s -- this is the one cheap check `verify` can do
        // before the pairing.
        let mut r = rng();
        let sk = SigningKey::generate(&mut r);
        let vk = VerifyingKey::derive(sk.public_key(), b"ctx", 1).unwrap();
        let messages = vec![Fr::from_u64(1)];

        let forged = Signature {
            a: G1::identity(),
            e: Fr::one(),
            s: Fr::one(),
        };
        assert!(!BbsSignature::verify(&vk, &messages, &forged).unwrap());
    }

    #[test]
    fn test_verify_rejects_arbitrary_non_identity_forgery() {
        // The old implementation's "verify" accepted ANY non-identity A --
        // this is the regression test for that: a structurally-valid-looking
        // but algebraically-unrelated point must be rejected by the real
        // pairing check.
        let mut r = rng();
        let sk = SigningKey::generate(&mut r);
        let vk = VerifyingKey::derive(sk.public_key(), b"ctx", 1).unwrap();
        let messages = vec![Fr::from_u64(1)];

        let forged = Signature {
            a: G1::generator(),
            e: Fr::from_u64(123),
            s: Fr::from_u64(456),
        };
        assert!(!BbsSignature::verify(&vk, &messages, &forged).unwrap());
    }

    #[test]
    fn test_two_signatures_on_same_messages_are_distinct() {
        // e, s must be freshly random each time.
        let mut r = rng();
        let sk = SigningKey::generate(&mut r);
        let vk = VerifyingKey::derive(sk.public_key(), b"ctx", 1).unwrap();
        let messages = vec![Fr::from_u64(1)];

        let sig1 = BbsSignature::sign(&mut r, &sk, &vk, &messages).unwrap();
        let sig2 = BbsSignature::sign(&mut r, &sk, &vk, &messages).unwrap();
        assert_ne!(sig1.e, sig2.e);
        assert_ne!(sig1.s, sig2.s);
        assert_ne!(sig1.a, sig2.a);
    }

    #[test]
    fn test_zero_message_signature_for_accumulator_reuse() {
        // message_generators = [] is the accumulator use-case (see
        // accumulator.rs): B degenerates to P1 + Q1*s.
        let mut r = rng();
        let sk = SigningKey::generate(&mut r);
        let vk = VerifyingKey::derive(sk.public_key(), b"acc-ctx", 0).unwrap();
        let sig = BbsSignature::sign(&mut r, &sk, &vk, &[]).unwrap();
        assert!(BbsSignature::verify(&vk, &[], &sig).unwrap());
    }
}
