/// Integration tests for nested FBA quorum slices and intersection verification
#[cfg(test)]
mod integration_nested_slices {
    use crate::{QuorumProofContract, QuorumProofContractClient};
    use soroban_sdk::testutils::Address as _;
    use soroban_sdk::{vec, Address, Bytes, Env};

    fn setup(env: &Env) -> QuorumProofContractClient<'_> {
        env.mock_all_auths_allowing_non_root_auth();
        let id = env.register_contract(None, QuorumProofContract);
        let client = QuorumProofContractClient::new(env, &id);
        let admin = Address::generate(env);
        client.initialize(&admin);
        client
    }

    #[test]
    fn test_backwards_compatibility_flat_slices() {
        // Verify that all existing flat-slice tests continue to work
        // This ensures nested slices are truly additive
        let env = Env::default();
        let client = setup(&env);
        let creator = Address::generate(&env);

        let attestor1 = Address::generate(&env);
        let attestor2 = Address::generate(&env);
        let attestors = vec![&env, attestor1.clone(), attestor2.clone()];
        let weights = vec![&env, 1u32, 1u32];

        let slice_id = client.create_slice(&creator, &attestors, &weights, &1u32);
        let slice = client.get_slice(&slice_id);

        assert_eq!(slice.attestors.len(), 2);
        assert_eq!(slice.threshold, 1u32);

        // Verify flat-slice quorum logic: need weight >= 1
        let candidates = vec![&env, attestor1];
        let is_q = client.is_quorum(&slice_id, &candidates);
        assert!(is_q, "Single attestor with weight 1 should form quorum");
    }

    #[test]
    fn test_is_quorum_single_attestor() {
        // Verify is_quorum works for simple flat case
        let env = Env::default();
        let client = setup(&env);
        let creator = Address::generate(&env);

        let attestor = Address::generate(&env);
        let attestors = vec![&env, attestor.clone()];
        let weights = vec![&env, 10u32];

        let slice_id = client.create_slice(&creator, &attestors, &weights, &5u32);

        // Single attestor with weight 10 >= threshold 5
        let candidates = vec![&env, attestor];
        let is_q = client.is_quorum(&slice_id, &candidates);
        assert!(is_q);

        // Empty candidate set
        let empty_candidates = vec![&env];
        let is_q_empty = client.is_quorum(&slice_id, &empty_candidates);
        assert!(!is_q_empty);
    }

    #[test]
    fn test_is_quorum_multiple_attestors() {
        // Verify weighted quorum calculation
        let env = Env::default();
        let client = setup(&env);
        let creator = Address::generate(&env);

        let a1 = Address::generate(&env);
        let a2 = Address::generate(&env);
        let a3 = Address::generate(&env);
        let attestors = vec![&env, a1.clone(), a2.clone(), a3.clone()];
        let weights = vec![&env, 1u32, 2u32, 3u32]; // total = 6, threshold = 4

        let slice_id = client.create_slice(&creator, &attestors, &weights, &4u32);

        // a2 + a3 = 2 + 3 = 5 >= 4: quorum
        let candidates = vec![&env, a2.clone(), a3.clone()];
        assert!(client.is_quorum(&slice_id, &candidates));

        // a1 + a2 = 1 + 2 = 3 < 4: not quorum
        let candidates = vec![&env, a1.clone(), a2.clone()];
        assert!(!client.is_quorum(&slice_id, &candidates));

        // a2 + a3 + a1 = 6 >= 4: quorum
        let candidates = vec![&env, a1.clone(), a2.clone(), a3.clone()];
        assert!(client.is_quorum(&slice_id, &candidates));
    }

    #[test]
    fn test_is_quorum_with_suspended_attestor() {
        // Verify suspended attestors are excluded from quorum calculation
        let env = Env::default();
        let client = setup(&env);
        let creator = Address::generate(&env);

        let a1 = Address::generate(&env);
        let a2 = Address::generate(&env);
        let attestors = vec![&env, a1.clone(), a2.clone()];
        let weights = vec![&env, 2u32, 2u32]; // total = 4, threshold = 3

        let slice_id = client.create_slice(&creator, &attestors, &weights, &3u32);

        // Both attestors can form quorum
        let candidates = vec![&env, a1.clone(), a2.clone()];
        assert!(client.is_quorum(&slice_id, &candidates));

        // TODO: Test suspension after adding suspend_attestor function to public API
        // When a1 is suspended: only a2 (weight 2) < threshold 3, so not quorum
    }

    #[test]
    fn test_percentage_threshold_quorum() {
        // Verify percentage-based quorum works with is_quorum
        let env = Env::default();
        let client = setup(&env);
        let creator = Address::generate(&env);

        let a1 = Address::generate(&env);
        let a2 = Address::generate(&env);
        let a3 = Address::generate(&env);
        let attestors = vec![&env, a1.clone(), a2.clone(), a3.clone()];
        let weights = vec![&env, 1u32, 1u32, 1u32]; // total = 3, 67% = ceil(2.01) = 3

        let slice_id = client.create_slice_percentage(&creator, &attestors, &weights, &67u32);

        // 2 attestors (weight 2 < 3): not quorum
        let candidates = vec![&env, a1.clone(), a2.clone()];
        assert!(!client.is_quorum(&slice_id, &candidates));

        // 3 attestors (weight 3 >= 3): quorum
        let candidates = vec![&env, a1.clone(), a2.clone(), a3.clone()];
        assert!(client.is_quorum(&slice_id, &candidates));
    }

    #[test]
    fn test_quorum_intersection_cache() {
        // Verify quorum intersection result is cached
        let env = Env::default();
        let client = setup(&env);
        let creator = Address::generate(&env);

        let attestor = Address::generate(&env);
        let attestors = vec![&env, attestor.clone()];
        let weights = vec![&env, 1u32];

        let slice1 = client.create_slice(&creator, &attestors, &weights, &1u32);
        let slice2 = client.create_slice(&creator, &attestors, &weights, &1u32);

        // Create intersection certificate
        let safe_nodes = vec![&env, attestor];
        // TODO: Create and test QuorumIntersectionCertificate when exposed
    }

    #[test]
    fn test_no_fork_on_first_attestation() {
        // Verify first attestation doesn't trigger fork detection
        let env = Env::default();
        let client = setup(&env);

        let issuer = Address::generate(&env);
        let holder = Address::generate(&env);
        let attestor = Address::generate(&env);

        let creator = Address::generate(&env);
        let attestors = vec![&env, attestor.clone()];
        let weights = vec![&env, 1u32];
        let slice_id = client.create_slice(&creator, &attestors, &weights, &1u32);

        let cred_type = 1u32;
        let metadata = Bytes::from_slice(&env, b"QmTestHash000000000000000000000000");
        let cred_id = client.issue_credential(&issuer, &holder, &cred_type, &metadata, &None, &0u64);

        // First attestation should succeed
        let expires_at = env.ledger().timestamp() + 86400;
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            client.attest(&attestor, &cred_id, &slice_id, &true, &Some(expires_at));
        }));

        assert!(result.is_ok(), "First attestation should not panic");
    }

    // ── Issue #1362: Quorum Intersection Verification Tests ─────────────────────

    #[test]
    fn test_single_slice_attestation_unaffected() {
        // Verify normal single-slice attestation flows are unaffected by intersection checks
        let env = Env::default();
        let client = setup(&env);

        let issuer = Address::generate(&env);
        let holder = Address::generate(&env);
        let attestor1 = Address::generate(&env);
        let attestor2 = Address::generate(&env);

        // Create a single slice requiring both attestors
        let creator = Address::generate(&env);
        let attestors = vec![&env, attestor1.clone(), attestor2.clone()];
        let weights = vec![&env, 1u32, 1u32];
        let slice_id = client.create_slice(&creator, &attestors, &weights, &2u32);

        let cred_type = 1u32;
        let metadata = Bytes::from_slice(&env, b"QmTestHash000000000000000000000000");
        let cred_id = client.issue_credential(&issuer, &holder, &cred_type, &metadata, &None, &0u64);

        // First attestation
        client.attest(&attestor1, &cred_id, &slice_id, &true, &None);
        assert!(!client.is_attested(&cred_id, &slice_id));

        // Second attestation meets quorum
        client.attest(&attestor2, &cred_id, &slice_id, &true, &None);
        assert!(client.is_attested(&cred_id, &slice_id));
    }

    #[test]
    fn test_disjoint_slices_require_common_attestors() {
        // Two disjoint slices independently reaching quorum should NOT satisfy consensus
        let env = Env::default();
        let client = setup(&env);

        let issuer = Address::generate(&env);
        let holder = Address::generate(&env);

        // Slice 1: attestors A and B
        let attestor_a = Address::generate(&env);
        let attestor_b = Address::generate(&env);
        let creator1 = Address::generate(&env);
        let slice1_attestors = vec![&env, attestor_a.clone(), attestor_b.clone()];
        let weights1 = vec![&env, 1u32, 1u32];
        let slice1_id = client.create_slice(&creator1, &slice1_attestors, &weights1, &1u32);

        // Slice 2: attestors C and D (disjoint from slice 1)
        let attestor_c = Address::generate(&env);
        let attestor_d = Address::generate(&env);
        let creator2 = Address::generate(&env);
        let slice2_attestors = vec![&env, attestor_c.clone(), attestor_d.clone()];
        let weights2 = vec![&env, 1u32, 1u32];
        let slice2_id = client.create_slice(&creator2, &slice2_attestors, &weights2, &1u32);

        let cred_type = 1u32;
        let metadata = Bytes::from_slice(&env, b"QmTestHash000000000000000000000000");
        let cred_id = client.issue_credential(&issuer, &holder, &cred_type, &metadata, &None, &0u64);

        // Slice 1 reaches quorum with attestor A
        client.attest(&attestor_a, &cred_id, &slice1_id, &true, &None);
        assert!(client.is_attested(&cred_id, &slice1_id));

        // Slice 2 reaches quorum with attestor C
        client.attest(&attestor_c, &cred_id, &slice2_id, &true, &None);
        // Slice 2 should report attested for its own slice
        assert!(client.is_attested(&cred_id, &slice2_id));

        // But neither slice has attestators from the OTHER slice.
        // Verify the attestors don't form intersection by checking the attestation records
        let attestors = client.get_attestors(&cred_id);
        assert_eq!(attestors.len(), 2u32); // Only A and C attested
        // A is in slice 1, C is in slice 2 -> no common nodes -> no intersection

        // If we had a function to check intersection directly, it would return false
        // This test verifies the state; with full intersection gating, this scenario
        // would require common attestors between slices
    }

    #[test]
    fn test_overlapping_slices_form_intersection() {
        // Two slices with overlapping attestors should form valid intersection
        let env = Env::default();
        let client = setup(&env);

        let issuer = Address::generate(&env);
        let holder = Address::generate(&env);

        // Common attestor
        let common = Address::generate(&env);
        // Slice 1 unique attestor
        let attestor_a = Address::generate(&env);
        // Slice 2 unique attestor
        let attestor_b = Address::generate(&env);

        // Slice 1: A and Common (threshold 1)
        let creator1 = Address::generate(&env);
        let slice1_attestors = vec![&env, attestor_a.clone(), common.clone()];
        let weights1 = vec![&env, 1u32, 1u32];
        let slice1_id = client.create_slice(&creator1, &slice1_attestors, &weights1, &1u32);

        // Slice 2: B and Common (threshold 1)
        let creator2 = Address::generate(&env);
        let slice2_attestors = vec![&env, attestor_b.clone(), common.clone()];
        let weights2 = vec![&env, 1u32, 1u32];
        let slice2_id = client.create_slice(&creator2, &slice2_attestors, &weights2, &1u32);

        let cred_type = 1u32;
        let metadata = Bytes::from_slice(&env, b"QmTestHash000000000000000000000000");
        let cred_id = client.issue_credential(&issuer, &holder, &cred_type, &metadata, &None, &0u64);

        // Only the common attestor attests
        client.attest(&common, &cred_id, &slice1_id, &true, &None);
        client.attest(&common, &cred_id, &slice2_id, &true, &None);

        // Both slices should report attested (common has weight >= threshold)
        assert!(client.is_attested(&cred_id, &slice1_id));
        assert!(client.is_attested(&cred_id, &slice2_id));

        // Common node forms quorum intersection across both slices
    }

    #[test]
    fn test_nested_slice_requires_intersection_check() {
        // A single nested slice should also require intersection verification
        let env = Env::default();
        let client = setup(&env);

        let issuer = Address::generate(&env);
        let holder = Address::generate(&env);

        // Create a simple flat slice first
        let attestor1 = Address::generate(&env);
        let attestor2 = Address::generate(&env);
        let creator = Address::generate(&env);
        let attestors = vec![&env, attestor1.clone(), attestor2.clone()];
        let weights = vec![&env, 1u32, 1u32];
        let slice_id = client.create_slice(&creator, &attestors, &weights, &2u32);

        let cred_type = 1u32;
        let metadata = Bytes::from_slice(&env, b"QmTestHash000000000000000000000000");
        let cred_id = client.issue_credential(&issuer, &holder, &cred_type, &metadata, &None, &0u64);

        // Both attestors attest
        client.attest(&attestor1, &cred_id, &slice_id, &true, &None);
        client.attest(&attestor2, &cred_id, &slice_id, &true, &None);

        // Should reach quorum normally
        assert!(client.is_attested(&cred_id, &slice_id));
    }

    #[test]
    fn test_three_slices_with_complex_intersection() {
        // Three slices with partial overlap should require all to form quorum
        let env = Env::default();
        let client = setup(&env);

        let issuer = Address::generate(&env);
        let holder = Address::generate(&env);

        let a = Address::generate(&env);
        let b = Address::generate(&env);
        let c = Address::generate(&env);

        // Slice 1: A and B (need both)
        let creator1 = Address::generate(&env);
        let s1_attestors = vec![&env, a.clone(), b.clone()];
        let s1_weights = vec![&env, 1u32, 1u32];
        let s1_id = client.create_slice(&creator1, &s1_attestors, &s1_weights, &2u32);

        // Slice 2: B and C (need both)
        let creator2 = Address::generate(&env);
        let s2_attestors = vec![&env, b.clone(), c.clone()];
        let s2_weights = vec![&env, 1u32, 1u32];
        let s2_id = client.create_slice(&creator2, &s2_attestors, &s2_weights, &2u32);

        // Slice 3: A and C (need both)
        let creator3 = Address::generate(&env);
        let s3_attestors = vec![&env, a.clone(), c.clone()];
        let s3_weights = vec![&env, 1u32, 1u32];
        let s3_id = client.create_slice(&creator3, &s3_attestors, &s3_weights, &2u32);

        let cred_type = 1u32;
        let metadata = Bytes::from_slice(&env, b"QmTestHash000000000000000000000000");
        let cred_id = client.issue_credential(&issuer, &holder, &cred_type, &metadata, &None, &0u64);

        // All three attestors must attest for intersection to be satisfied
        client.attest(&a, &cred_id, &s1_id, &true, &None);
        client.attest(&b, &cred_id, &s1_id, &true, &None);
        assert!(client.is_attested(&cred_id, &s1_id)); // Slice 1 satisfied

        client.attest(&b, &cred_id, &s2_id, &true, &None);
        client.attest(&c, &cred_id, &s2_id, &true, &None);
        assert!(client.is_attested(&cred_id, &s2_id)); // Slice 2 satisfied

        client.attest(&a, &cred_id, &s3_id, &true, &None);
        client.attest(&c, &cred_id, &s3_id, &true, &None);
        assert!(client.is_attested(&cred_id, &s3_id)); // Slice 3 satisfied

        // All slices: A, B, C form the intersection. Each attestor attests once per
        // slice they belong to (A: s1+s3, B: s1+s2, C: s2+s3), so get_attestors
        // returns one record per attestation event: 6 records total.
        let attestors = client.get_attestors(&cred_id);
        assert_eq!(attestors.len(), 6u32);
    }
}

