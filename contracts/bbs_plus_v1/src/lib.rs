#![no_std]
#![doc = include_str!("../README.md")]

extern crate alloc;

pub mod errors;
pub mod primitives;
pub mod transcript;
pub mod signature;
pub mod presentation;
pub mod accumulator;
pub mod escrow;

pub use errors::{BbsError, BbsResult};
pub use primitives::{Fr, G1, G2, Gt, pairing, linear_combination_g1, msm_g1};
pub use transcript::Transcript;
pub use signature::{SigningKey, VerifyingKey, Signature, BbsSignature};
pub use presentation::{PresentationProof, BbsPresentation};
pub use accumulator::{AccumulatorKey, AccumulatorEpoch, Witness, NonRevocationProof};
pub use escrow::{KeyShare, split_secret, reconstruct_secret};

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
    use alloc::vec;
    use rand::rngs::StdRng;
    use rand::SeedableRng;

    #[test]
    fn test_library_initializes() {
        let mut t = Transcript::new(DOMAIN_BBS_PLUS.as_bytes());
        let scalar = Fr::one();
        t.append_scalar(b"test", &scalar);
        assert!(t.squeeze_challenge().is_ok());
    }

    /// End-to-end: issue a 3-attribute credential, present it revealing only
    /// one attribute, verify -- exercising the full public API surface a
    /// consuming contract/wallet would actually call, not just individual
    /// module internals.
    #[test]
    fn test_full_credential_issue_present_verify_flow() {
        let mut rng = StdRng::seed_from_u64(2024);

        let issuer_sk = SigningKey::generate(&mut rng);
        let issuer_pk = issuer_sk.public_key();
        let vk = VerifyingKey::derive(issuer_pk, b"degree-credential-v1", 3).unwrap();

        // name, degree, graduation_year -- holder wants to reveal only "degree".
        let name = Fr::from_u64(0xA11CE);
        let degree = Fr::from_u64(1); // e.g. an enum code for "BSc Computer Science"
        let year = Fr::from_u64(2024);
        let messages = vec![name, degree, year];

        let credential = BbsSignature::sign(&mut rng, &issuer_sk, &vk, &messages).unwrap();
        assert!(BbsSignature::verify(&vk, &messages, &credential).unwrap());

        let presentation = BbsPresentation::create_presentation(
            &mut rng,
            &credential,
            &vk,
            &messages,
            &[1], // reveal only "degree"
            b"verifier-session-nonce",
        )
        .unwrap();

        assert!(
            BbsPresentation::verify_presentation(&vk, &presentation, b"verifier-session-nonce")
                .unwrap()
        );
        assert_eq!(presentation.revealed_messages.get(&1), Some(&degree));
        assert!(presentation.revealed_messages.get(&0).is_none());
        assert!(presentation.revealed_messages.get(&2).is_none());

        // Wire-format round trip, as a contract storing/relaying proof bytes would.
        let bytes = presentation.to_bytes();
        let decoded = PresentationProof::from_bytes(&bytes).unwrap();
        assert!(
            BbsPresentation::verify_presentation(&vk, &decoded, b"verifier-session-nonce")
                .unwrap()
        );
    }

    #[test]
    fn test_revoked_credential_holder_gets_no_fresh_witness() {
        let mut rng = StdRng::seed_from_u64(2025);
        let acc = AccumulatorKey::generate(&mut rng, DOMAIN_ACCUMULATOR.as_bytes()).unwrap();

        let mut epoch = AccumulatorEpoch::new(1);
        let alice = Fr::from_u64(1001);
        let bob = Fr::from_u64(1002);
        epoch.add_active(alice);
        epoch.add_active(bob);

        let witnesses = epoch.reissue_all(&acc).unwrap();
        let alice_witness = witnesses.get(&alice.to_bytes()).unwrap();
        let proof =
            NonRevocationProof::create(&mut rng, alice_witness, &acc.vk, b"epoch-1-check")
                .unwrap();
        assert!(proof.verify(&acc.vk, b"epoch-1-check").unwrap());

        // Revoke Alice; next epoch's witness set no longer contains her.
        epoch.revoke(&alice);
        let witnesses_v2 = epoch.reissue_all(&acc).unwrap();
        assert!(witnesses_v2.get(&alice.to_bytes()).is_none());
        assert!(witnesses_v2.get(&bob.to_bytes()).is_some());
    }
}
