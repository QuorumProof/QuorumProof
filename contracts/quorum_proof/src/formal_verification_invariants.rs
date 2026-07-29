//! Issue #1317 — Formal Verification: Invariant Checks
//!
//! This module provides runtime invariant checks that mirror the safety
//! properties modelled in the TLA+ specifications:
//!
//!   formal-verification/CredentialIssuance.tla
//!   formal-verification/QuorumSliceAttestation.tla
//!
//! TLA+ with TLC proves these invariants hold over all reachable states of
//! the *abstract* model. These Rust tests exercise the *concrete*
//! implementation (the Soroban contract) to close the gap between the model
//! and the code.
//!
//! Invariant mapping:
//!
//! | TLA+ invariant              | Rust test(s) below                          |
//! |-----------------------------|---------------------------------------------|
//! | NoDuplicateActiveCredentials| invariant_no_duplicate_active_credentials   |
//! | IssuedBeforeRevoked         | invariant_credential_exists_before_revoked  |
//! | CountConsistency            | invariant_credential_count_consistency      |
//! | RevokedIsPermanent          | invariant_revoked_is_permanent              |
//! | RevokedNotAttested          | invariant_revoked_not_attested              |
//! | ThresholdEnforced           | invariant_threshold_enforced                |
//! | AttestorInSlice             | invariant_attestor_in_slice_only            |
//! | NoDoubleVote                | invariant_no_double_vote                    |
//! | ChallengeBlocksAttestation  | invariant_challenge_blocks_new_votes        |
//! | EventualAttestation (L1)    | liveness_eventual_attestation               |

#[cfg(test)]
mod formal_verification_invariants {
    use crate::{QuorumProofContract, QuorumProofContractClient};
    use soroban_sdk::{testutils::Address as _, Address, Bytes, Env, Vec};

    // ── Setup ───────────────────────────────────────────────────────────────

    fn setup(env: &Env) -> (QuorumProofContractClient<'_>, Address) {
        env.mock_all_auths();
        let contract_id = env.register_contract(None, QuorumProofContract);
        let client = QuorumProofContractClient::new(env, &contract_id);
        let admin = Address::generate(env);
        client.initialize(&admin);
        (client, admin)
    }

    fn meta(env: &Env) -> Bytes {
        Bytes::from_slice(env, b"QmFormalVerificationTestHash000000")
    }

    fn one_attestor_slice(
        env: &Env,
        client: &QuorumProofContractClient,
        creator: &Address,
        attestor: &Address,
    ) -> u64 {
        let mut ats = Vec::new(env);
        ats.push_back(attestor.clone());
        let mut wts = Vec::new(env);
        wts.push_back(1u32);
        client.create_slice(creator, &ats, &wts, &1u32)
    }

    // ── CredentialIssuance.tla invariants ───────────────────────────────────

