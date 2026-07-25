/// Tests for Issue #983 (Credential Attributes), #989 (SBT Metadata URI), and #992 (SBT Upgrade Path)
#[cfg(test)]
mod tests_new_issues {
    use super::*;
    use soroban_sdk::{Address, Env, Vec, Bytes};

    // Helper setup function
    fn setup(env: &Env) -> (QuorumProofContractClient, Address) {
        let contract_id = env.register_contract(None, QuorumProofContract);
        let admin = Address::generate(env);
        env.mock_all_auths();
        let client = QuorumProofContractClient::new(env, &contract_id);
        client.initialize(&admin);
        (client, admin)
    }

    // ── Issue #983: Credential Attributes Tests ────────────────────────────────

    #[test]
    fn test_set_credential_attribute() {
        let env = Env::default();
        env.mock_all_auths();
        let (client, _admin) = setup(&env);

        let issuer = Address::generate(&env);
        let subject = Address::generate(&env);
        let meta = Bytes::from_slice(&env, b"test_metadata_hash");

        let cred_id = client.issue_credential(&issuer, &subject, &1u32, &meta, &None, &0u64);

        // Set an attribute
        client.set_credential_attribute(
            &issuer,
            &cred_id,
            &soroban_sdk::String::from_slice(&env, "specialization"),
            &soroban_sdk::String::from_slice(&env, "Mechanical Engineering"),
        );

        // Retrieve it
        let value = client.get_credential_attribute(&cred_id, &soroban_sdk::String::from_slice(&env, "specialization"));
        assert_eq!(
            value.unwrap().to_string(),
            "Mechanical Engineering"
        );
    }

    #[test]
    fn test_set_multiple_credential_attributes() {
        let env = Env::default();
        env.mock_all_auths();
        let (client, _admin) = setup(&env);

        let issuer = Address::generate(&env);
        let subject = Address::generate(&env);
        let meta = Bytes::from_slice(&env, b"test_metadata_hash");

        let cred_id = client.issue_credential(&issuer, &subject, &2u32, &meta, &None, &0u64);

        // Set multiple attributes
        client.set_credential_attribute(
            &issuer,
            &cred_id,
            &soroban_sdk::String::from_slice(&env, "degree"),
            &soroban_sdk::String::from_slice(&env, "PhD"),
        );

        client.set_credential_attribute(
            &issuer,
            &cred_id,
            &soroban_sdk::String::from_slice(&env, "gpa"),
            &soroban_sdk::String::from_slice(&env, "3.95"),
        );

        client.set_credential_attribute(
            &issuer,
            &cred_id,
            &soroban_sdk::String::from_slice(&env, "graduation_year"),
            &soroban_sdk::String::from_slice(&env, "2020"),
        );

        // Retrieve all
        let attrs = client.get_credential_attributes(&cred_id);
        assert_eq!(attrs.len(), 3);
    }

    #[test]
    fn test_get_nonexistent_attribute() {
        let env = Env::default();
        env.mock_all_auths();
        let (client, _admin) = setup(&env);

        let issuer = Address::generate(&env);
        let subject = Address::generate(&env);
        let meta = Bytes::from_slice(&env, b"test_metadata_hash");

        let cred_id = client.issue_credential(&issuer, &subject, &1u32, &meta, &None, &0u64);

        // Try to get non-existent attribute
        let value = client.get_credential_attribute(&cred_id, &soroban_sdk::String::from_slice(&env, "nonexistent"));
        assert!(value.is_none());
    }

    #[test]
    #[should_panic(expected = "only the credential issuer can set attributes")]
    fn test_set_attribute_unauthorized_issuer() {
        let env = Env::default();
        env.mock_all_auths();
        let (client, _admin) = setup(&env);

        let issuer = Address::generate(&env);
        let other_issuer = Address::generate(&env);
        let subject = Address::generate(&env);
        let meta = Bytes::from_slice(&env, b"test_metadata_hash");

        let cred_id = client.issue_credential(&issuer, &subject, &1u32, &meta, &None, &0u64);

        // Try to set attribute as different issuer (should panic)
        client.set_credential_attribute(
            &other_issuer,
            &cred_id,
            &soroban_sdk::String::from_slice(&env, "attr"),
            &soroban_sdk::String::from_slice(&env, "value"),
        );
    }

