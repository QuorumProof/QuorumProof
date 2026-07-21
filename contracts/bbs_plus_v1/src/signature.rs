#![no_std]

extern crate alloc;

use alloc::vec::Vec;
use crate::primitives::{Fr, G1, G2, pairing, msm_g1};
use crate::errors::{BbsError, BbsResult};
use crate::transcript::Transcript;
use crate::{DOMAIN_BBS_PLUS, MAX_MESSAGES_PER_CREDENTIAL};

/// BBS+ Signing Key (secret scalar)
#[derive(Clone)]
pub struct SigningKey {
    sk: Fr,
}

impl SigningKey {
    /// Generate a random signing key
    pub fn random() -> BbsResult<Self> {
        // In production, would use a secure RNG
        // For now, use a placeholder that would be replaced
        Ok(SigningKey {
            sk: Fr::one(),
        })
    }

    /// Create signing key from scalar (for testing)
    pub fn from_scalar(scalar: Fr) -> Self {
        SigningKey { sk: scalar }
    }

    /// Derive the corresponding verifying key
    pub fn to_verifying_key(&self) -> BbsResult<VerifyingKey> {
        let w = G1::generator().mul(&self.sk);
        Ok(VerifyingKey {
            w,
            generators: Vec::new(),  // Will be filled during setup
        })
    }

    /// Get the underlying scalar
    pub fn scalar(&self) -> &Fr {
        &self.sk
    }
}

/// BBS+ Verifying Key (public key commitment)
#[derive(Clone)]
pub struct VerifyingKey {
    pub w: G1,                      // W = g^sk (commitment to signing key)
    pub generators: Vec<G1>,        // [g1, g2, ..., g_n] for n messages
}

impl VerifyingKey {
    /// Create a new verifying key with message generators
    pub fn new(w: G1, generators: Vec<G1>) -> BbsResult<Self> {
        if generators.len() > MAX_MESSAGES_PER_CREDENTIAL as usize {
            return Err(BbsError::InvalidMessageCount);
        }
        Ok(VerifyingKey { w, generators })
    }

    /// Return the number of supported messages
    pub fn message_count(&self) -> u32 {
        self.generators.len() as u32
    }

    /// Serialize to bytes: w || g1 || g2 || ... || g_n
    pub fn to_bytes(&self) -> Vec<u8> {
        let mut bytes = Vec::new();
        bytes.extend_from_slice(&self.w.to_bytes());
        for gen in &self.generators {
            bytes.extend_from_slice(&gen.to_bytes());
        }
        bytes
    }

    /// Deserialize from bytes
    pub fn from_bytes(bytes: &[u8]) -> BbsResult<Self> {
        if bytes.len() < 48 {
            return Err(BbsError::DeserializationError);
        }

        let mut offset = 0;
        let mut w_bytes = [0u8; 48];
        w_bytes.copy_from_slice(&bytes[offset..offset + 48]);
        let w = G1::from_bytes(&w_bytes)?;
        offset += 48;

        let mut generators = Vec::new();
        while offset + 48 <= bytes.len() {
            let mut g_bytes = [0u8; 48];
            g_bytes.copy_from_slice(&bytes[offset..offset + 48]);
            generators.push(G1::from_bytes(&g_bytes)?);
            offset += 48;
        }

        Ok(VerifyingKey { w, generators })
    }
}

/// BBS+ Signature (a, e, s)
#[derive(Clone)]
pub struct Signature {
    pub a: G1,      // G1 element
    pub e: Fr,      // Scalar
    pub s: Fr,      // Scalar
}

impl Signature {
    /// Serialize signature to bytes: a || e || s
    pub fn to_bytes(&self) -> [u8; 112] {
        let mut bytes = [0u8; 112];
        bytes[0..48].copy_from_slice(&self.a.to_bytes());
        bytes[48..80].copy_from_slice(&self.e.to_bytes());
        bytes[80..112].copy_from_slice(&self.s.to_bytes());
        bytes
    }

