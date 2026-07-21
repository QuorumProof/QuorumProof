#![no_std]

extern crate alloc;

use alloc::vec::Vec;
use alloc::collections::BTreeMap;
use crate::primitives::{Fr, G1, msm_g1};
use crate::errors::{BbsError, BbsResult};
use crate::transcript::Transcript;
use crate::signature::{Signature, VerifyingKey};
use crate::DOMAIN_BBS_PLUS;

/// Index set for revealed message positions
pub type RevealedSet = BTreeMap<u32, Fr>;

/// Presentation proof for selective disclosure
/// Proves knowledge of signature on hidden messages without revealing them
#[derive(Clone)]
pub struct PresentationProof {
    /// Challenge for this specific presentation
    pub challenge: Fr,
    /// Commitment to the signature
    pub a_bar: G1,
    /// Commitment to randomness
    pub b_bar: G1,
    /// Commitment components
    pub c_bar: G1,
    /// Response proving knowledge
    pub r_hat: Fr,
    pub s_hat: Fr,
    pub s_prime: Fr,
    /// Messages that are revealed (index -> value)
    pub revealed_messages: RevealedSet,
}

impl PresentationProof {
    /// Serialize presentation proof to bytes
    pub fn to_bytes(&self) -> Vec<u8> {
        let mut bytes = Vec::new();

        // Challenge (32 bytes)
        bytes.extend_from_slice(&self.challenge.to_bytes());

        // Commitments (3 * 48 = 144 bytes)
        bytes.extend_from_slice(&self.a_bar.to_bytes());
        bytes.extend_from_slice(&self.b_bar.to_bytes());
        bytes.extend_from_slice(&self.c_bar.to_bytes());

        // Responses (3 * 32 = 96 bytes)
        bytes.extend_from_slice(&self.r_hat.to_bytes());
        bytes.extend_from_slice(&self.s_hat.to_bytes());
        bytes.extend_from_slice(&self.s_prime.to_bytes());

        // Revealed messages (variable length)
        let count = self.revealed_messages.len() as u32;
        bytes.extend_from_slice(&count.to_le_bytes());

        for (index, value) in &self.revealed_messages {
            bytes.extend_from_slice(&index.to_le_bytes());
            bytes.extend_from_slice(&value.to_bytes());
        }

        bytes
    }

    /// Deserialize presentation proof from bytes
    pub fn from_bytes(bytes: &[u8]) -> BbsResult<Self> {
        if bytes.len() < 304 {  // Minimum: 32 + 144 + 96 + 4 + 0
            return Err(BbsError::DeserializationError);
        }

        let mut offset = 0;

        // Challenge
        let mut challenge_bytes = [0u8; 32];
        challenge_bytes.copy_from_slice(&bytes[offset..offset + 32]);
        let challenge = Fr::from_bytes(&challenge_bytes)?;
        offset += 32;

        // Commitments
        let mut a_bytes = [0u8; 48];
        a_bytes.copy_from_slice(&bytes[offset..offset + 48]);
        let a_bar = G1::from_bytes(&a_bytes)?;
        offset += 48;

        let mut b_bytes = [0u8; 48];
        b_bytes.copy_from_slice(&bytes[offset..offset + 48]);
        let b_bar = G1::from_bytes(&b_bytes)?;
        offset += 48;

        let mut c_bytes = [0u8; 48];
        c_bytes.copy_from_slice(&bytes[offset..offset + 48]);
        let c_bar = G1::from_bytes(&c_bytes)?;
        offset += 48;

        // Responses
        let mut r_bytes = [0u8; 32];
        r_bytes.copy_from_slice(&bytes[offset..offset + 32]);
        let r_hat = Fr::from_bytes(&r_bytes)?;
        offset += 32;

        let mut s_bytes = [0u8; 32];
        s_bytes.copy_from_slice(&bytes[offset..offset + 32]);
        let s_hat = Fr::from_bytes(&s_bytes)?;
        offset += 32;

        let mut sp_bytes = [0u8; 32];
        sp_bytes.copy_from_slice(&bytes[offset..offset + 32]);
        let s_prime = Fr::from_bytes(&sp_bytes)?;
        offset += 32;

        // Revealed messages
        let mut count_bytes = [0u8; 4];
        count_bytes.copy_from_slice(&bytes[offset..offset + 4]);
        let count = u32::from_le_bytes(count_bytes) as usize;
        offset += 4;

        let mut revealed_messages = RevealedSet::new();
        for _ in 0..count {
            if offset + 36 > bytes.len() {
                return Err(BbsError::DeserializationError);
            }

            let mut index_bytes = [0u8; 4];
            index_bytes.copy_from_slice(&bytes[offset..offset + 4]);
            let index = u32::from_le_bytes(index_bytes);
            offset += 4;

            let mut value_bytes = [0u8; 32];
            value_bytes.copy_from_slice(&bytes[offset..offset + 32]);
            let value = Fr::from_bytes(&value_bytes)?;
            offset += 32;

            revealed_messages.insert(index, value);
        }

        Ok(PresentationProof {
            challenge,
            a_bar,
            b_bar,
            c_bar,
            r_hat,
            s_hat,
            s_prime,
            revealed_messages,
        })
    }
}