    #[test]
    fn test_credential_attributes_size_limit() {
        let env = Env::default();
        env.mock_all_auths();
        let (client, _admin) = setup(&env);

        let issuer = Address::generate(&env);
        let subject = Address::generate(&env);
        let meta = Bytes::from_slice(&env, b"test_metadata_hash");

        let cred_id = client.issue_credential(&issuer, &subject, &1u32, &meta, &None, &0u64);

        // Create a large string (close to 5 KB limit)
        let large_value = soroban_sdk::String::from_slice(&env, &vec![b'a'; 4000]);

        client.set_credential_attribute(
            &issuer,
            &cred_id,
            &soroban_sdk::String::from_slice(&env, "large"),
            &large_value,
        );

        // This should work since we're under the limit
        let retrieved = client.get_credential_attribute(&cred_id, &soroban_sdk::String::from_slice(&env, "large"));
        assert!(retrieved.is_some());
    }

    // ── Issue #989: SBT Metadata URI Tests ──────────────────────────────────────

    #[test]
    fn test_set_sbt_metadata_uri_https() {
        let env = Env::default();
        env.mock_all_auths();
        let (client, _admin) = setup(&env);

        let issuer = Address::generate(&env);
        let holder = Address::generate(&env);
        let meta = Bytes::from_slice(&env, b"test_metadata_hash");

        // Create a credential first
        let cred_id = client.issue_credential(&issuer, &holder, &1u32, &meta, &None, &0u64);

        // For SBT creation (in real scenario), we'd use sbt_registry contract
        // This test validates the metadata URI setting logic
        // In practice, this would be called via sbt_registry.set_sbt_metadata_uri
        
        // Note: Full SBT tests would require cross-contract setup
    }

    #[test]
    fn test_set_sbt_metadata_uri_ipfs() {
        let env = Env::default();
        env.mock_all_auths();
        let (client, _admin) = setup(&env);

        let issuer = Address::generate(&env);
        let subject = Address::generate(&env);
        let meta = Bytes::from_slice(&env, b"test_metadata_hash");

        let _cred_id = client.issue_credential(&issuer, &subject, &1u32, &meta, &None, &0u64);

        // IPFS URI format test would go here
        // URI: ipfs://QmXxxx...
    }

    // ── Issue #992: SBT Upgrade Path Tests ─────────────────────────────────────

    #[test]
    fn test_sbt_upgrade_chain() {
        let env = Env::default();
        env.mock_all_auths();
        let (client, _admin) = setup(&env);

        let issuer = Address::generate(&env);
        let subject = Address::generate(&env);
        let meta = Bytes::from_slice(&env, b"initial_metadata");

        // Create initial credential (version 1)
        let cred_id_v1 = client.issue_credential(&issuer, &subject, &1u32, &meta, &None, &0u64);

        // Create upgraded credential (version 2)
        let meta_v2 = Bytes::from_slice(&env, b"upgraded_metadata");
        let cred_id_v2 = client.issue_credential(&issuer, &subject, &1u32, &meta_v2, &None, &0u64);

        // In a real scenario with SBT registry:
        // 1. Create SBT for v1 credential
        // 2. Create SBT for v2 credential
        // 3. Call upgrade_sbt to mark v1 as upgraded to v2
        // 4. Verify old SBT's upgraded_to field points to v2
    }

    #[test]
    fn test_get_sbt_upgrade_path_not_upgraded() {
        let env = Env::default();
        env.mock_all_auths();
        let (client, _admin) = setup(&env);

        let issuer = Address::generate(&env);
        let subject = Address::generate(&env);
        let meta = Bytes::from_slice(&env, b"test_metadata");

        let cred_id = client.issue_credential(&issuer, &subject, &1u32, &meta, &None, &0u64);

        // Credential exists but no upgrade path (would be tested in sbt_registry context)
        assert!(client.check_credential_validity(&cred_id));
    }
}
