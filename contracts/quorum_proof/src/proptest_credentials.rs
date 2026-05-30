/// Property-based tests for credential lifecycle (#551).
///
/// Covers:
/// - Random credential operations (issue, revoke, attest)
/// - Invariant checks (revoked credentials cannot be attested, IDs are monotonic, etc.)
/// - 100+ generated test cases via proptest
#[cfg(test)]
mod proptest_credential_lifecycle {
    use crate::{QuorumProofContract, QuorumProofContractClient};
    use proptest::prelude::*;
    use soroban_sdk::{
        testutils::Address as _, vec, Address, Bytes, Env,
    };

    // ---------------------------------------------------------------------------
    // Helpers
    // ---------------------------------------------------------------------------

    fn setup(env: &Env) -> QuorumProofContractClient<'_> {
        env.mock_all_auths_allowing_non_root_auth();
        let id = env.register_contract(None, QuorumProofContract);
        let client = QuorumProofContractClient::new(env, &id);
        let admin = Address::generate(env);
        client.initialize(&admin);
        client
    }

    /// Build a non-empty metadata hash of `len` bytes (clamped to 1..=256).
    fn metadata(env: &Env, len: usize) -> Bytes {
        let len = len.clamp(1, 256);
        let v: std::vec::Vec<u8> = (0..len).map(|i| (i % 251) as u8 + 1).collect();
        Bytes::from_slice(env, &v)
    }

    /// Issue a single credential and return its ID.
    fn issue_one(
        client: &QuorumProofContractClient<'_>,
        env: &Env,
        issuer: &Address,
        subject: &Address,
        cred_type: u32,
        meta_len: usize,
    ) -> u64 {
        client.issue_credential(
            issuer,
            subject,
            &cred_type,
            &metadata(env, meta_len),
            &None,
            &0u64,
        )
    }

    /// Create a single-attestor slice with weight=1, threshold=1.
    fn single_attestor_slice(
        client: &QuorumProofContractClient<'_>,
        env: &Env,
        creator: &Address,
        attestor: &Address,
    ) -> u64 {
        client.create_slice(
            creator,
            &vec![env, attestor.clone()],
            &vec![env, 1u32],
            &1u32,
        )
    }

    // ---------------------------------------------------------------------------
    // Invariant: issued credential IDs are positive and monotonically increasing
    // ---------------------------------------------------------------------------
    proptest! {
        #![proptest_config(ProptestConfig::with_cases(20))]

        #[test]
        fn prop_credential_ids_positive_and_monotonic(n_creds in 1usize..=10) {
            let env = Env::default();
            let client = setup(&env);
            let issuer = Address::generate(&env);
            let subject = Address::generate(&env);

            let mut prev = 0u64;
            for i in 0..n_creds {
                let id = issue_one(&client, &env, &issuer, &subject, 1, i + 1);
                prop_assert!(id > 0, "credential ID must be positive");
                prop_assert!(id > prev, "credential IDs must be monotonically increasing");
                prev = id;
            }
        }

        // ---------------------------------------------------------------------------
        // Invariant: issued credential is retrievable and matches inputs
        // ---------------------------------------------------------------------------
        #[test]
        fn prop_issued_credential_matches_inputs(
            cred_type in 1u32..=100,
            meta_len in 1usize..=50,
        ) {
            let env = Env::default();
            let client = setup(&env);
            let issuer = Address::generate(&env);
            let subject = Address::generate(&env);
            let meta = metadata(&env, meta_len);

            let id = client.issue_credential(&issuer, &subject, &cred_type, &meta, &None, &0u64);
            let cred = client.get_credential(&id);

            prop_assert_eq!(cred.id, id);
            prop_assert_eq!(cred.issuer, issuer);
            prop_assert_eq!(cred.subject, subject);
            prop_assert_eq!(cred.credential_type, cred_type);
            prop_assert_eq!(cred.metadata_hash, meta);
            prop_assert!(!cred.revoked, "newly issued credential must not be revoked");
            prop_assert!(!cred.suspended, "newly issued credential must not be suspended");
        }

        // ---------------------------------------------------------------------------
        // Invariant: revoked credential cannot be attested
        // ---------------------------------------------------------------------------
        #[test]
        fn prop_revoked_credential_cannot_be_attested(
            cred_type in 1u32..=50,
            meta_len in 1usize..=30,
        ) {
            let env = Env::default();
            let client = setup(&env);
            let issuer = Address::generate(&env);
            let subject = Address::generate(&env);
            let attestor = Address::generate(&env);

            let cred_id = issue_one(&client, &env, &issuer, &subject, cred_type, meta_len);
            let slice_id = single_attestor_slice(&client, &env, &issuer, &attestor);

            // Revoke the credential
            client.revoke_credential(&issuer, &cred_id);

            // Attempting to attest a revoked credential must panic
            let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                client.attest(&attestor, &cred_id, &slice_id, &true, &None);
            }));
            prop_assert!(result.is_err(), "attesting a revoked credential must fail");
        }

        // ---------------------------------------------------------------------------
        // Invariant: revoked credential is marked revoked in storage
        // ---------------------------------------------------------------------------
        #[test]
        fn prop_revoked_credential_is_marked_revoked(
            cred_type in 1u32..=50,
            meta_len in 1usize..=30,
        ) {
            let env = Env::default();
            let client = setup(&env);
            let issuer = Address::generate(&env);
            let subject = Address::generate(&env);

            let cred_id = issue_one(&client, &env, &issuer, &subject, cred_type, meta_len);
            client.revoke_credential(&issuer, &cred_id);

            let cred = client.get_credential(&cred_id);
            prop_assert!(cred.revoked, "revoked credential must have revoked=true");
        }

        // ---------------------------------------------------------------------------
        // Invariant: double-revocation must fail
        // ---------------------------------------------------------------------------
        #[test]
        fn prop_double_revocation_fails(
            cred_type in 1u32..=50,
            meta_len in 1usize..=30,
        ) {
            let env = Env::default();
            let client = setup(&env);
            let issuer = Address::generate(&env);
            let subject = Address::generate(&env);

            let cred_id = issue_one(&client, &env, &issuer, &subject, cred_type, meta_len);
            client.revoke_credential(&issuer, &cred_id);

            let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                client.revoke_credential(&issuer, &cred_id);
            }));
            prop_assert!(result.is_err(), "double revocation must fail");
        }

        // ---------------------------------------------------------------------------
        // Invariant: only the issuer can revoke
        // ---------------------------------------------------------------------------
        #[test]
        fn prop_only_issuer_can_revoke(
            cred_type in 1u32..=50,
            meta_len in 1usize..=30,
        ) {
            let env = Env::default();
            let client = setup(&env);
            let issuer = Address::generate(&env);
            let subject = Address::generate(&env);
            let stranger = Address::generate(&env);

            let cred_id = issue_one(&client, &env, &issuer, &subject, cred_type, meta_len);

            let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                client.revoke_credential(&stranger, &cred_id);
            }));
            prop_assert!(result.is_err(), "non-issuer revocation must fail");
        }

        // ---------------------------------------------------------------------------
        // Invariant: attestation by a member of the slice succeeds on active credential
        // ---------------------------------------------------------------------------
        #[test]
        fn prop_valid_attestation_succeeds(
            cred_type in 1u32..=50,
            meta_len in 1usize..=30,
            attest_value in any::<bool>(),
        ) {
            let env = Env::default();
            let client = setup(&env);
            let issuer = Address::generate(&env);
            let subject = Address::generate(&env);
            let attestor = Address::generate(&env);

            let cred_id = issue_one(&client, &env, &issuer, &subject, cred_type, meta_len);
            let slice_id = single_attestor_slice(&client, &env, &issuer, &attestor);

            // Should not panic
            client.attest(&attestor, &cred_id, &slice_id, &attest_value, &None);
        }

        // ---------------------------------------------------------------------------
        // Invariant: is_attested returns true after threshold is met
        // ---------------------------------------------------------------------------
        #[test]
        fn prop_is_attested_true_after_threshold_met(
            cred_type in 1u32..=50,
            meta_len in 1usize..=30,
        ) {
            let env = Env::default();
            let client = setup(&env);
            let issuer = Address::generate(&env);
            let subject = Address::generate(&env);
            let attestor = Address::generate(&env);

            let cred_id = issue_one(&client, &env, &issuer, &subject, cred_type, meta_len);
            let slice_id = single_attestor_slice(&client, &env, &issuer, &attestor);

            client.attest(&attestor, &cred_id, &slice_id, &true, &None);

            prop_assert!(
                client.is_attested(&cred_id, &slice_id),
                "is_attested must return true after threshold is met"
            );
        }

        // ---------------------------------------------------------------------------
        // Invariant: is_attested returns false before any attestation
        // ---------------------------------------------------------------------------
        #[test]
        fn prop_is_attested_false_before_attestation(
            cred_type in 1u32..=50,
            meta_len in 1usize..=30,
        ) {
            let env = Env::default();
            let client = setup(&env);
            let issuer = Address::generate(&env);
            let subject = Address::generate(&env);
            let attestor = Address::generate(&env);

            let cred_id = issue_one(&client, &env, &issuer, &subject, cred_type, meta_len);
            let slice_id = single_attestor_slice(&client, &env, &issuer, &attestor);

            prop_assert!(
                !client.is_attested(&cred_id, &slice_id),
                "is_attested must return false before any attestation"
            );
        }

        // ---------------------------------------------------------------------------
        // Invariant: credential_type=0 is always rejected
        // ---------------------------------------------------------------------------
        #[test]
        fn prop_zero_credential_type_rejected(meta_len in 1usize..=30) {
            let env = Env::default();
            let client = setup(&env);
            let issuer = Address::generate(&env);
            let subject = Address::generate(&env);

            let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                client.issue_credential(&issuer, &subject, &0u32, &metadata(&env, meta_len), &None, &0u64);
            }));
            prop_assert!(result.is_err(), "credential_type=0 must be rejected");
        }

        // ---------------------------------------------------------------------------
        // Invariant: empty metadata hash is always rejected
        // ---------------------------------------------------------------------------
        #[test]
        fn prop_empty_metadata_rejected(cred_type in 1u32..=50) {
            let env = Env::default();
            let client = setup(&env);
            let issuer = Address::generate(&env);
            let subject = Address::generate(&env);

            let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                client.issue_credential(
                    &issuer,
                    &subject,
                    &cred_type,
                    &Bytes::new(&env),
                    &None,
                    &0u64,
                );
            }));
            prop_assert!(result.is_err(), "empty metadata must be rejected");
        }

        // ---------------------------------------------------------------------------
        // Invariant: multiple credentials for the same subject are independent
        // ---------------------------------------------------------------------------
        #[test]
        fn prop_multiple_credentials_independent(n_creds in 2usize..=8) {
            let env = Env::default();
            let client = setup(&env);
            let issuer = Address::generate(&env);
            let subject = Address::generate(&env);

            let ids: std::vec::Vec<u64> = (0..n_creds)
                .map(|i| issue_one(&client, &env, &issuer, &subject, (i as u32) + 1, i + 1))
                .collect();

            // All IDs must be unique
            let unique: std::collections::HashSet<u64> = ids.iter().cloned().collect();
            prop_assert_eq!(unique.len(), n_creds, "all credential IDs must be unique");

            // Revoking one must not affect others
            client.revoke_credential(&issuer, &ids[0]);
            for &id in &ids[1..] {
                let cred = client.get_credential(&id);
                prop_assert!(!cred.revoked, "revoking one credential must not affect others");
            }
        }

        // ---------------------------------------------------------------------------
        // Invariant: non-slice-member cannot attest
        // ---------------------------------------------------------------------------
        #[test]
        fn prop_non_member_cannot_attest(
            cred_type in 1u32..=50,
            meta_len in 1usize..=30,
        ) {
            let env = Env::default();
            let client = setup(&env);
            let issuer = Address::generate(&env);
            let subject = Address::generate(&env);
            let attestor = Address::generate(&env);
            let outsider = Address::generate(&env);

            let cred_id = issue_one(&client, &env, &issuer, &subject, cred_type, meta_len);
            let slice_id = single_attestor_slice(&client, &env, &issuer, &attestor);

            let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                client.attest(&outsider, &cred_id, &slice_id, &true, &None);
            }));
            prop_assert!(result.is_err(), "non-slice-member attestation must fail");
        }

        // ---------------------------------------------------------------------------
        // Invariant: multi-attestor slice requires threshold to be met
        // ---------------------------------------------------------------------------
        #[test]
        fn prop_multi_attestor_threshold_not_met_returns_false(
            n_attestors in 2usize..=5,
        ) {
            let env = Env::default();
            let client = setup(&env);
            let issuer = Address::generate(&env);
            let subject = Address::generate(&env);

            let cred_id = issue_one(&client, &env, &issuer, &subject, 1, 4);

            let mut attestors = soroban_sdk::Vec::new(&env);
            let mut weights = soroban_sdk::Vec::new(&env);
            for _ in 0..n_attestors {
                attestors.push_back(Address::generate(&env));
                weights.push_back(1u32);
            }
            // threshold = all attestors
            let threshold = n_attestors as u32;
            let slice_id = client.create_slice(&issuer, &attestors, &weights, &threshold);

            // Only one attestor attests — threshold not met
            let first = attestors.get(0).unwrap();
            client.attest(&first, &cred_id, &slice_id, &true, &None);

            if n_attestors > 1 {
                prop_assert!(
                    !client.is_attested(&cred_id, &slice_id),
                    "is_attested must be false when threshold is not met"
                );
            }
        }

        // ---------------------------------------------------------------------------
        // Invariant: credential count increases by 1 per issuance
        // ---------------------------------------------------------------------------
        #[test]
        fn prop_credential_count_increments(n_creds in 1usize..=10) {
            let env = Env::default();
            let client = setup(&env);
            let issuer = Address::generate(&env);
            let subject = Address::generate(&env);

            let before = client.get_credential_count();
            for i in 0..n_creds {
                issue_one(&client, &env, &issuer, &subject, (i as u32) + 1, i + 1);
            }
            let after = client.get_credential_count();

            prop_assert_eq!(
                after,
                before + n_creds as u64,
                "credential count must increase by exactly n_creds"
            );
        }

        // ---------------------------------------------------------------------------
        // Invariant: suspended credential cannot be attested
        // ---------------------------------------------------------------------------
        #[test]
        fn prop_suspended_credential_cannot_be_attested(
            cred_type in 1u32..=50,
            meta_len in 1usize..=30,
        ) {
            let env = Env::default();
            let client = setup(&env);
            let issuer = Address::generate(&env);
            let subject = Address::generate(&env);
            let attestor = Address::generate(&env);

            let cred_id = issue_one(&client, &env, &issuer, &subject, cred_type, meta_len);
            let slice_id = single_attestor_slice(&client, &env, &issuer, &attestor);

            client.suspend_credential(&issuer, &cred_id);

            let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                client.attest(&attestor, &cred_id, &slice_id, &true, &None);
            }));
            prop_assert!(result.is_err(), "attesting a suspended credential must fail");
        }

        // ---------------------------------------------------------------------------
        // Invariant: resumed credential can be attested after suspension
        // ---------------------------------------------------------------------------
        #[test]
        fn prop_resumed_credential_can_be_attested(
            cred_type in 1u32..=50,
            meta_len in 1usize..=30,
        ) {
            let env = Env::default();
            let client = setup(&env);
            let issuer = Address::generate(&env);
            let subject = Address::generate(&env);
            let attestor = Address::generate(&env);

            let cred_id = issue_one(&client, &env, &issuer, &subject, cred_type, meta_len);
            let slice_id = single_attestor_slice(&client, &env, &issuer, &attestor);

            client.suspend_credential(&issuer, &cred_id);
            client.resume_credential(&issuer, &cred_id);

            // Should not panic
            client.attest(&attestor, &cred_id, &slice_id, &true, &None);
            prop_assert!(client.is_attested(&cred_id, &slice_id));
        }

        // ---------------------------------------------------------------------------
        // Invariant: slice count increments per creation
        // ---------------------------------------------------------------------------
        #[test]
        fn prop_slice_count_increments(n_slices in 1usize..=5) {
            let env = Env::default();
            let client = setup(&env);
            let creator = Address::generate(&env);
            let attestor = Address::generate(&env);

            let before = client.get_slice_count();
            for _ in 0..n_slices {
                single_attestor_slice(&client, &env, &creator, &attestor);
            }
            let after = client.get_slice_count();

            prop_assert_eq!(after, before + n_slices as u64);
        }

        // ---------------------------------------------------------------------------
        // Invariant: credential_exists returns true after issuance
        // ---------------------------------------------------------------------------
        #[test]
        fn prop_credential_exists_after_issuance(
            cred_type in 1u32..=50,
            meta_len in 1usize..=30,
        ) {
            let env = Env::default();
            let client = setup(&env);
            let issuer = Address::generate(&env);
            let subject = Address::generate(&env);

            let cred_id = issue_one(&client, &env, &issuer, &subject, cred_type, meta_len);
            prop_assert!(client.credential_exists(&cred_id));
        }

        // ---------------------------------------------------------------------------
        // Invariant: credential_exists returns false for non-existent ID
        // ---------------------------------------------------------------------------
        #[test]
        fn prop_credential_not_exists_for_unknown_id(
            fake_id in 100_000u64..=999_999,
        ) {
            let env = Env::default();
            let client = setup(&env);
            setup(&env); // fresh contract, no credentials

            prop_assert!(!client.credential_exists(&fake_id));
        }

        // ---------------------------------------------------------------------------
        // Invariant: random sequence of issue+revoke preserves per-credential state
        // ---------------------------------------------------------------------------
        #[test]
        fn prop_random_issue_revoke_sequence(
            ops in prop::collection::vec(
                (1u32..=20u32, 1usize..=20usize, any::<bool>()),
                5..=15,
            )
        ) {
            let env = Env::default();
            let client = setup(&env);
            let issuer = Address::generate(&env);
            let subject = Address::generate(&env);

            let mut issued: std::vec::Vec<(u64, bool)> = std::vec::Vec::new(); // (id, revoked)

            for (cred_type, meta_len, do_revoke) in ops {
                let id = issue_one(&client, &env, &issuer, &subject, cred_type, meta_len);
                let mut revoked = false;
                if do_revoke {
                    client.revoke_credential(&issuer, &id);
                    revoked = true;
                }
                issued.push((id, revoked));
            }

            // Verify final state of each credential
            for (id, expected_revoked) in issued {
                let cred = client.get_credential(&id);
                prop_assert_eq!(
                    cred.revoked,
                    expected_revoked,
                    "credential {} revoked state mismatch",
                    id
                );
            }
        }
    }
}
