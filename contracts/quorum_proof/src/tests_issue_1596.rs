/// Tests for Issue #1596: Credential Bundling for Discounts
#[cfg(test)]
mod tests_credential_bundling {
    use super::*;

    #[test]
    fn test_create_credential_bundle_single() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register_contract(None, QuorumProofContract);
        let client = QuorumProofContractClient::new(&env, &contract_id);
        let admin = Address::generate(&env);

        client.initialize(&admin);

        let issuer = Address::generate(&env);
        let subject = Address::generate(&env);

        let metadata = Bytes::from_slice(&env, b"test_metadata_hash");
        let credential_id = client.issue_credential(&issuer, &subject, &1u32, &metadata, &None, &0u64);

        let mut credential_ids = Vec::new(&env);
        credential_ids.push_back(credential_id);

        let bundle_id = client.create_credential_bundle(&issuer, &credential_ids, &100u64);
        assert!(bundle_id > 0);
    }

    #[test]
    fn test_create_credential_bundle_small() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register_contract(None, QuorumProofContract);
        let client = QuorumProofContractClient::new(&env, &contract_id);
        let admin = Address::generate(&env);

        client.initialize(&admin);

        let issuer = Address::generate(&env);
        let subject = Address::generate(&env);

        let metadata = Bytes::from_slice(&env, b"test_metadata_hash");
        let mut credential_ids = Vec::new(&env);

        for i in 0..5 {
            let cred_id = client.issue_credential(&issuer, &subject, &(i + 1), &metadata, &None, &0u64);
            credential_ids.push_back(cred_id);
        }

        let bundle_id = client.create_credential_bundle(&issuer, &credential_ids, &100u64);
        assert!(bundle_id > 0);
    }

    #[test]
    fn test_verify_credential_bundle() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register_contract(None, QuorumProofContract);
        let client = QuorumProofContractClient::new(&env, &contract_id);
        let admin = Address::generate(&env);

        client.initialize(&admin);

        let issuer = Address::generate(&env);
        let subject = Address::generate(&env);

        let metadata = Bytes::from_slice(&env, b"test_metadata_hash");
        let credential_id = client.issue_credential(&issuer, &subject, &1u32, &metadata, &None, &0u64);

        let mut credential_ids = Vec::new(&env);
        credential_ids.push_back(credential_id);

        let bundle_id = client.create_credential_bundle(&issuer, &credential_ids, &100u64);
        let result = client.verify_credential_bundle(&bundle_id);

        assert!(result.all_valid);
        assert_eq!(result.verified_count, 1u32);
    }

    #[test]
    fn test_get_credential_bundle() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register_contract(None, QuorumProofContract);
        let client = QuorumProofContractClient::new(&env, &contract_id);
        let admin = Address::generate(&env);

        client.initialize(&admin);

        let issuer = Address::generate(&env);
        let subject = Address::generate(&env);

        let metadata = Bytes::from_slice(&env, b"test_metadata_hash");
        let credential_id = client.issue_credential(&issuer, &subject, &1u32, &metadata, &None, &0u64);

        let mut credential_ids = Vec::new(&env);
        credential_ids.push_back(credential_id);

        let bundle_id = client.create_credential_bundle(&issuer, &credential_ids, &100u64);
        let bundle = client.get_credential_bundle(&bundle_id);

        assert_eq!(bundle.id, bundle_id);
        assert_eq!(bundle.credential_ids.len(), 1);
    }
}