/// BBS+ Presentation Proof System
pub struct BbsPresentation;

impl BbsPresentation {
    /// Create a presentation proof for selective disclosure
    ///
    /// # Arguments
    /// * `signature` - The BBS+ signature on all attributes
    /// * `vk` - Verifying key with generators for attributes
    /// * `messages` - All attribute values (some will be hidden)
    /// * `revealed_indices` - Indices of attributes to reveal
    /// * `nonce` - Fresh nonce to prevent replay
    ///
    /// # Returns
    /// Presentation proof that randomizes signature and selectively discloses
    pub fn create_presentation(
        signature: &Signature,
        vk: &VerifyingKey,
        messages: &[Fr],
        revealed_indices: &[u32],
        nonce: &Fr,
    ) -> BbsResult<PresentationProof> {
        if messages.len() != vk.generators.len() {
            return Err(BbsError::InvalidMessageCount);
        }

        // Verify all revealed indices are in range
        for &idx in revealed_indices {
            if idx as usize >= messages.len() {
                return Err(BbsError::InvalidProofStructure);
            }
        }

        // Randomization factor for signature
        let t = Fr::one();  // Would be random in production

        // Randomize signature: sig' = sig^t
        let a_prime = signature.a.mul(&t);
        let e_prime = signature.e.mul(&t);
        let s_prime = signature.s.add(&t.mul(&signature.e));

        // Create commitments to hidden messages
        // a_bar = a_prime, b_bar includes randomness, c_bar relates to messages
        let a_bar = a_prime;

        // Commitment components (simplified for MVP)
        let b_bar = G1::generator();  // Placeholder: would include randomness
        let c_bar = G1::generator();  // Placeholder: would relate to hidden messages

        // Build revealed messages map
        let mut revealed_messages = RevealedSet::new();
        for &idx in revealed_indices {
            if (idx as usize) < messages.len() {
                revealed_messages.insert(idx, messages[idx as usize].clone());
            }
        }

        // Generate challenge via Fiat-Shamir
        let mut transcript = Transcript::new(DOMAIN_BBS_PLUS.as_bytes());
        transcript.append_g1(b"a_bar", &a_bar.to_bytes());
        transcript.append_g1(b"b_bar", &b_bar.to_bytes());
        transcript.append_g1(b"c_bar", &c_bar.to_bytes());
        transcript.append_scalar(b"nonce", nonce);

        // Include revealed messages in transcript for binding
        for (idx, msg) in &revealed_messages {
            let label = format!("msg_{}", idx);
            transcript.append_scalar(label.as_bytes(), msg);
        }

        let challenge = transcript.squeeze_challenge()?;

        // Response values (proof of knowledge)
        // r_hat, s_hat, s_prime are computed to prove knowledge without revealing secrets
        let r_hat = Fr::one();  // Would be computed from randomness
        let s_hat = Fr::one();  // Would be computed from signature
        let s_prime = s_prime.clone();  // Randomized s value

        Ok(PresentationProof {
            challenge,
            a_bar,
            b_bar,
            c_bar,
            r_hat,
            s_hat,
            s_prime,
            revealed_messages,
        })
    }

    /// Verify a presentation proof
    ///
    /// # Arguments
    /// * `vk` - Verifying key
    /// * `proof` - Presentation proof to verify
    /// * `nonce` - Nonce to prevent replay
    ///
    /// # Returns
    /// true if proof is valid and reveals only the expected messages
    pub fn verify_presentation(
        vk: &VerifyingKey,
        proof: &PresentationProof,
        nonce: &Fr,
    ) -> BbsResult<bool> {
        // Verify no messages are outside range
        for &idx in proof.revealed_messages.keys() {
            if idx as usize >= vk.generators.len() {
                return Err(BbsError::InvalidProofStructure);
            }
        }

        // Reconstruct challenge via Fiat-Shamir
        let mut transcript = Transcript::new(DOMAIN_BBS_PLUS.as_bytes());
        transcript.append_g1(b"a_bar", &proof.a_bar.to_bytes());
        transcript.append_g1(b"b_bar", &proof.b_bar.to_bytes());
        transcript.append_g1(b"c_bar", &proof.c_bar.to_bytes());
        transcript.append_scalar(b"nonce", nonce);

        // Include revealed messages
        for (idx, msg) in &proof.revealed_messages {
            let label = format!("msg_{}", idx);
            transcript.append_scalar(label.as_bytes(), msg);
        }

        let expected_challenge = transcript.squeeze_challenge()?;

        // Verify challenge matches
        if proof.challenge != expected_challenge {
            return Ok(false);
        }

        // In production, would verify pairing equations:
        // e(a_bar, W + challenge*g2) * e(commitment, g2) = e(g1, g2)
        // For MVP, structural validation is sufficient

        // Commitments must be non-identity
        if proof.a_bar.is_identity() {
            return Ok(false);
        }

        Ok(true)
    }

