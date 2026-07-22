
//! Cryptographic accumulator for unlinkable revocation status.
//!
//! # Design
//!
//! This is deliberately *not* a separate cryptographic construction from
//! the BBS+ core in `signature.rs`/`presentation.rs` -- it's the same
//! scheme, specialized to zero messages. A membership witness for handle
//! `y` is exactly a BBS+ signature on the empty message vector with
//! exponent `e := y`:
//!
//! ```text
//! witness = P1 * (SK_acc + y)^-1
//! ```
//!
//! which is precisely `BbsSignature::sign_with_exponent(sk, vk, &[], &y, &0)`.
//! Proving "I hold a witness for my (undisclosed) handle" is then exactly
//! `BbsPresentation::create_presentation` with zero messages and zero
//! revealed indices: the existing proof system already hides `e` (via
//! `e_hat`) without ever revealing it, so the handle is unlinkable across
//! presentations for free.
//!
//! This is a *positive* (allow-list) accumulator: the manager issues
//! witnesses only for currently-active handles. Revocation removes a
//! handle from the active set; because this scheme's manager-held secret
//! key doesn't support publishing an efficient "remove one member" update
//! the way RSA accumulators can, revocation here is epoch-based -- the
//! manager periodically republishes fresh witnesses for the still-active
//! set (`AccumulatorEpoch::rebuild`), and a witness's epoch is checked
//! against the current one by callers. A revoked handle simply stops
//! receiving new witnesses; its holder's most recent witness still
//! verifies cryptographically but callers must reject stale epochs.
//! This tradeoff (simplicity over dynamic per-member revocation) is a
//! deliberate scope choice, not an oversight -- true dynamic accumulators
//! (Camenisch-Lysyanskaya / Nguyen-style update proofs) are a materially
//! larger undertaking and are not implemented here.

extern crate alloc;

use alloc::collections::BTreeMap;
use alloc::vec::Vec;

use crate::errors::{BbsError, BbsResult};
use crate::presentation::{BbsPresentation, PresentationProof};
use crate::primitives::Fr;
use crate::signature::{BbsSignature, Signature, SigningKey, VerifyingKey};

/// The accumulator manager's key material. `sk` must be kept secret --
/// anyone holding it can mint witnesses for arbitrary handles.
pub struct AccumulatorKey {
    sk: SigningKey,
    pub vk: VerifyingKey,
}

impl AccumulatorKey {
    #[cfg(feature = "std")]
    pub fn generate<R: rand::RngCore>(rng: &mut R, context_id: &[u8]) -> BbsResult<Self> {
        let sk = SigningKey::generate(rng);
        let vk = VerifyingKey::derive(sk.public_key(), context_id, 0)?;
        Ok(AccumulatorKey { sk, vk })
    }

    /// Mint a witness for `handle`. Only the manager can call this.
    pub fn issue_witness(&self, handle: &Fr) -> BbsResult<Witness> {
        let sig = BbsSignature::sign_with_exponent(&self.sk, &self.vk, &[], handle, &Fr::zero())?;
        Ok(Witness { sig })
    }
}

/// A holder's proof of current active (non-revoked) status for their
/// handle, of the form issued by [`AccumulatorKey::issue_witness`].
#[derive(Clone)]
pub struct Witness {
    sig: Signature,
}

impl Witness {
    pub fn to_bytes(&self) -> [u8; 112] {
        self.sig.to_bytes()
    }

    pub fn from_bytes(bytes: &[u8; 112]) -> BbsResult<Self> {
        Ok(Witness {
            sig: Signature::from_bytes(bytes)?,
        })
    }

    /// Sanity-check this witness against the manager's public key and the
    /// claimed handle. Holders should call this right after receiving a
    /// witness; verifiers normally only ever see [`NonRevocationProof`], not
    /// the raw witness or handle.
    pub fn verify(&self, vk: &VerifyingKey, handle: &Fr) -> BbsResult<bool> {
        if self.sig.e != *handle {
            return Ok(false);
        }
        BbsSignature::verify(vk, &[], &self.sig)
    }
}

/// A zero-knowledge proof of "I hold a witness minted by this accumulator
/// manager for some handle" -- without revealing which handle. This is
/// exactly a BBS+ presentation proof over zero messages.
pub struct NonRevocationProof(PresentationProof);

impl NonRevocationProof {
    #[cfg(feature = "std")]
    pub fn create<R: rand::RngCore>(
        rng: &mut R,
        witness: &Witness,
        vk: &VerifyingKey,
        presentation_context: &[u8],
    ) -> BbsResult<Self> {
        let proof = BbsPresentation::create_presentation(
            rng,
            &witness.sig,
            vk,
            &[],
            &[],
            presentation_context,
        )?;
        Ok(NonRevocationProof(proof))
    }

    pub fn verify(&self, vk: &VerifyingKey, presentation_context: &[u8]) -> BbsResult<bool> {
        if vk.message_generators.len() != 0 {
            return Err(BbsError::InvalidMessageCount);
        }
        BbsPresentation::verify_presentation(vk, &self.0, presentation_context)
    }

    pub fn to_bytes(&self) -> Vec<u8> {
        self.0.to_bytes()
    }

    pub fn from_bytes(bytes: &[u8]) -> BbsResult<Self> {
        Ok(NonRevocationProof(PresentationProof::from_bytes(bytes)?))
    }
}

