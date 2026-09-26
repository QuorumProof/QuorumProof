/// Tests for Issue #1595: Credential Transfer with Liability
#[cfg(test)]
mod tests_credential_transfer {
    use super::*;

    #[test]
    fn test_initiate_credential_transfer() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register_contract(None, QuorumProofContract);
        let client = QuorumProofContractClient::new(&env, &contract_id);
        let admin = Address::generate(&env);

        client.initialize(&admin);

        let issuer = Address::generate(&env);
        let subject = Address::generate(&env);
        let to_party = Address::generate(&env);

        let metadata = Bytes::from_slice(&env, b"test_metadata_hash");
        let credential_id = client.issue_credential(&issuer, &subject, &1u32, &metadata, &None, &0u64);

        let transfer_id = client.initiate_credential_transfer(
            &issuer,
            &credential_id,
            &to_party,
            &None,
        );

        assert!(transfer_id > 0);
    }

    #[test]
    fn test_transfer_liability() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register_contract(None, QuorumProofContract);
        let client = QuorumProofContractClient::new(&env, &contract_id);
        let admin = Address::generate(&env);

        client.initialize(&admin);

        let issuer = Address::generate(&env);
        let subject = Address::generate(&env);
        let new_responsible = Address::generate(&env);

        let metadata = Bytes::from_slice(&env, b"test_metadata_hash");
        let credential_id = client.issue_credential(&issuer, &subject, &1u32, &metadata, &None, &0u64);

        let liability_id = client.transfer_liability(
            &issuer,
            &credential_id,
            &new_responsible,
            &2u32, // TransferredToIssuer
        );

        assert!(liability_id > 0);
    }

    #[test]
    fn test_get_liability_history() {
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

        let history = client.get_liability_history(&credential_id);
        assert_eq!(history.len(), 0);
    }
}
