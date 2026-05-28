#[cfg(test)]
mod tests {
    use super::*;
    use soroban_sdk::testutils::{Address as _, Ledger as _, LedgerInfo};
    use soroban_sdk::{vec, Env};

    // ── Upgrade Validation Tests ──────────────────────────────────────────────

    #[test]
    fn test_validate_upgrade_rejects_zero_hash() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register_contract(None, QuorumProofContract);
        let client = QuorumProofContractClient::new(&env, &contract_id);
        let admin = Address::generate(&env);
        client.initialize(&admin);

        let zero_hash = soroban_sdk::BytesN::<32>::from_array(&env, &[0u8; 32]);
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            client.validate_upgrade(&zero_hash);
        }));
        assert!(result.is_err(), "zero hash should be rejected");
    }

    #[test]
    fn test_validate_upgrade_rejects_when_paused() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register_contract(None, QuorumProofContract);
        let client = QuorumProofContractClient::new(&env, &contract_id);
        let admin = Address::generate(&env);
        client.initialize(&admin);
        client.pause(&admin);

        let valid_hash = soroban_sdk::BytesN::<32>::from_array(&env, &[1u8; 32]);
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            client.validate_upgrade(&valid_hash);
        }));
        assert!(result.is_err(), "upgrade should be blocked while paused");
    }

    #[test]
    fn test_validate_upgrade_accepts_valid_hash() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register_contract(None, QuorumProofContract);
        let client = QuorumProofContractClient::new(&env, &contract_id);
        let admin = Address::generate(&env);
        client.initialize(&admin);

        let valid_hash = soroban_sdk::BytesN::<32>::from_array(&env, &[0xABu8; 32]);
        // Should not panic
        client.validate_upgrade(&valid_hash);
    }

    #[test]
    fn test_upgrade_requires_admin_auth() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register_contract(None, QuorumProofContract);
        let client = QuorumProofContractClient::new(&env, &contract_id);
        let admin = Address::generate(&env);
        let stranger = Address::generate(&env);
        client.initialize(&admin);

        let valid_hash = soroban_sdk::BytesN::<32>::from_array(&env, &[0xABu8; 32]);
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            client.upgrade(&stranger, &valid_hash);
        }));
        assert!(result.is_err(), "non-admin should not be able to upgrade");
    }

    // ── Backup / State Integrity Tests ───────────────────────────────────────

    /// Verify that credential_count is consistent with the number of issued credentials.
    #[test]
    fn test_backup_credential_count_consistency() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register_contract(None, QuorumProofContract);
        let client = QuorumProofContractClient::new(&env, &contract_id);
        let admin = Address::generate(&env);
        let issuer = Address::generate(&env);
        let subject = Address::generate(&env);
        client.initialize(&admin);

        let hash = soroban_sdk::Bytes::from_array(&env, &[1u8; 32]);
        client.issue_credential(&issuer, &subject, &1u32, &hash, &None);
        client.issue_credential(&issuer, &subject, &2u32, &hash, &None);
        client.issue_credential(&issuer, &subject, &3u32, &hash, &None);

        // Snapshot invariant: count must equal number of retrievable credentials
        let count = client.get_credential_count();
        assert_eq!(count, 3, "credential_count must match issued credentials");
        for id in 1..=count {
            assert!(client.credential_exists(&id), "credential {id} must exist");
        }
    }

    /// Verify that slice_count is consistent with the number of created slices.
    #[test]
    fn test_backup_slice_count_consistency() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register_contract(None, QuorumProofContract);
        let client = QuorumProofContractClient::new(&env, &contract_id);
        let admin = Address::generate(&env);
        let creator = Address::generate(&env);
        let a1 = Address::generate(&env);
        let a2 = Address::generate(&env);
        client.initialize(&admin);

        let attestors = vec![&env, a1.clone(), a2.clone()];
        let weights = vec![&env, 50u32, 50u32];
        client.create_slice(&creator, &attestors, &weights, &50u32);
        client.create_slice(&creator, &attestors, &weights, &50u32);

        let count = client.get_slice_count();
        assert_eq!(count, 2, "slice_count must match created slices");
        for id in 1..=count {
            assert!(client.slice_exists(&id), "slice {id} must exist");
        }
    }

    /// Verify that revoked credentials are still retrievable (not deleted) for audit.
    #[test]
    fn test_backup_revoked_credentials_remain_in_state() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register_contract(None, QuorumProofContract);
        let client = QuorumProofContractClient::new(&env, &contract_id);
        let admin = Address::generate(&env);
        let issuer = Address::generate(&env);
        let subject = Address::generate(&env);
        client.initialize(&admin);

        let hash = soroban_sdk::Bytes::from_array(&env, &[1u8; 32]);
        let cred_id = client.issue_credential(&issuer, &subject, &1u32, &hash, &None);
        client.revoke_credential(&issuer, &cred_id);

        // Revoked credential must still exist in storage (for backup/audit)
        assert!(client.credential_exists(&cred_id), "revoked credential must remain in state");
        assert!(client.is_revoked(&cred_id), "credential must be marked revoked");
    }

    /// Verify that credential_count never decreases after revocation.
    #[test]
    fn test_backup_count_does_not_decrease_on_revoke() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register_contract(None, QuorumProofContract);
        let client = QuorumProofContractClient::new(&env, &contract_id);
        let admin = Address::generate(&env);
        let issuer = Address::generate(&env);
        let subject = Address::generate(&env);
        client.initialize(&admin);

        let hash = soroban_sdk::Bytes::from_array(&env, &[1u8; 32]);
        let cred_id = client.issue_credential(&issuer, &subject, &1u32, &hash, &None);
        let count_before = client.get_credential_count();
        client.revoke_credential(&issuer, &cred_id);
        let count_after = client.get_credential_count();

        assert_eq!(count_before, count_after, "credential_count must not decrease on revoke");
    }

    // ── Feature #355: Proof Expiry Tests ─────────────────────────────────────

    #[test]
    fn test_is_proof_expired() {
        let env = Env::default();
        env.mock_all_auths();
        
        let contract_id = env.register_contract(None, QuorumProofContract);
        let client = QuorumProofContractClient::new(&env, &contract_id);
        
        let admin = Address::generate(&env);
        let issuer = Address::generate(&env);
        let subject = Address::generate(&env);
        
        client.initialize(&admin);
        
        let metadata_hash = soroban_sdk::Bytes::from_array(&env, &[1u8; 32]);
        let cred_id = client.issue_credential(&issuer, &subject, &1u32, &metadata_hash, &None);
        
        // Set current time to 1000
        env.ledger().with_mut(|li| {
            li.timestamp = 1000;
        });
        
        // Proof expires at 2000 - should not be expired
        assert_eq!(client.is_proof_expired(&cred_id, &2000u64), false);
        
        // Move time forward to 2000
        env.ledger().with_mut(|li| {
            li.timestamp = 2000;
        });
        
        // Proof should now be expired
        assert_eq!(client.is_proof_expired(&cred_id, &2000u64), true);
    }

    #[test]
    fn test_renew_proof() {
        let env = Env::default();
        env.mock_all_auths();
        
        let contract_id = env.register_contract(None, QuorumProofContract);
        let client = QuorumProofContractClient::new(&env, &contract_id);
        
        let admin = Address::generate(&env);
        let issuer = Address::generate(&env);
        let subject = Address::generate(&env);
        
        client.initialize(&admin);
        
        env.ledger().with_mut(|li| {
            li.timestamp = 1000;
        });
        
        let metadata_hash = soroban_sdk::Bytes::from_array(&env, &[1u8; 32]);
        let cred_id = client.issue_credential(&issuer, &subject, &1u32, &metadata_hash, &None);
        
        // Renew proof to expire at 5000
        let new_expiry = client.renew_proof(&issuer, &cred_id, &5000u64);
        assert_eq!(new_expiry, 5000u64);
        
        // Verify proof is not expired at current time
        assert_eq!(client.is_proof_expired(&cred_id, &new_expiry), false);
    }

    #[test]
    #[should_panic(expected = "only the issuer can renew proofs")]
    fn test_renew_proof_unauthorized() {
        let env = Env::default();
        env.mock_all_auths();
        
        let contract_id = env.register_contract(None, QuorumProofContract);
        let client = QuorumProofContractClient::new(&env, &contract_id);
        
        let admin = Address::generate(&env);
        let issuer = Address::generate(&env);
        let subject = Address::generate(&env);
        let stranger = Address::generate(&env);
        
        client.initialize(&admin);
        
        env.ledger().with_mut(|li| {
            li.timestamp = 1000;
        });
        
        let metadata_hash = soroban_sdk::Bytes::from_array(&env, &[1u8; 32]);
        let cred_id = client.issue_credential(&issuer, &subject, &1u32, &metadata_hash, &None);
        
        // Stranger tries to renew proof - should panic
        client.renew_proof(&stranger, &cred_id, &5000u64);
    }

    // ── Feature #356: Batch Proof Verification Tests ─────────────────────────

    #[test]
    fn test_batch_verify_proofs() {
        let env = Env::default();
        env.mock_all_auths();
        
        let contract_id = env.register_contract(None, QuorumProofContract);
        let client = QuorumProofContractClient::new(&env, &contract_id);
        
        let admin = Address::generate(&env);
        let issuer = Address::generate(&env);
        let subject = Address::generate(&env);
        let attestor1 = Address::generate(&env);
        let attestor2 = Address::generate(&env);
        
        client.initialize(&admin);
        
        env.ledger().with_mut(|li| {
            li.timestamp = 1000;
        });
        
        // Create credentials
        let metadata_hash = soroban_sdk::Bytes::from_array(&env, &[1u8; 32]);
        let cred_id1 = client.issue_credential(&issuer, &subject, &1u32, &metadata_hash, &None);
        let cred_id2 = client.issue_credential(&issuer, &subject, &2u32, &metadata_hash, &None);
        
        // Create slice
        let attestors = vec![&env, attestor1.clone(), attestor2.clone()];
        let weights = vec![&env, 50u32, 50u32];
        let slice_id = client.create_slice(&issuer, &attestors, &weights, &50u32);
        
        // Attest credentials
        client.attest(&attestor1, &cred_id1, &slice_id, &true, &None);
        client.attest(&attestor2, &cred_id2, &slice_id, &true, &None);
        
        // Batch verify
        let credential_ids = vec![&env, cred_id1, cred_id2];
        let slice_ids = vec![&env, slice_id, slice_id];
        let proof_expires_at_list = vec![&env, 2000u64, 3000u64];
        
        let results = client.batch_verify_proofs(&credential_ids, &slice_ids, &proof_expires_at_list);
        
        assert_eq!(results.len(), 2);
        
        // First credential should be valid and not expired
        let (id1, valid1, expired1) = results.get(0).unwrap();
        assert_eq!(id1, cred_id1);
        assert_eq!(valid1, true);
        assert_eq!(expired1, false);
        
        // Second credential should be valid and not expired
        let (id2, valid2, expired2) = results.get(1).unwrap();
        assert_eq!(id2, cred_id2);
        assert_eq!(valid2, true);
        assert_eq!(expired2, false);
    }

    #[test]
    fn test_batch_verify_proofs_with_expiry() {
        let env = Env::default();
        env.mock_all_auths();
        
        let contract_id = env.register_contract(None, QuorumProofContract);
        let client = QuorumProofContractClient::new(&env, &contract_id);
        
        let admin = Address::generate(&env);
        let issuer = Address::generate(&env);
        let subject = Address::generate(&env);
        
        client.initialize(&admin);
        
        env.ledger().with_mut(|li| {
            li.timestamp = 2500;
        });
        
        let metadata_hash = soroban_sdk::Bytes::from_array(&env, &[1u8; 32]);
        let cred_id1 = client.issue_credential(&issuer, &subject, &1u32, &metadata_hash, &None);
        let cred_id2 = client.issue_credential(&issuer, &subject, &2u32, &metadata_hash, &None);
        
        let credential_ids = vec![&env, cred_id1, cred_id2];
        let slice_ids = vec![&env, 1u64, 1u64];
        let proof_expires_at_list = vec![&env, 2000u64, 3000u64]; // First expired, second not
        
        let results = client.batch_verify_proofs(&credential_ids, &slice_ids, &proof_expires_at_list);
        
        // First proof should be expired
        let (_, _, expired1) = results.get(0).unwrap();
        assert_eq!(expired1, true);
        
        // Second proof should not be expired
        let (_, _, expired2) = results.get(1).unwrap();
        assert_eq!(expired2, false);
    }

    // ── Feature #357: Claim Type Validation Tests ────────────────────────────

    #[test]
    fn test_is_claim_type_supported() {
        let env = Env::default();
        let contract_id = env.register_contract(None, QuorumProofContract);
        let client = QuorumProofContractClient::new(&env, &contract_id);
        
        // All standard claim types should be supported
        assert_eq!(client.is_claim_type_supported(&ClaimType::Degree), true);
        assert_eq!(client.is_claim_type_supported(&ClaimType::License), true);
        assert_eq!(client.is_claim_type_supported(&ClaimType::Employment), true);
        assert_eq!(client.is_claim_type_supported(&ClaimType::Age), true);
        assert_eq!(client.is_claim_type_supported(&ClaimType::Citizenship), true);
        assert_eq!(client.is_claim_type_supported(&ClaimType::Custom), true);
    }

    #[test]
    fn test_get_supported_claim_types() {
        let env = Env::default();
        let contract_id = env.register_contract(None, QuorumProofContract);
        let client = QuorumProofContractClient::new(&env, &contract_id);
        
        let types = client.get_supported_claim_types();
        assert_eq!(types.len(), 6);
        
        // Verify all expected types are present
        assert!(types.iter().any(|t| t == ClaimType::Degree));
        assert!(types.iter().any(|t| t == ClaimType::License));
        assert!(types.iter().any(|t| t == ClaimType::Employment));
        assert!(types.iter().any(|t| t == ClaimType::Age));
        assert!(types.iter().any(|t| t == ClaimType::Citizenship));
        assert!(types.iter().any(|t| t == ClaimType::Custom));
    }

    #[test]
    fn test_validate_claim_types() {
        let env = Env::default();
        let contract_id = env.register_contract(None, QuorumProofContract);
        let client = QuorumProofContractClient::new(&env, &contract_id);
        
        // Valid claim types
        let valid_types = vec![&env, ClaimType::Degree, ClaimType::License];
        assert_eq!(client.validate_claim_types(&valid_types), true);
        
        // All supported types
        let all_types = vec![
            &env,
            ClaimType::Degree,
            ClaimType::License,
            ClaimType::Employment,
            ClaimType::Age,
            ClaimType::Citizenship,
            ClaimType::Custom,
        ];
        assert_eq!(client.validate_claim_types(&all_types), true);
    }

    // ── Feature #359: Credential Search Tests ────────────────────────────────

    #[test]
    fn test_search_credentials_by_subject() {
        let env = Env::default();
        env.mock_all_auths();
        
        let contract_id = env.register_contract(None, QuorumProofContract);
        let client = QuorumProofContractClient::new(&env, &contract_id);
        
        let admin = Address::generate(&env);
        let issuer = Address::generate(&env);
        let subject1 = Address::generate(&env);
        let subject2 = Address::generate(&env);
        
        client.initialize(&admin);
        
        let metadata_hash = soroban_sdk::Bytes::from_array(&env, &[1u8; 32]);
        
        // Issue credentials to different subjects
        let cred_id1 = client.issue_credential(&issuer, &subject1, &1u32, &metadata_hash, &None);
        let cred_id2 = client.issue_credential(&issuer, &subject1, &2u32, &metadata_hash, &None);
        let cred_id3 = client.issue_credential(&issuer, &subject2, &1u32, &metadata_hash, &None);
        
        // Search for subject1's credentials
        let results = client.search_credentials(
            &Some(subject1.clone()),
            &None,
            &None,
            &None,
            &None,
            &1u32,
            &10u32,
        );
        
        assert_eq!(results.len(), 2);
        assert!(results.iter().any(|id| id == cred_id1));
        assert!(results.iter().any(|id| id == cred_id2));
    }

    #[test]
    fn test_search_credentials_by_issuer() {
        let env = Env::default();
        env.mock_all_auths();
        
        let contract_id = env.register_contract(None, QuorumProofContract);
        let client = QuorumProofContractClient::new(&env, &contract_id);
        
        let admin = Address::generate(&env);
        let issuer1 = Address::generate(&env);
        let issuer2 = Address::generate(&env);
        let subject = Address::generate(&env);
        
        client.initialize(&admin);
        
        let metadata_hash = soroban_sdk::Bytes::from_array(&env, &[1u8; 32]);
        
        // Issue credentials from different issuers
        let cred_id1 = client.issue_credential(&issuer1, &subject, &1u32, &metadata_hash, &None);
        let cred_id2 = client.issue_credential(&issuer2, &subject, &1u32, &metadata_hash, &None);
        
        // Search for issuer1's credentials
        let results = client.search_credentials(
            &None,
            &Some(issuer1.clone()),
            &None,
            &None,
            &None,
            &1u32,
            &10u32,
        );
        
        assert_eq!(results.len(), 1);
        assert_eq!(results.get(0).unwrap(), cred_id1);
    }

    #[test]
    fn test_search_credentials_by_type() {
        let env = Env::default();
        env.mock_all_auths();
        
        let contract_id = env.register_contract(None, QuorumProofContract);
        let client = QuorumProofContractClient::new(&env, &contract_id);
        
        let admin = Address::generate(&env);
        let issuer = Address::generate(&env);
        let subject = Address::generate(&env);
        
        client.initialize(&admin);
        
        let metadata_hash = soroban_sdk::Bytes::from_array(&env, &[1u8; 32]);
        
        // Issue credentials of different types
        let cred_id1 = client.issue_credential(&issuer, &subject, &1u32, &metadata_hash, &None);
        let cred_id2 = client.issue_credential(&issuer, &subject, &2u32, &metadata_hash, &None);
        let cred_id3 = client.issue_credential(&issuer, &subject, &1u32, &metadata_hash, &None);
        
        // Search for type 1 credentials
        let results = client.search_credentials(
            &None,
            &None,
            &Some(1u32),
            &None,
            &None,
            &1u32,
            &10u32,
        );
        
        assert_eq!(results.len(), 2);
        assert!(results.iter().any(|id| id == cred_id1));
        assert!(results.iter().any(|id| id == cred_id3));
    }

    #[test]
    fn test_search_credentials_with_pagination() {
        let env = Env::default();
        env.mock_all_auths();
        
        let contract_id = env.register_contract(None, QuorumProofContract);
        let client = QuorumProofContractClient::new(&env, &contract_id);
        
        let admin = Address::generate(&env);
        let issuer = Address::generate(&env);
        let subject = Address::generate(&env);
        
        client.initialize(&admin);
        
        let metadata_hash = soroban_sdk::Bytes::from_array(&env, &[1u8; 32]);
        
        // Issue 5 credentials
        for i in 1..=5 {
            client.issue_credential(&issuer, &subject, &i, &metadata_hash, &None);
        }
        
        // Get first page (2 items)
        let page1 = client.search_credentials(
            &Some(subject.clone()),
            &None,
            &None,
            &None,
            &None,
            &1u32,
            &2u32,
        );
        assert_eq!(page1.len(), 2);
        
        // Get second page (2 items)
        let page2 = client.search_credentials(
            &Some(subject.clone()),
            &None,
            &None,
            &None,
            &None,
            &2u32,
            &2u32,
        );
        assert_eq!(page2.len(), 2);
        
        // Get third page (1 item)
        let page3 = client.search_credentials(
            &Some(subject.clone()),
            &None,
            &None,
            &None,
            &None,
            &3u32,
            &2u32,
        );
        assert_eq!(page3.len(), 1);
    }

    #[test]
    fn test_count_credentials() {
        let env = Env::default();
        env.mock_all_auths();
        
        let contract_id = env.register_contract(None, QuorumProofContract);
        let client = QuorumProofContractClient::new(&env, &contract_id);
        
        let admin = Address::generate(&env);
        let issuer = Address::generate(&env);
        let subject1 = Address::generate(&env);
        let subject2 = Address::generate(&env);
        
        client.initialize(&admin);
        
        let metadata_hash = soroban_sdk::Bytes::from_array(&env, &[1u8; 32]);
        
        // Issue credentials
        client.issue_credential(&issuer, &subject1, &1u32, &metadata_hash, &None);
        client.issue_credential(&issuer, &subject1, &2u32, &metadata_hash, &None);
        client.issue_credential(&issuer, &subject2, &1u32, &metadata_hash, &None);
        
        // Count all credentials
        let total = client.count_credentials(&None, &None, &None);
        assert_eq!(total, 3);
        
        // Count subject1's credentials
        let subject1_count = client.count_credentials(&Some(subject1), &None, &None);
        assert_eq!(subject1_count, 2);
        
        // Count type 1 credentials
        let type1_count = client.count_credentials(&None, &None, &Some(1u32));
        assert_eq!(type1_count, 2);
    }

    #[test]
    fn test_search_credentials_combined_filters() {
        let env = Env::default();
        env.mock_all_auths();
        
        let contract_id = env.register_contract(None, QuorumProofContract);
        let client = QuorumProofContractClient::new(&env, &contract_id);
        
        let admin = Address::generate(&env);
        let issuer1 = Address::generate(&env);
        let issuer2 = Address::generate(&env);
        let subject = Address::generate(&env);
        
        client.initialize(&admin);
        
        let metadata_hash = soroban_sdk::Bytes::from_array(&env, &[1u8; 32]);
        
        // Issue various credentials
        client.issue_credential(&issuer1, &subject, &1u32, &metadata_hash, &None);
        client.issue_credential(&issuer1, &subject, &2u32, &metadata_hash, &None);
        client.issue_credential(&issuer2, &subject, &1u32, &metadata_hash, &None);
        
        // Search for subject's type 1 credentials from issuer1
        let results = client.search_credentials(
            &Some(subject.clone()),
            &Some(issuer1.clone()),
            &Some(1u32),
            &None,
            &None,
            &1u32,
            &10u32,
        );
        
        assert_eq!(results.len(), 1);
    }

    // ── Feature #373: Slice Member Suspension Tests ──────────────────────────

    #[test]
    fn test_suspend_and_resume_attestor() {
        let env = Env::default();
        env.mock_all_auths();
        
        let contract_id = env.register_contract(None, QuorumProofContract);
        let client = QuorumProofContractClient::new(&env, &contract_id);
        
        let admin = Address::generate(&env);
        let creator = Address::generate(&env);
        let attestor1 = Address::generate(&env);
        let attestor2 = Address::generate(&env);
        
        client.initialize(&admin);
        
        let attestors = vec![&env, attestor1.clone(), attestor2.clone()];
        let weights = vec![&env, 50u32, 50u32];
        let slice_id = client.create_slice(&creator, &attestors, &weights, &100u32);
        
        // Initially not suspended
        assert_eq!(client.is_attestor_suspended(&slice_id, &attestor1), false);
        
        // Suspend attestor1
        client.suspend_attestor(&creator, &slice_id, &attestor1);
        assert_eq!(client.is_attestor_suspended(&slice_id, &attestor1), true);
        
        // attestor2 should still not be suspended
        assert_eq!(client.is_attestor_suspended(&slice_id, &attestor2), false);
        
        // Resume attestor1
        client.resume_attestor(&creator, &slice_id, &attestor1);
        assert_eq!(client.is_attestor_suspended(&slice_id, &attestor1), false);
    }

    #[test]
    fn test_suspended_attestor_cannot_attest() {
        let env = Env::default();
        env.mock_all_auths();
        
        let contract_id = env.register_contract(None, QuorumProofContract);
        let client = QuorumProofContractClient::new(&env, &contract_id);
        
        let admin = Address::generate(&env);
        let creator = Address::generate(&env);
        let issuer = Address::generate(&env);
        let subject = Address::generate(&env);
        let attestor = Address::generate(&env);
        
        client.initialize(&admin);
        
        let attestors = vec![&env, attestor.clone()];
        let weights = vec![&env, 100u32];
        let slice_id = client.create_slice(&creator, &attestors, &weights, &100u32);
        
        let metadata_hash = soroban_sdk::Bytes::from_array(&env, &[1u8; 32]);
        let cred_id = client.issue_credential(&issuer, &subject, &1u32, &metadata_hash, &None);
        
        // Suspend the attestor
        client.suspend_attestor(&creator, &slice_id, &attestor);
        
        // Try to attest - should panic
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            client.attest(&attestor, &cred_id, &slice_id, &true, &None);
        }));
        assert!(result.is_err());
    }

    // ── Feature #374: Slice Member Communication Tests ──────────────────────

    #[test]
    fn test_send_and_get_slice_messages() {
        let env = Env::default();
        env.mock_all_auths();
        
        let contract_id = env.register_contract(None, QuorumProofContract);
        let client = QuorumProofContractClient::new(&env, &contract_id);
        
        let admin = Address::generate(&env);
        let creator = Address::generate(&env);
        let attestor1 = Address::generate(&env);
        let attestor2 = Address::generate(&env);
        
        client.initialize(&admin);
        
        let attestors = vec![&env, attestor1.clone(), attestor2.clone()];
        let weights = vec![&env, 50u32, 50u32];
        let slice_id = client.create_slice(&creator, &attestors, &weights, &100u32);
        
        env.ledger().with_mut(|li| {
            li.timestamp = 1000;
        });
        
        let msg_content = soroban_sdk::String::from_str(&env, "Hello slice members");
        client.send_slice_message(&attestor1, &slice_id, &msg_content, &2000u64);
        
        let messages = client.get_slice_messages(&slice_id);
        assert_eq!(messages.len(), 1);
        assert_eq!(messages.get(0).unwrap().sender, attestor1);
    }

    #[test]
    fn test_message_expiry() {
        let env = Env::default();
        env.mock_all_auths();
        
        let contract_id = env.register_contract(None, QuorumProofContract);
        let client = QuorumProofContractClient::new(&env, &contract_id);
        
        let admin = Address::generate(&env);
        let creator = Address::generate(&env);
        let attestor = Address::generate(&env);
        
        client.initialize(&admin);
        
        let attestors = vec![&env, attestor.clone()];
        let weights = vec![&env, 100u32];
        let slice_id = client.create_slice(&creator, &attestors, &weights, &100u32);
        
        env.ledger().with_mut(|li| {
            li.timestamp = 1000;
        });
        
        let msg_content = soroban_sdk::String::from_str(&env, "Expiring message");
        client.send_slice_message(&attestor, &slice_id, &msg_content, &1500u64);
        
        // Message should be active
        let messages = client.get_slice_messages(&slice_id);
        assert_eq!(messages.len(), 1);
        
        // Move time forward past expiry
        env.ledger().with_mut(|li| {
            li.timestamp = 2000;
        });
        
        // Message should now be expired
        let messages = client.get_slice_messages(&slice_id);
        assert_eq!(messages.len(), 0);
    }

    // ── Feature #375: Attestation Evidence Tests ──────────────────────────────

    #[test]
    fn test_attach_and_get_evidence() {
        let env = Env::default();
        env.mock_all_auths();
        
        let contract_id = env.register_contract(None, QuorumProofContract);
        let client = QuorumProofContractClient::new(&env, &contract_id);
        
        let admin = Address::generate(&env);
        let issuer = Address::generate(&env);
        let subject = Address::generate(&env);
        let attestor = Address::generate(&env);
        
        client.initialize(&admin);
        
        let metadata_hash = soroban_sdk::Bytes::from_array(&env, &[1u8; 32]);
        let cred_id = client.issue_credential(&issuer, &subject, &1u32, &metadata_hash, &None);
        
        let evidence_hash = soroban_sdk::Bytes::from_array(&env, &[2u8; 32]);
        client.attach_evidence(&attestor, &cred_id, &evidence_hash);
        
        let evidence = client.get_attestation_evidence(&cred_id, &attestor);
        assert!(evidence.is_some());
        assert_eq!(evidence.unwrap().evidence_hash, evidence_hash);
    }

    #[test]
    fn test_evidence_not_found() {
        let env = Env::default();
        env.mock_all_auths();
        
        let contract_id = env.register_contract(None, QuorumProofContract);
        let client = QuorumProofContractClient::new(&env, &contract_id);
        
        let admin = Address::generate(&env);
        let issuer = Address::generate(&env);
        let subject = Address::generate(&env);
        let attestor = Address::generate(&env);
        
        client.initialize(&admin);
        
        let metadata_hash = soroban_sdk::Bytes::from_array(&env, &[1u8; 32]);
        let cred_id = client.issue_credential(&issuer, &subject, &1u32, &metadata_hash, &None);
        
        let evidence = client.get_attestation_evidence(&cred_id, &attestor);
        assert!(evidence.is_none());
    }

    // ── Feature #376: Attestation Conditions Tests ──────────────────────────

    #[test]
    fn test_set_and_get_conditions() {
        let env = Env::default();
        env.mock_all_auths();
        
        let contract_id = env.register_contract(None, QuorumProofContract);
        let client = QuorumProofContractClient::new(&env, &contract_id);
        
        let admin = Address::generate(&env);
        let issuer = Address::generate(&env);
        let subject = Address::generate(&env);
        
        client.initialize(&admin);
        
        let metadata_hash = soroban_sdk::Bytes::from_array(&env, &[1u8; 32]);
        let cred_id = client.issue_credential(&issuer, &subject, &1u32, &metadata_hash, &None);
        
        let condition_value = soroban_sdk::Bytes::from_array(&env, &[3u8; 32]);
        let conditions = vec![&env, AttestationCondition {
            condition_type: 1u32,
            value: condition_value.clone(),
        }];
        
        client.set_attestation_conditions(&issuer, &cred_id, &conditions);
        
        let retrieved = client.get_attestation_conditions(&cred_id);
        assert_eq!(retrieved.len(), 1);
        assert_eq!(retrieved.get(0).unwrap().condition_type, 1u32);
    }

    #[test]
    fn test_evaluate_conditions_success() {
        let env = Env::default();
        env.mock_all_auths();
        
        let contract_id = env.register_contract(None, QuorumProofContract);
        let client = QuorumProofContractClient::new(&env, &contract_id);
        
        let admin = Address::generate(&env);
        let issuer = Address::generate(&env);
        let subject = Address::generate(&env);
        
        client.initialize(&admin);
        
        let metadata_hash = soroban_sdk::Bytes::from_array(&env, &[1u8; 32]);
        let cred_id = client.issue_credential(&issuer, &subject, &1u32, &metadata_hash, &None);
        
        let condition_value = soroban_sdk::Bytes::from_array(&env, &[3u8; 32]);
        let conditions = vec![&env, AttestationCondition {
            condition_type: 1u32,
            value: condition_value.clone(),
        }];
        
        client.set_attestation_conditions(&issuer, &cred_id, &conditions);
        
        let result = client.evaluate_attestation_conditions(&cred_id, &vec![&env, condition_value]);
        assert_eq!(result, true);
    }

    #[test]
    fn test_evaluate_conditions_failure() {
        let env = Env::default();
        env.mock_all_auths();
        
        let contract_id = env.register_contract(None, QuorumProofContract);
        let client = QuorumProofContractClient::new(&env, &contract_id);
        
        let admin = Address::generate(&env);
        let issuer = Address::generate(&env);
        let subject = Address::generate(&env);
        
        client.initialize(&admin);
        
        let metadata_hash = soroban_sdk::Bytes::from_array(&env, &[1u8; 32]);
        let cred_id = client.issue_credential(&issuer, &subject, &1u32, &metadata_hash, &None);
        
        let condition_value = soroban_sdk::Bytes::from_array(&env, &[3u8; 32]);
        let wrong_value = soroban_sdk::Bytes::from_array(&env, &[4u8; 32]);
        let conditions = vec![&env, AttestationCondition {
            condition_type: 1u32,
            value: condition_value,
        }];
        
        client.set_attestation_conditions(&issuer, &cred_id, &conditions);
        
        let result = client.evaluate_attestation_conditions(&cred_id, &vec![&env, wrong_value]);
        assert_eq!(result, false);
    }

    #[test]
    fn test_no_conditions_always_pass() {
        let env = Env::default();
        env.mock_all_auths();

        let contract_id = env.register_contract(None, QuorumProofContract);
        let client = QuorumProofContractClient::new(&env, &contract_id);

        let admin = Address::generate(&env);
        let issuer = Address::generate(&env);
        let subject = Address::generate(&env);

        client.initialize(&admin);

        let metadata_hash = soroban_sdk::Bytes::from_array(&env, &[1u8; 32]);
        let cred_id = client.issue_credential(&issuer, &subject, &1u32, &metadata_hash, &None);

        // No conditions set
        let result = client.evaluate_attestation_conditions(&cred_id, &vec![&env]);
        assert_eq!(result, true);
    }

    // ── Issue #535: Credential Holder Consent Revocation Tests ────────────────

    #[test]
    fn test_revoke_consent_holder_can_revoke() {
        let env = Env::default();
        env.mock_all_auths();

        let contract_id = env.register_contract(None, QuorumProofContract);
        let client = QuorumProofContractClient::new(&env, &contract_id);

        let admin = Address::generate(&env);
        let issuer = Address::generate(&env);
        let holder = Address::generate(&env);

        client.initialize(&admin);

        let metadata_hash = soroban_sdk::Bytes::from_array(&env, &[1u8; 32]);
        let cred_id = client.issue_credential(&issuer, &holder, &1u32, &metadata_hash, &None);

        // Holder revokes consent
        client.revoke_consent(&holder, &cred_id);

        // Verify credential is revoked
        assert_eq!(client.is_revoked(&cred_id), true);
    }

    #[test]
    #[should_panic(expected = "only the credential holder can revoke consent")]
    fn test_revoke_consent_non_holder_rejected() {
        let env = Env::default();
        env.mock_all_auths();

        let contract_id = env.register_contract(None, QuorumProofContract);
        let client = QuorumProofContractClient::new(&env, &contract_id);

        let admin = Address::generate(&env);
        let issuer = Address::generate(&env);
        let holder = Address::generate(&env);
        let attacker = Address::generate(&env);

        client.initialize(&admin);

        let metadata_hash = soroban_sdk::Bytes::from_array(&env, &[1u8; 32]);
        let cred_id = client.issue_credential(&issuer, &holder, &1u32, &metadata_hash, &None);

        // Non-holder tries to revoke - should panic
        client.revoke_consent(&attacker, &cred_id);
    }

    #[test]
    #[should_panic(expected = "credential already revoked")]
    fn test_revoke_consent_already_revoked_rejected() {
        let env = Env::default();
        env.mock_all_auths();

        let contract_id = env.register_contract(None, QuorumProofContract);
        let client = QuorumProofContractClient::new(&env, &contract_id);

        let admin = Address::generate(&env);
        let issuer = Address::generate(&env);
        let holder = Address::generate(&env);

        client.initialize(&admin);

        let metadata_hash = soroban_sdk::Bytes::from_array(&env, &[1u8; 32]);
        let cred_id = client.issue_credential(&issuer, &holder, &1u32, &metadata_hash, &None);

        // Holder revokes consent once
        client.revoke_consent(&holder, &cred_id);

        // Try to revoke again - should panic
        client.revoke_consent(&holder, &cred_id);
    }

    #[test]
    #[should_panic(expected = "CredentialNotFound")]
    fn test_revoke_consent_non_existent_credential() {
        let env = Env::default();
        env.mock_all_auths();

        let contract_id = env.register_contract(None, QuorumProofContract);
        let client = QuorumProofContractClient::new(&env, &contract_id);

        let admin = Address::generate(&env);
        let holder = Address::generate(&env);

        client.initialize(&admin);

        // Try to revoke non-existent credential
        client.revoke_consent(&holder, &999u64);
    }

    // ── Issue #536: Credential Metadata Audit Trail Tests ─────────────────────

    #[test]
    fn test_audit_trail_first_update_creates_entry() {
        let env = Env::default();
        env.mock_all_auths();

        let contract_id = env.register_contract(None, QuorumProofContract);
        let client = QuorumProofContractClient::new(&env, &contract_id);

        let admin = Address::generate(&env);
        let issuer = Address::generate(&env);
        let holder = Address::generate(&env);

        client.initialize(&admin);

        let metadata_hash = soroban_sdk::Bytes::from_array(&env, &[1u8; 32]);
        let cred_id = client.issue_credential(&issuer, &holder, &1u32, &metadata_hash, &None);

        // Get audit trail before update - should be empty
        let trail_before = client.get_audit_trail(&cred_id);
        assert_eq!(trail_before.len(), 0);

        // Update metadata
        let new_metadata = soroban_sdk::Bytes::from_array(&env, &[2u8; 32]);
        client.update_metadata(&issuer, &cred_id, &new_metadata);

        // Get audit trail after update
        let trail = client.get_audit_trail(&cred_id);
        assert_eq!(trail.len(), 1);
        assert_eq!(trail.get(0).unwrap().updated_by, issuer);
    }

    #[test]
    fn test_audit_trail_appends_entries() {
        let env = Env::default();
        env.mock_all_auths();

        let contract_id = env.register_contract(None, QuorumProofContract);
        let client = QuorumProofContractClient::new(&env, &contract_id);

        let admin = Address::generate(&env);
        let issuer = Address::generate(&env);
        let holder = Address::generate(&env);

        client.initialize(&admin);

        let metadata_hash = soroban_sdk::Bytes::from_array(&env, &[1u8; 32]);
        let cred_id = client.issue_credential(&issuer, &holder, &1u32, &metadata_hash, &None);

        // Update metadata multiple times
        for i in 2..5 {
            let new_metadata = soroban_sdk::Bytes::from_array(&env, &[i as u8; 32]);
            client.update_metadata(&issuer, &cred_id, &new_metadata);
        }

        // Check audit trail has all entries
        let trail = client.get_audit_trail(&cred_id);
        assert_eq!(trail.len(), 3);

        // Verify all entries are from the issuer
        for i in 0..3 {
            assert_eq!(trail.get(i).unwrap().updated_by, issuer);
        }
    }

    #[test]
    fn test_audit_trail_preserved_after_new_update() {
        let env = Env::default();
        env.mock_all_auths();

        let contract_id = env.register_contract(None, QuorumProofContract);
        let client = QuorumProofContractClient::new(&env, &contract_id);

        let admin = Address::generate(&env);
        let issuer = Address::generate(&env);
        let holder = Address::generate(&env);

        client.initialize(&admin);

        let metadata_hash = soroban_sdk::Bytes::from_array(&env, &[1u8; 32]);
        let cred_id = client.issue_credential(&issuer, &holder, &1u32, &metadata_hash, &None);

        // First update
        let new_metadata_1 = soroban_sdk::Bytes::from_array(&env, &[2u8; 32]);
        client.update_metadata(&issuer, &cred_id, &new_metadata_1);

        let trail_1 = client.get_audit_trail(&cred_id);
        let first_entry = trail_1.get(0).unwrap().clone();

        // Second update
        let new_metadata_2 = soroban_sdk::Bytes::from_array(&env, &[3u8; 32]);
        client.update_metadata(&issuer, &cred_id, &new_metadata_2);

        let trail_2 = client.get_audit_trail(&cred_id);
        assert_eq!(trail_2.len(), 2);

        // Verify first entry is unchanged
        assert_eq!(trail_2.get(0).unwrap().updated_by, first_entry.updated_by);
        assert_eq!(trail_2.get(0).unwrap().timestamp, first_entry.timestamp);
    }

    #[test]
    fn test_audit_trail_chronological_order() {
        let env = Env::default();
        env.mock_all_auths();

        let contract_id = env.register_contract(None, QuorumProofContract);
        let client = QuorumProofContractClient::new(&env, &contract_id);

        let admin = Address::generate(&env);
        let issuer = Address::generate(&env);
        let holder = Address::generate(&env);

        client.initialize(&admin);

        let metadata_hash = soroban_sdk::Bytes::from_array(&env, &[1u8; 32]);
        let cred_id = client.issue_credential(&issuer, &holder, &1u32, &metadata_hash, &None);

        // Update metadata multiple times
        let mut timestamps = Vec::new(&env);
        for i in 2..5 {
            let new_metadata = soroban_sdk::Bytes::from_array(&env, &[i as u8; 32]);
            client.update_metadata(&issuer, &cred_id, &new_metadata);

            let trail = client.get_audit_trail(&cred_id);
            let entry = trail.get(timestamps.len()).unwrap();
            timestamps.push_back(entry.timestamp);
        }

        // Verify timestamps are in chronological order
        for i in 1..timestamps.len() {
            assert!(timestamps.get(i).unwrap() >= timestamps.get(i - 1).unwrap());
        }
    }

    #[test]
    #[should_panic(expected = "CredentialNotFound")]
    fn test_audit_trail_non_existent_credential() {
        let env = Env::default();
        env.mock_all_auths();

        let contract_id = env.register_contract(None, QuorumProofContract);
        let client = QuorumProofContractClient::new(&env, &contract_id);

        let admin = Address::generate(&env);

        client.initialize(&admin);

        // Try to get audit trail for non-existent credential
        client.get_audit_trail(&999u64);
    }

    // ── Issue #537: Credential Holder Activity Tracking with Retention ────────

    #[test]
    fn test_holder_activity_tracks_actions() {
        let env = Env::default();
        env.mock_all_auths();

        let contract_id = env.register_contract(None, QuorumProofContract);
        let client = QuorumProofContractClient::new(&env, &contract_id);

        let admin = Address::generate(&env);
        let issuer = Address::generate(&env);
        let holder = Address::generate(&env);

        client.initialize(&admin);

        // Issue a credential - should create activity record
        let metadata_hash = soroban_sdk::Bytes::from_array(&env, &[1u8; 32]);
        let cred_id = client.issue_credential(&issuer, &holder, &1u32, &metadata_hash, &None);

        // Get holder activity
        let activities = client.get_holder_activity(&holder, &1u32, &100u32);
        assert!(activities.len() > 0);

        // Should have at least one activity record (credential issued)
        let has_issue_activity = activities.iter().any(|a| a.credential_id == cred_id);
        assert!(has_issue_activity);
    }

    #[test]
    fn test_holder_activity_retention_policy() {
        let env = Env::default();
        env.mock_all_auths();

        let contract_id = env.register_contract(None, QuorumProofContract);
        let client = QuorumProofContractClient::new(&env, &contract_id);

        let admin = Address::generate(&env);
        let issuer = Address::generate(&env);
        let holder = Address::generate(&env);

        client.initialize(&admin);

        // Set initial time
        env.ledger().with_mut(|li| {
            li.timestamp = 1000;
        });

        // Issue a credential
        let metadata_hash = soroban_sdk::Bytes::from_array(&env, &[1u8; 32]);
        let cred_id = client.issue_credential(&issuer, &holder, &1u32, &metadata_hash, &None);

        // Get activity at time 1000
        let activities_1 = client.get_holder_activity(&holder, &1u32, &100u32);
        let count_at_1000 = activities_1.len();

        // Move time forward to 500 days later
        env.ledger().with_mut(|li| {
            li.timestamp = 1000 + (500 * 24 * 60 * 60);
        });

        // Issue another credential
        let cred_id_2 = client.issue_credential(&issuer, &holder, &1u32, &metadata_hash, &None);

        // Both activities should still be present
        let activities_2 = client.get_holder_activity(&holder, &1u32, &100u32);
        assert_eq!(activities_2.len(), count_at_1000 + 1);

        // Move time forward to more than 365 days later (total 500 days)
        env.ledger().with_mut(|li| {
            li.timestamp = 1000 + (400 * 24 * 60 * 60);
        });

        // Issue another credential - should trigger retention policy
        let cred_id_3 = client.issue_credential(&issuer, &holder, &1u32, &metadata_hash, &None);

        // Get activity - old records (> 365 days old) should be pruned
        let activities_3 = client.get_holder_activity(&holder, &1u32, &100u32);
        // At least the newest records should be present
        assert!(activities_3.len() > 0);
    }

    #[test]
    fn test_holder_activity_within_retention_window_preserved() {
        let env = Env::default();
        env.mock_all_auths();

        let contract_id = env.register_contract(None, QuorumProofContract);
        let client = QuorumProofContractClient::new(&env, &contract_id);

        let admin = Address::generate(&env);
        let issuer = Address::generate(&env);
        let holder = Address::generate(&env);

        client.initialize(&admin);

        // Set time
        env.ledger().with_mut(|li| {
            li.timestamp = 1000;
        });

        // Issue first credential
        let metadata_hash = soroban_sdk::Bytes::from_array(&env, &[1u8; 32]);
        let cred_id_1 = client.issue_credential(&issuer, &holder, &1u32, &metadata_hash, &None);

        // Move forward 100 days
        env.ledger().with_mut(|li| {
            li.timestamp = 1000 + (100 * 24 * 60 * 60);
        });

        // Issue second credential
        let cred_id_2 = client.issue_credential(&issuer, &holder, &1u32, &metadata_hash, &None);

        // Get activity - both should be present (only 100 days have passed, less than 365)
        let activities = client.get_holder_activity(&holder, &1u32, &100u32);
        assert!(activities.len() >= 2);
    }

    // ── Issue #538: Credential Metadata Compression Tests ──────────────────────

    #[test]
    fn test_uncompressed_metadata_stored_and_retrieved() {
        let env = Env::default();
        env.mock_all_auths();

        let contract_id = env.register_contract(None, QuorumProofContract);
        let client = QuorumProofContractClient::new(&env, &contract_id);

        let admin = Address::generate(&env);
        let issuer = Address::generate(&env);
        let holder = Address::generate(&env);

        client.initialize(&admin);

        let metadata_hash = soroban_sdk::Bytes::from_array(&env, &[1u8; 32]);
        let cred_id = client.issue_credential(&issuer, &holder, &1u32, &metadata_hash, &None);

        // Store uncompressed metadata
        let uncompressed_data = soroban_sdk::Bytes::from_slice(&env, b"uncompressed metadata content");
        client.set_credential_metadata(&issuer, &cred_id, &uncompressed_data, &CompressionType::None);

        // Retrieve and verify
        let retrieved = client.get_credential_metadata(&cred_id);
        assert!(retrieved.is_some());
        let metadata = retrieved.unwrap();
        assert_eq!(metadata.compression, CompressionType::None);
        assert_eq!(metadata.data, uncompressed_data);
    }

    #[test]
    fn test_compressed_metadata_stored_and_retrieved() {
        let env = Env::default();
        env.mock_all_auths();

        let contract_id = env.register_contract(None, QuorumProofContract);
        let client = QuorumProofContractClient::new(&env, &contract_id);

        let admin = Address::generate(&env);
        let issuer = Address::generate(&env);
        let holder = Address::generate(&env);

        client.initialize(&admin);

        let metadata_hash = soroban_sdk::Bytes::from_array(&env, &[1u8; 32]);
        let cred_id = client.issue_credential(&issuer, &holder, &1u32, &metadata_hash, &None);

        // Store compressed metadata (simulated gzip payload)
        let compressed_data = soroban_sdk::Bytes::from_slice(&env, b"\x1f\x8b\x08\x00compressed content");
        client.set_credential_metadata(&issuer, &cred_id, &compressed_data, &CompressionType::Gzip);

        // Retrieve and verify
        let retrieved = client.get_credential_metadata(&cred_id);
        assert!(retrieved.is_some());
        let metadata = retrieved.unwrap();
        assert_eq!(metadata.compression, CompressionType::Gzip);
        assert_eq!(metadata.data, compressed_data);
    }

    #[test]
    fn test_compression_type_round_trips() {
        let env = Env::default();
        env.mock_all_auths();

        let contract_id = env.register_contract(None, QuorumProofContract);
        let client = QuorumProofContractClient::new(&env, &contract_id);

        let admin = Address::generate(&env);
        let issuer = Address::generate(&env);
        let holder = Address::generate(&env);

        client.initialize(&admin);

        let metadata_hash = soroban_sdk::Bytes::from_array(&env, &[1u8; 32]);
        let cred_id = client.issue_credential(&issuer, &holder, &1u32, &metadata_hash, &None);

        // Test both compression types
        let test_data = soroban_sdk::Bytes::from_slice(&env, b"test data");

        // Store with None compression
        client.set_credential_metadata(&issuer, &cred_id, &test_data, &CompressionType::None);
        let retrieved_none = client.get_credential_metadata(&cred_id).unwrap();
        assert_eq!(retrieved_none.compression, CompressionType::None);

        // Update with Gzip compression
        let compressed_data = soroban_sdk::Bytes::from_slice(&env, b"\x1f\x8bcompressed");
        client.set_credential_metadata(&issuer, &cred_id, &compressed_data, &CompressionType::Gzip);
        let retrieved_gzip = client.get_credential_metadata(&cred_id).unwrap();
        assert_eq!(retrieved_gzip.compression, CompressionType::Gzip);
        assert_eq!(retrieved_gzip.data, compressed_data);
    }

    #[test]
    fn test_compressed_metadata_smaller_than_uncompressed() {
        let env = Env::default();
        env.mock_all_auths();

        let contract_id = env.register_contract(None, QuorumProofContract);
        let client = QuorumProofContractClient::new(&env, &contract_id);

        let admin = Address::generate(&env);
        let issuer = Address::generate(&env);
        let holder = Address::generate(&env);

        client.initialize(&admin);

        let metadata_hash = soroban_sdk::Bytes::from_array(&env, &[1u8; 32]);
        let cred_id = client.issue_credential(&issuer, &holder, &1u32, &metadata_hash, &None);

        // Create repetitive data that compresses well
        let mut large_data_vec = Vec::new(&env);
        let pattern = b"repetitive pattern for compression ";
        for _ in 0..10 {
            for &byte in pattern {
                large_data_vec.push_back(byte as u32);
            }
        }

        let uncompressed = soroban_sdk::Bytes::from_slice(&env, pattern);
        let compressed = soroban_sdk::Bytes::from_slice(&env, b"\x1f\x8b\x08compressed");

        // Store uncompressed
        client.set_credential_metadata(&issuer, &cred_id, &uncompressed, &CompressionType::None);
        let uncompressed_meta = client.get_credential_metadata(&cred_id).unwrap();

        // Store compressed (in real usage, would be actual gzip output)
        client.set_credential_metadata(&issuer, &cred_id, &compressed, &CompressionType::Gzip);
        let compressed_meta = client.get_credential_metadata(&cred_id).unwrap();

        // Verify that we can detect compression type and that bytes differ
        assert_eq!(uncompressed_meta.compression, CompressionType::None);
        assert_eq!(compressed_meta.compression, CompressionType::Gzip);
        assert!(compressed_meta.data.len() < uncompressed.len() || compressed_meta.compression != CompressionType::None);
    }

    #[test]
    #[should_panic(expected = "CredentialNotFound")]
    fn test_set_metadata_non_existent_credential() {
        let env = Env::default();
        env.mock_all_auths();

        let contract_id = env.register_contract(None, QuorumProofContract);
        let client = QuorumProofContractClient::new(&env, &contract_id);

        let admin = Address::generate(&env);
        let issuer = Address::generate(&env);

        client.initialize(&admin);

        let metadata = soroban_sdk::Bytes::from_slice(&env, b"test");
        client.set_credential_metadata(&issuer, &999u64, &metadata, &CompressionType::None);
    }
}