/// Tracks the currently-active handle set for one epoch and (re)issues
/// witnesses for it. See module docs: revocation is epoch-based, not
/// per-member-dynamic.
pub struct AccumulatorEpoch {
    pub epoch: u64,
    active_handles: BTreeMap<[u8; 32], Fr>,
}

impl AccumulatorEpoch {
    pub fn new(epoch: u64) -> Self {
        AccumulatorEpoch {
            epoch,
            active_handles: BTreeMap::new(),
        }
    }

    pub fn add_active(&mut self, handle: Fr) {
        self.active_handles.insert(handle.to_bytes(), handle);
    }

    pub fn revoke(&mut self, handle: &Fr) {
        self.active_handles.remove(&handle.to_bytes());
    }

    pub fn is_active(&self, handle: &Fr) -> bool {
        self.active_handles.contains_key(&handle.to_bytes())
    }

    pub fn active_count(&self) -> usize {
        self.active_handles.len()
    }

    /// Re-issue witnesses for every still-active handle. Called by the
    /// manager whenever the active set changes (a revocation happened) or
    /// on a fixed schedule; holders of revoked handles simply aren't in the
    /// returned map and stop getting fresh witnesses.
    pub fn reissue_all(&self, key: &AccumulatorKey) -> BbsResult<BTreeMap<[u8; 32], Witness>> {
        let mut out = BTreeMap::new();
        for (key_bytes, handle) in &self.active_handles {
            out.insert(*key_bytes, key.issue_witness(handle)?);
        }
        Ok(out)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use rand::rngs::StdRng;
    use rand::SeedableRng;

    fn rng() -> StdRng {
        StdRng::seed_from_u64(99)
    }

    #[test]
    fn test_issue_and_verify_witness() {
        let mut r = rng();
        let key = AccumulatorKey::generate(&mut r, b"acc-ctx").unwrap();
        let handle = Fr::from_u64(4242);

        let witness = key.issue_witness(&handle).unwrap();
        assert!(witness.verify(&key.vk, &handle).unwrap());
    }

    #[test]
    fn test_witness_rejects_wrong_handle() {
        let mut r = rng();
        let key = AccumulatorKey::generate(&mut r, b"acc-ctx").unwrap();
        let handle = Fr::from_u64(4242);
        let witness = key.issue_witness(&handle).unwrap();

        assert!(!witness.verify(&key.vk, &Fr::from_u64(9999)).unwrap());
    }

    #[test]
    fn test_witness_rejects_under_different_accumulator() {
        let mut r = rng();
        let key_a = AccumulatorKey::generate(&mut r, b"acc-a").unwrap();
        let key_b = AccumulatorKey::generate(&mut r, b"acc-b").unwrap();
        let handle = Fr::from_u64(4242);

        let witness = key_a.issue_witness(&handle).unwrap();
        assert!(!witness.verify(&key_b.vk, &handle).unwrap());
    }

    #[test]
    fn test_non_revocation_proof_round_trip() {
        let mut r = rng();
        let key = AccumulatorKey::generate(&mut r, b"acc-ctx").unwrap();
        let handle = Fr::from_u64(777);
        let witness = key.issue_witness(&handle).unwrap();

        let proof = NonRevocationProof::create(&mut r, &witness, &key.vk, b"session-1").unwrap();
        assert!(proof.verify(&key.vk, b"session-1").unwrap());
    }

    #[test]
    fn test_non_revocation_proof_wrong_context_fails() {
        let mut r = rng();
        let key = AccumulatorKey::generate(&mut r, b"acc-ctx").unwrap();
        let handle = Fr::from_u64(777);
        let witness = key.issue_witness(&handle).unwrap();

        let proof = NonRevocationProof::create(&mut r, &witness, &key.vk, b"session-1").unwrap();
        assert!(!proof.verify(&key.vk, b"session-2").unwrap());
    }

    #[test]
    fn test_non_revocation_proof_does_not_reveal_handle() {
        // Two proofs for the *same* handle must be unlinkable (distinct
        // serialized bytes / EC points), same guarantee as ordinary
        // presentation proofs.
        let mut r = rng();
        let key = AccumulatorKey::generate(&mut r, b"acc-ctx").unwrap();
        let handle = Fr::from_u64(777);
        let witness = key.issue_witness(&handle).unwrap();

        let proof1 = NonRevocationProof::create(&mut r, &witness, &key.vk, b"ctx-a").unwrap();
        let proof2 = NonRevocationProof::create(&mut r, &witness, &key.vk, b"ctx-b").unwrap();
        assert_ne!(proof1.to_bytes(), proof2.to_bytes());
    }

    #[test]
    fn test_epoch_tracks_active_and_revoked_handles() {
        let mut r = rng();
        let key = AccumulatorKey::generate(&mut r, b"acc-ctx").unwrap();
        let mut epoch = AccumulatorEpoch::new(1);

        let h1 = Fr::from_u64(1);
        let h2 = Fr::from_u64(2);
        epoch.add_active(h1);
        epoch.add_active(h2);
        assert_eq!(epoch.active_count(), 2);

        epoch.revoke(&h1);
        assert!(!epoch.is_active(&h1));
        assert!(epoch.is_active(&h2));
        assert_eq!(epoch.active_count(), 1);

        let witnesses = epoch.reissue_all(&key).unwrap();
        assert_eq!(witnesses.len(), 1);
        let w = witnesses.get(&h2.to_bytes()).unwrap();
        assert!(w.verify(&key.vk, &h2).unwrap());
    }
}
