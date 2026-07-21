#![no_std]
#![doc = include_str!("../README.md")]

pub mod errors;
pub mod primitives;
pub mod transcript;
pub mod signature;
pub mod presentation;

pub use errors::{BbsError, BbsResult};
pub use primitives::{Fr, G1, G2, Gt, pairing, linear_combination_g1, msm_g1};
pub use transcript::Transcript;
pub use signature::{SigningKey, VerifyingKey, Signature, BbsSignature};
pub use presentation::{PresentationProof, BbsPresentation};

/// Library version information
pub const VERSION: &str = "0.1.0";

/// Cryptographic domain separator for BBS+ operations
pub const DOMAIN_BBS_PLUS: &str = "QuorumProof-BBS-v1";

/// Cryptographic domain separator for accumulator operations
pub const DOMAIN_ACCUMULATOR: &str = "QuorumProof-Accumulator-v1";

/// Maximum number of attributes per credential
pub const MAX_MESSAGES_PER_CREDENTIAL: u32 = 255;

#[cfg(test)]
mod integration_tests {
    use super::*;

    #[test]
    fn test_library_initializes() {
        let mut t = Transcript::new(DOMAIN_BBS_PLUS.as_bytes());
        let scalar = Fr::one();
        t.append_scalar(b"test", &scalar);
        assert!(t.squeeze_challenge().is_ok());
    }
}