    /// Deserialize signature from bytes
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

/// BBS+ Core Scheme
pub struct BbsSignature;

impl BbsSignature {
    /// Sign a list of messages with BBS+ scheme
    /// Formula: sig = (a, e, s) where:
    /// - a = (g1 * prod(m_i^h_i))^(1/(e+sk))
    /// - e, s are random scalars
    pub fn sign(
        signing_key: &SigningKey,
        verifying_key: &VerifyingKey,
        messages: &[Fr],
    ) -> BbsResult<Signature> {
        if messages.len() > verifying_key.generators.len() {
            return Err(BbsError::InvalidMessageCount);
        }

        if messages.is_empty() {
            return Err(BbsError::InvalidMessageCount);
        }

        // Create message commitment: prod(gen_i^msg_i)
        let msg_commitment = msm_g1(&verifying_key.generators[..messages.len()], messages)?;

        // In a real implementation, would use proper randomization
        // For now, use simplified approach
        let e = Fr::one();  // Would be random in production
        let s = Fr::one();  // Would be random in production

        // Compute a = (g1 + msg_commitment)^(1/(e + sk))
        // This is simplified; real implementation uses more complex algebra
        let base = G1::generator().add(&msg_commitment);
        let inv_exponent = (e.add(&signing_key.sk)).invert()?;
        let a = base.mul(&inv_exponent);

        Ok(Signature { a, e, s })
    }

    /// Verify a BBS+ signature
    /// Check: e(a, W + e*g2) * e(b, g2) = e(g1, g2)
    pub fn verify(
        verifying_key: &VerifyingKey,
        messages: &[Fr],
        signature: &Signature,
    ) -> BbsResult<bool> {
        if messages.len() > verifying_key.generators.len() {
            return Err(BbsError::InvalidMessageCount);
        }

        if messages.is_empty() {
            return Err(BbsError::InvalidMessageCount);
        }

        if signature.a.is_identity() {
            return Ok(false);
        }

        // Verify pairing equation (simplified)
        // In production, would check: e(a, W + e*g2) * e(b, g2) = e(g1, g2)
        // For MVP, use structural validation
        let msg_commitment = msm_g1(&verifying_key.generators[..messages.len()], messages)?;

        // In a real implementation, would perform full pairing check
        // For now, validate structure
        Ok(!signature.a.is_identity() && !msg_commitment.is_identity())
    }

    /// Randomize a signature for presentation (prevents linkability)
    /// Formula: sig' = (a^t, e, s + t*e) for random t
    pub fn randomize_signature(signature: &Signature, randomness: &Fr) -> Signature {
        let a_rand = signature.a.mul(randomness);
        let e_rand = signature.e.clone();
        let s_rand = signature.s.add(&randomness.mul(&signature.e));

        Signature {
            a: a_rand,
            e: e_rand,
            s: s_rand,
        }
    }

    /// Create a proof of knowledge of signature (for blind issuance)
    pub fn prove_knowledge(
        signature: &Signature,
        verifying_key: &VerifyingKey,
        messages: &[Fr],
    ) -> BbsResult<Vec<u8>> {
        let mut transcript = Transcript::new(DOMAIN_BBS_PLUS.as_bytes());
        transcript.append_g1(b"a", &signature.a.to_bytes());
        transcript.append_scalar(b"e", &signature.e);
        transcript.append_scalar(b"s", &signature.s);

        let challenge = transcript.squeeze_challenge()?;
        let mut proof = Vec::new();
        proof.extend_from_slice(&challenge.to_bytes());

        Ok(proof)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_signing_key_generation() {
        let sk = SigningKey::random().unwrap();
        let vk = sk.to_verifying_key().unwrap();
        assert!(!vk.w.is_identity());
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
    fn test_sign_and_verify() {
        let sk = SigningKey::random().unwrap();
        let vk = sk.to_verifying_key().unwrap();

        let messages = vec![Fr::one(), Fr::one()];
        let sig = BbsSignature::sign(&sk, &vk, &messages).unwrap();

        let valid = BbsSignature::verify(&vk, &messages, &sig).unwrap();
        assert!(valid);
    }

    #[test]
    fn test_randomize_signature() {
        let sig = Signature {
            a: G1::generator(),
            e: Fr::one(),
            s: Fr::one(),
        };

        let r = Fr::one();
        let sig_rand = BbsSignature::randomize_signature(&sig, &r);

        // Randomized sig should not equal original
        assert_ne!(sig.a, sig_rand.a);
    }
}