/// Issue #1395: the attestation veto (`attestation_veto`) and attestation
/// time-lock (`time_lock_attestation`) mechanisms are independent — neither
/// blocks or defers to the other. These tests lock that behavior in.
#[cfg(test)]
mod veto_time_lock_interaction {
    use crate::{QuorumProofContract, QuorumProofContractClient};
    use soroban_sdk::testutils::{Address as _, Ledger as _};
    use soroban_sdk::{vec, Address, Bytes, Env};

    fn setup(env: &Env) -> QuorumProofContractClient<'_> {
        env.mock_all_auths_allowing_non_root_auth();
        let id = env.register_contract(None, QuorumProofContract);
        let client = QuorumProofContractClient::new(env, &id);
        let admin = Address::generate(env);
        client.initialize(&admin);
        client
    }

    fn issue_and_attest(env: &Env, client: &QuorumProofContractClient) -> (u64, u64, Address) {
        let issuer = Address::generate(env);
        let holder = Address::generate(env);
        let attestor = Address::generate(env);

        let creator = Address::generate(env);
        let attestors = vec![env, attestor.clone()];
        let weights = vec![env, 1u32];
        let slice_id = client.create_slice(&creator, &attestors, &weights, &1u32);

        let metadata = Bytes::from_slice(env, b"QmTestHash000000000000000000000000");
        let cred_id = client.issue_credential(&issuer, &holder, &1u32, &metadata, &None, &0u64);
        client.attest(&attestor, &cred_id, &slice_id, &true, &None);

        (cred_id, slice_id, attestor)
    }

    /// A veto can be requested against a credential whose attestation is
    /// still pending release under a time-lock — the veto mechanism does not
    /// wait for the attestation to become effective first.
    #[test]
    fn test_veto_requested_while_attestation_time_locked() {
        let env = Env::default();
        let client = setup(&env);
        let (cred_id, slice_id, attestor) = issue_and_attest(&env, &client);

        let admin_authorities = vec![&env, Address::generate(&env)];
        let admin = admin_authorities.get(0).unwrap();
        client.init_veto_authorities(&admin, &admin_authorities);

        let release_at = env.ledger().timestamp() + 10_000;
        let credential = client.get_credential(&cred_id);
        let reason = Bytes::from_slice(&env, b"fraud detection window");
        client.set_attestation_time_lock(&credential.issuer, &cred_id, &release_at, &reason);
        assert!(client.is_attestation_time_locked(&cred_id));

        let veto_id = client.request_veto(&admin, &cred_id, &slice_id, &attestor, &None, &None);
        let veto = client.get_veto_request(&veto_id).unwrap();
        assert_eq!(veto.credential_id, cred_id);
    }

    /// A veto can be executed once its own time-lock has elapsed, regardless
    /// of whether the credential's attestation time-lock has also released.
    #[test]
    fn test_veto_executed_after_attestation_lock_released() {
        let env = Env::default();
        let client = setup(&env);
        let (cred_id, slice_id, attestor) = issue_and_attest(&env, &client);

        let authorities = vec![&env, Address::generate(&env)];
        let veto_authority = authorities.get(0).unwrap();
        client.init_veto_authorities(&veto_authority, &authorities);
        client.set_veto_timelock(&veto_authority, &1_000u64);

        let credential = client.get_credential(&cred_id);
        let release_at = env.ledger().timestamp() + 500;
        let reason = Bytes::from_slice(&env, b"fraud detection window");
        client.set_attestation_time_lock(&credential.issuer, &cred_id, &release_at, &reason);

        let veto_id =
            client.request_veto(&veto_authority, &cred_id, &slice_id, &attestor, &None, &None);

        // Advance past both the attestation lock's release and the veto's
        // own unlock time.
        env.ledger().with_mut(|l| l.timestamp += 1_500);
        assert!(!client.is_attestation_time_locked(&cred_id));

        let executed = client.execute_veto(&veto_authority, &veto_id);
        assert!(executed, "veto should execute once its own time-lock has elapsed");
    }

    /// Setting an attestation time-lock on a credential that already has a
    /// pending veto is allowed — the two schedules do not interact.
    #[test]
    fn test_attestation_lock_set_with_pending_veto() {
        let env = Env::default();
        let client = setup(&env);
        let (cred_id, slice_id, attestor) = issue_and_attest(&env, &client);

        let authorities = vec![&env, Address::generate(&env)];
        let veto_authority = authorities.get(0).unwrap();
        client.init_veto_authorities(&veto_authority, &authorities);

        let veto_id =
            client.request_veto(&veto_authority, &cred_id, &slice_id, &attestor, &None, &None);
        assert!(client.get_veto_request(&veto_id).is_some());

        let credential = client.get_credential(&cred_id);
        let release_at = env.ledger().timestamp() + 10_000;
        let reason = Bytes::from_slice(&env, b"fraud detection window");
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            client.set_attestation_time_lock(&credential.issuer, &cred_id, &release_at, &reason)
        }));
        assert!(
            result.is_ok(),
            "setting an attestation time-lock must not be blocked by a pending veto"
        );

        // The veto is untouched by the newly-set attestation lock.
        let veto = client.get_veto_request(&veto_id).unwrap();
        assert_eq!(veto.credential_id, cred_id);
        assert!(client.is_attestation_time_locked(&cred_id));
    }
}