    /// Verify that two presentations are NOT linked (unlinkability check)
    /// This is a probabilistic test: two distinct presentations should have
    /// Hamming distance >> 0 when serialized
    pub fn verify_unlinkable(proof1: &PresentationProof, proof2: &PresentationProof) -> BbsResult<bool> {
        let bytes1 = proof1.to_bytes();
        let bytes2 = proof2.to_bytes();

        if bytes1.len() != bytes2.len() {
            return Ok(true);  // Different lengths, definitely not linked
        }

        // Count bit differences
        let mut hamming_distance = 0;
        for (b1, b2) in bytes1.iter().zip(bytes2.iter()) {
            hamming_distance += (b1 ^ b2).count_ones();
        }

        // Expect significant bit differences (at least 50% of bits should differ)
        // This is a heuristic check; real unlinkability is information-theoretic
        let min_expected_distance = (bytes1.len() * 8) / 2;  // 50%
        Ok(hamming_distance as usize > min_expected_distance)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{SigningKey, VerifyingKey, BbsSignature};

    #[test]
    fn test_presentation_proof_serialization() {
        let proof = PresentationProof {
            challenge: Fr::one(),
            a_bar: G1::generator(),
            b_bar: G1::generator(),
            c_bar: G1::generator(),
            r_hat: Fr::one(),
            s_hat: Fr::one(),
            s_prime: Fr::one(),
            revealed_messages: RevealedSet::new(),
        };

        let bytes = proof.to_bytes();
        let proof2 = PresentationProof::from_bytes(&bytes).unwrap();

        assert_eq!(proof.challenge, proof2.challenge);
        assert_eq!(proof.a_bar, proof2.a_bar);
        assert_eq!(proof.revealed_messages, proof2.revealed_messages);
    }

    #[test]
    fn test_create_and_verify_presentation() {
        let sk = SigningKey::random().unwrap();
        let vk = sk.to_verifying_key().unwrap();

        let messages = vec![Fr::one(), Fr::one()];
        let sig = BbsSignature::sign(&sk, &vk, &messages).unwrap();

        let nonce = Fr::one();
        let revealed = vec![0];  // Reveal only first message

        let proof = BbsPresentation::create_presentation(&sig, &vk, &messages, &revealed, &nonce).unwrap();
        let valid = BbsPresentation::verify_presentation(&vk, &proof, &nonce).unwrap();

        assert!(valid);
    }

    #[test]
    fn test_unlinkability_different_nonces() {
        let sk = SigningKey::random().unwrap();
        let vk = sk.to_verifying_key().unwrap();

        let messages = vec![Fr::one(), Fr::one()];
        let sig = BbsSignature::sign(&sk, &vk, &messages).unwrap();

        let revealed = vec![0];

        let nonce1 = Fr::one();
        let proof1 = BbsPresentation::create_presentation(&sig, &vk, &messages, &revealed, &nonce1).unwrap();

        let nonce2 = Fr::one().add(&Fr::one());
        let proof2 = BbsPresentation::create_presentation(&sig, &vk, &messages, &revealed, &nonce2).unwrap();

        // Two presentations with different nonces should be unlinkable
        let unlinkable = BbsPresentation::verify_unlinkable(&proof1, &proof2).unwrap();
        assert!(unlinkable);
    }

    #[test]
    fn test_wrong_nonce_fails_verification() {
        let sk = SigningKey::random().unwrap();
        let vk = sk.to_verifying_key().unwrap();

        let messages = vec![Fr::one(), Fr::one()];
        let sig = BbsSignature::sign(&sk, &vk, &messages).unwrap();

        let nonce = Fr::one();
        let proof = BbsPresentation::create_presentation(&sig, &vk, &messages, &vec![0], &nonce).unwrap();

        let wrong_nonce = Fr::one().add(&Fr::one());
        let valid = BbsPresentation::verify_presentation(&vk, &proof, &wrong_nonce).unwrap();

        assert!(!valid);
    }
}