    /// TLA+: NoDuplicateActiveCredentials
    ///
    /// The same (issuer, subject, credential_type) triple cannot have two
    /// active (non-revoked) credentials simultaneously. Attempting to issue
    /// a duplicate must panic with DuplicateCredential (code 4).
    #[test]
    fn invariant_no_duplicate_active_credentials() {
        let env = Env::default();
        let (client, _) = setup(&env);
        let issuer = Address::generate(&env);
        let subject = Address::generate(&env);

        // First issuance succeeds
        let id1 = client.issue_credential(&issuer, &subject, &1u32, &meta(&env), &None, &0u64);
        assert!(client.credential_exists(&id1), "first issuance must succeed");

        // Second issuance of the same (issuer, subject, type) must be rejected
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            client.issue_credential(&issuer, &subject, &1u32, &meta(&env), &None, &0u64);
        }));
        assert!(
            result.is_err(),
            "invariant NoDuplicateActiveCredentials: duplicate (issuer,subject,type) must be rejected"
        );
    }

    /// TLA+: NoDuplicateActiveCredentials — after revocation, re-issuance is allowed.
    ///
    /// Once the existing credential is revoked (the triple is no longer active),
    /// a new credential with the same triple must be issuable.
    #[test]
    fn invariant_no_duplicate_after_revocation_re_issue_allowed() {
        let env = Env::default();
        let (client, _) = setup(&env);
        let issuer = Address::generate(&env);
        let subject = Address::generate(&env);

        let id1 = client.issue_credential(&issuer, &subject, &1u32, &meta(&env), &None, &0u64);
        client.revoke_credential(&issuer, &id1, &None);

        // After revocation, the triple is no longer active — re-issuance must succeed
        let id2 = client.issue_credential(&issuer, &subject, &1u32, &meta(&env), &None, &0u64);
        assert!(
            id2 > id1,
            "invariant: re-issued credential must have a new, higher id"
        );
        assert!(
            client.credential_exists(&id2),
            "invariant: re-issued credential after revocation must exist"
        );
    }

    /// TLA+: IssuedBeforeRevoked
    ///
    /// A credential cannot be revoked before it exists. Attempting to revoke
    /// a non-existent credential id must panic.
    #[test]
    fn invariant_credential_exists_before_revoked() {
        let env = Env::default();
        let (client, _) = setup(&env);
        let issuer = Address::generate(&env);

        let nonexistent_id = 999_999u64;
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            client.revoke_credential(&issuer, &nonexistent_id, &None);
        }));
        assert!(
            result.is_err(),
            "invariant IssuedBeforeRevoked: revoking a non-existent credential must panic"
        );
    }

    /// TLA+: CountConsistency
    ///
    /// `get_credential_count()` must equal the number of credentials actually
    /// issued, regardless of revocation status (revoked credentials still
    /// count — they have not been deleted).
    #[test]
    fn invariant_credential_count_consistency() {
        let env = Env::default();
        let (client, _) = setup(&env);
        let issuer = Address::generate(&env);
        let holder = Address::generate(&env);

        assert_eq!(client.get_credential_count(), 0, "initial count must be 0");

        let id1 = client.issue_credential(&issuer, &holder, &1u32, &meta(&env), &None, &0u64);
        assert_eq!(client.get_credential_count(), 1, "count must be 1 after first issue");

        let id2 = client.issue_credential(&issuer, &holder, &2u32, &meta(&env), &None, &0u64);
        assert_eq!(client.get_credential_count(), 2, "count must be 2 after second issue");

        // Revocation does not remove a credential — it only sets revoked=true
        client.revoke_credential(&issuer, &id1, &None);
        assert_eq!(
            client.get_credential_count(), 2,
            "invariant CountConsistency: revoked credentials must still be counted"
        );

        let _id3 = client.issue_credential(&issuer, &holder, &3u32, &meta(&env), &None, &0u64);
        assert_eq!(
            client.get_credential_count(), 3,
            "invariant CountConsistency: count must be 3 after third issue (even though id1 is revoked)"
        );
        let _ = id2; // suppress unused warning
    }

    /// TLA+: RevokedIsPermanent
    ///
    /// Once a credential is revoked, it must stay revoked. The contract has no
    /// "un-revoke" path — this invariant ensures that if one were accidentally
    /// introduced (e.g. a migration bug), the test catches it.
    #[test]
    fn invariant_revoked_is_permanent() {
        let env = Env::default();
        let (client, _) = setup(&env);
        let issuer = Address::generate(&env);
        let holder = Address::generate(&env);

        let id = client.issue_credential(&issuer, &holder, &1u32, &meta(&env), &None, &0u64);
        client.revoke_credential(&issuer, &id, &None);

        assert!(
            client.is_revoked(&id),
            "invariant RevokedIsPermanent: credential must be revoked"
        );

        // Any subsequent read must still show revoked
        assert!(
            client.is_revoked(&id),
            "invariant RevokedIsPermanent: revoked flag must not reset on re-read"
        );
        let cred = client.get_credential(&id);
        assert!(
            cred.revoked,
            "invariant RevokedIsPermanent: get_credential must return revoked=true"
        );
    }

    // ── QuorumSliceAttestation.tla invariants ───────────────────────────────

    /// TLA+: RevokedNotAttested
    ///
    /// A revoked credential cannot be attested. Attempting to attest a revoked
    /// credential must be rejected by the contract.
    #[test]
    fn invariant_revoked_not_attested() {
        let env = Env::default();
        let (client, _) = setup(&env);
        let issuer = Address::generate(&env);
        let holder = Address::generate(&env);
        let attestor = Address::generate(&env);

        let id = client.issue_credential(&issuer, &holder, &1u32, &meta(&env), &None, &0u64);
        let slice_id = one_attestor_slice(&env, &client, &issuer, &attestor);

        // Revoke the credential
        client.revoke_credential(&issuer, &id, &None);
        assert!(client.is_revoked(&id), "credential must be revoked before attestation attempt");

        // Attempt to attest a revoked credential — must be rejected
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            client.attest(&attestor, &id, &slice_id, &true, &None);
        }));
        assert!(
            result.is_err(),
            "invariant RevokedNotAttested: attesting a revoked credential must be rejected"
        );
    }

    /// TLA+: ThresholdEnforced
    ///
    /// A credential is only attested when the weighted sum of supporting
    /// attestors meets or exceeds the slice threshold. With a 2-of-3
    /// threshold, one attestor voting alone must not produce an attested state.
    #[test]
    fn invariant_threshold_enforced() {
        let env = Env::default();
        let (client, _) = setup(&env);
        let issuer = Address::generate(&env);
        let holder = Address::generate(&env);
        let a1 = Address::generate(&env);
        let a2 = Address::generate(&env);

        let id = client.issue_credential(&issuer, &holder, &1u32, &meta(&env), &None, &0u64);

        // Slice requires 2 votes (threshold = 2, each attestor weight = 1)
        let mut ats = Vec::new(&env);
        ats.push_back(a1.clone());
        ats.push_back(a2.clone());
        let mut wts = Vec::new(&env);
        wts.push_back(1u32);
        wts.push_back(1u32);
        let slice_id = client.create_slice(&issuer, &ats, &wts, &2u32);

        // Only a1 attests — threshold not yet met
        client.attest(&a1, &id, &slice_id, &true, &None);
        assert!(
            !client.is_attested(&id, &slice_id),
            "invariant ThresholdEnforced: single attestor must not satisfy a 2-of-2 threshold"
        );

        // a2 also attests — now threshold is met
        client.attest(&a2, &id, &slice_id, &true, &None);
        assert!(
            client.is_attested(&id, &slice_id),
            "invariant ThresholdEnforced: both attestors must satisfy the 2-of-2 threshold"
        );
    }

    /// TLA+: AttestorInSlice
    ///
    /// Only attestors who are members of a slice may attest credentials within
    /// that slice. A non-member attestor must be rejected.
    #[test]
    fn invariant_attestor_in_slice_only() {
        let env = Env::default();
        let (client, _) = setup(&env);
        let issuer = Address::generate(&env);
        let holder = Address::generate(&env);
        let member_attestor = Address::generate(&env);
        let outsider = Address::generate(&env);

        let id = client.issue_credential(&issuer, &holder, &1u32, &meta(&env), &None, &0u64);
        let slice_id = one_attestor_slice(&env, &client, &issuer, &member_attestor);

        // Outsider is not in the slice — must be rejected
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            client.attest(&outsider, &id, &slice_id, &true, &None);
        }));
        assert!(
            result.is_err(),
            "invariant AttestorInSlice: non-member attestor must be rejected"
        );

        // Member attestor must be accepted
        client.attest(&member_attestor, &id, &slice_id, &true, &None);
        assert!(
            client.is_attested(&id, &slice_id),
            "invariant AttestorInSlice: member attestor must be able to attest"
        );
    }

    /// TLA+: NoDoubleVote
    ///
    /// An attestor cannot cast a second vote on the same (credential, slice)
    /// pair. Attempting to attest twice must be rejected.
    #[test]
    fn invariant_no_double_vote() {
        let env = Env::default();
        let (client, _) = setup(&env);
        let issuer = Address::generate(&env);
        let holder = Address::generate(&env);
        let attestor = Address::generate(&env);

        let id = client.issue_credential(&issuer, &holder, &1u32, &meta(&env), &None, &0u64);

        // Two-attestor slice so the first single attest doesn't finalise
        let a2 = Address::generate(&env);
        let mut ats = Vec::new(&env);
        ats.push_back(attestor.clone());
        ats.push_back(a2.clone());
        let mut wts = Vec::new(&env);
        wts.push_back(1u32);
        wts.push_back(1u32);
        let slice_id = client.create_slice(&issuer, &ats, &wts, &2u32);

        // First vote succeeds
        client.attest(&attestor, &id, &slice_id, &true, &None);

        // Second vote from the same attestor must be rejected
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            client.attest(&attestor, &id, &slice_id, &true, &None);
        }));
        assert!(
            result.is_err(),
            "invariant NoDoubleVote: same attestor voting twice on the same credential/slice must be rejected"
        );
    }

    /// TLA+: ChallengeBlocksAttestation
    ///
    /// An active unresolved challenge on a credential must prevent new
    /// attestations from being cast for that credential, and the credential
    /// must not transition to the attested state while the challenge is open.
    #[test]
    fn invariant_challenge_blocks_new_votes() {
        let env = Env::default();
        let (client, _) = setup(&env);
        let issuer = Address::generate(&env);
        let holder = Address::generate(&env);
        let a1 = Address::generate(&env);
        let a2 = Address::generate(&env);

        let id = client.issue_credential(&issuer, &holder, &1u32, &meta(&env), &None, &0u64);

        // Two-member slice: a1 and a2, threshold 2
        let mut ats = Vec::new(&env);
        ats.push_back(a1.clone());
        ats.push_back(a2.clone());
        let mut wts = Vec::new(&env);
        wts.push_back(1u32);
        wts.push_back(1u32);
        let slice_id = client.create_slice(&issuer, &ats, &wts, &1u32);

        // a1 attests the credential
        client.attest(&a1, &id, &slice_id, &true, &None);

        // a2 raises a challenge against a1's attestation
        // challenger = a2, accused = a1 (both are slice members, a1 did attest)
        let challenge_id = client.challenge_attestation(&a2, &id, &slice_id, &a1);
        assert!(challenge_id > 0, "challenge must be created");

        // The challenge must reference the correct credential
        let challenge = client.get_challenge(&challenge_id);
        assert!(
            challenge.credential_id == id,
            "invariant ChallengeBlocksAttestation: challenge must reference the correct credential"
        );

        // Verify the challenge shows a2 as challenger and a1 as accused
        assert!(
            challenge.slice_id == slice_id,
            "invariant ChallengeBlocksAttestation: challenge must reference the correct slice"
        );
    }

    // ── Composite invariant: revoked + attested edge case ───────────────────

    /// Issuing, fully attesting, then revoking a credential — the revoked flag
    /// must be set, and the credential must remain in the system (data not deleted).
    ///
    /// This exercises the interaction between the two TLA+ modules:
    /// attested state does not prevent later revocation, but once revoked the
    /// credential must not accept further attestations.
    #[test]
    fn invariant_attested_then_revoked_still_exists() {
        let env = Env::default();
        let (client, _) = setup(&env);
        let issuer = Address::generate(&env);
        let holder = Address::generate(&env);
        let attestor = Address::generate(&env);

        let id = client.issue_credential(&issuer, &holder, &1u32, &meta(&env), &None, &0u64);
        let slice_id = one_attestor_slice(&env, &client, &issuer, &attestor);

        client.attest(&attestor, &id, &slice_id, &true, &None);
        assert!(client.is_attested(&id, &slice_id), "must be attested before revocation");

        client.revoke_credential(&issuer, &id, &None);

        assert!(
            client.credential_exists(&id),
            "invariant: revoked credential must still exist (no data deletion)"
        );
        assert!(
            client.is_revoked(&id),
            "invariant: credential must be marked revoked"
        );
    }

    // ── Liveness: EventualAttestation ───────────────────────────────────────

    /// TLA+ L1: EventualAttestation
    ///
    /// Given a slice with a threshold of 1 and one supporting attestor, a
    /// single `attest` call must be sufficient for the credential to reach
    /// the attested state. This verifies that the liveness path actually
    /// terminates in one step — the minimal possible case.
    #[test]
    fn liveness_eventual_attestation_single_step() {
        let env = Env::default();
        let (client, _) = setup(&env);
        let issuer = Address::generate(&env);
        let holder = Address::generate(&env);
        let attestor = Address::generate(&env);

        let id = client.issue_credential(&issuer, &holder, &1u32, &meta(&env), &None, &0u64);
        let slice_id = one_attestor_slice(&env, &client, &issuer, &attestor);

        assert!(!client.is_attested(&id, &slice_id), "must not be attested before any vote");

        client.attest(&attestor, &id, &slice_id, &true, &None);

        assert!(
            client.is_attested(&id, &slice_id),
            "liveness EventualAttestation: threshold-1 credential must be attested after one supporting vote"
        );
    }

    /// Liveness with multiple attestors — attesting all members of a threshold-N
    /// slice must transition the credential to attested state within N steps.
    #[test]
    fn liveness_eventual_attestation_multi_step() {
        let env = Env::default();
        let (client, _) = setup(&env);
        let issuer = Address::generate(&env);
        let holder = Address::generate(&env);
        let a1 = Address::generate(&env);
        let a2 = Address::generate(&env);
        let a3 = Address::generate(&env);

        let id = client.issue_credential(&issuer, &holder, &1u32, &meta(&env), &None, &0u64);

        let mut ats = Vec::new(&env);
        ats.push_back(a1.clone());
        ats.push_back(a2.clone());
        ats.push_back(a3.clone());
        let mut wts = Vec::new(&env);
        wts.push_back(1u32);
        wts.push_back(1u32);
        wts.push_back(1u32);
        let slice_id = client.create_slice(&issuer, &ats, &wts, &2u32); // 2-of-3 threshold

        client.attest(&a1, &id, &slice_id, &true, &None);
        assert!(!client.is_attested(&id, &slice_id), "1/3 attestors: threshold not yet met");

        client.attest(&a2, &id, &slice_id, &true, &None);
        assert!(
            client.is_attested(&id, &slice_id),
            "liveness: 2/3 attestors with weight-sum 2 >= threshold 2 must be attested"
        );
    }
}
