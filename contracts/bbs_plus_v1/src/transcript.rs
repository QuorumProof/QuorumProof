#![no_std]

extern crate alloc;

use alloc::vec::Vec;
use sha2::{Sha256, Digest};
use crate::primitives::Fr;
use crate::errors::BbsResult;

/// Fiat-Shamir transcript for generating challenges
/// Uses SHA-256 and domain separation for cryptographic security
#[derive(Clone)]
pub struct Transcript {
    domain_separator: Vec<u8>,
    hash_state: Sha256,
}

impl Transcript {
    /// Create a new transcript with domain separation
    pub fn new(domain: &[u8]) -> Self {
        let mut hasher = Sha256::new();
        hasher.update(b"QuorumProof-Transcript-v1");
        hasher.update(domain);

        Transcript {
            domain_separator: domain.to_vec(),
            hash_state: hasher,
        }
    }

    /// Append labeled data to transcript
    pub fn append(&mut self, label: &[u8], data: &[u8]) {
        // Length-encoding prevents collision attacks
        self.hash_state.update(&(label.len() as u32).to_le_bytes());
        self.hash_state.update(label);
        self.hash_state.update(&(data.len() as u32).to_le_bytes());
        self.hash_state.update(data);
    }

    /// Append a scalar to the transcript
    pub fn append_scalar(&mut self, label: &[u8], scalar: &Fr) {
        self.append(label, &scalar.to_bytes());
    }

    /// Append a 48-byte compressed G1 point
    pub fn append_g1(&mut self, label: &[u8], point_bytes: &[u8; 48]) {
        self.append(label, point_bytes);
    }

    /// Append a 96-byte compressed G2 point
    pub fn append_g2(&mut self, label: &[u8], point_bytes: &[u8; 96]) {
        self.append(label, point_bytes);
    }

    /// Squeeze a challenge as Fr scalar
    pub fn squeeze_challenge(&mut self) -> BbsResult<Fr> {
        let hash = self.hash_state.clone().finalize();
        let mut challenge_bytes = [0u8; 32];
        challenge_bytes.copy_from_slice(&hash[..32]);
        Fr::from_bytes(&challenge_bytes)
    }

    /// Squeeze multiple bytes (for arbitrary challenge generation)
    pub fn squeeze_bytes(&mut self, length: usize) -> Vec<u8> {
        let mut output = Vec::with_capacity(length);
        let mut hasher = Sha256::new();
        hasher.update(self.hash_state.finalize_reset());

        while output.len() < length {
            let hash = hasher.clone().finalize();
            let to_add = (length - output.len()).min(32);
            output.extend_from_slice(&hash[..to_add]);
            hasher.update(&hash);
        }

        output.truncate(length);
        output
    }

    /// Create independent instance for batch operations
    pub fn fork(&self) -> Transcript {
        Transcript {
            domain_separator: self.domain_separator.clone(),
            hash_state: self.hash_state.clone(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_transcript_deterministic() {
        let mut t1 = Transcript::new(b"test-domain");
        t1.append(b"label1", b"data1");
        let c1 = t1.squeeze_challenge().unwrap();

        let mut t2 = Transcript::new(b"test-domain");
        t2.append(b"label1", b"data1");
        let c2 = t2.squeeze_challenge().unwrap();

        assert_eq!(c1, c2);
    }

    #[test]
    fn test_transcript_domain_separation() {
        let mut t1 = Transcript::new(b"domain1");
        t1.append(b"label", b"data");
        let c1 = t1.squeeze_challenge().unwrap();

        let mut t2 = Transcript::new(b"domain2");
        t2.append(b"label", b"data");
        let c2 = t2.squeeze_challenge().unwrap();

        assert_ne!(c1, c2);
    }

    #[test]
    fn test_transcript_append_order_matters() {
        let mut t1 = Transcript::new(b"test");
        t1.append(b"label1", b"data1");
        t1.append(b"label2", b"data2");
        let c1 = t1.squeeze_challenge().unwrap();

        let mut t2 = Transcript::new(b"test");
        t2.append(b"label2", b"data2");
        t2.append(b"label1", b"data1");
        let c2 = t2.squeeze_challenge().unwrap();

        assert_ne!(c1, c2);
    }

    #[test]
    fn test_transcript_byte_squeezing() {
        let mut t = Transcript::new(b"test");
        t.append(b"data", b"test");
        let bytes = t.squeeze_bytes(64);
        assert_eq!(bytes.len(), 64);
    }
}
