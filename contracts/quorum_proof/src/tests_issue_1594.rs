/// Tests for Issue #1594: Conditional Attestation (If-Then)
#[cfg(test)]
mod tests_conditional_attestation {
    use super::*;

    #[test]
    fn test_create_conditional_attestation_tree() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register_contract(None, QuorumProofContract);
        let client = QuorumProofContractClient::new(&env, &contract_id);
        let admin = Address::generate(&env);

        client.initialize(&admin);

        let creator = Address::generate(&env);
        let slice_id = 1u64;
        let root_condition_id = 1u64;

        let tree_id = client.create_conditional_attestation_tree(&creator, &slice_id, &root_condition_id);
        assert!(tree_id > 0);
    }

    #[test]
    fn test_add_condition_predicate() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register_contract(None, QuorumProofContract);
        let client = QuorumProofContractClient::new(&env, &contract_id);
        let admin = Address::generate(&env);

        client.initialize(&admin);

        let caller = Address::generate(&env);
        let predicate_type = 1u32; // AttestorPresent
        let condition_id = client.add_condition_predicate(
            &caller,
            &predicate_type,
            &None,
            &None,
            &Vec::new(&env),
        );

        assert!(condition_id > 0);
    }

    #[test]
    fn test_evaluate_condition() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register_contract(None, QuorumProofContract);
        let client = QuorumProofContractClient::new(&env, &contract_id);
        let admin = Address::generate(&env);

        client.initialize(&admin);

        let caller = Address::generate(&env);
        let attestor = Address::generate(&env);
        let predicate_type = 1u32;
        let condition_id = client.add_condition_predicate(
            &caller,
            &predicate_type,
            &Some(attestor.clone()),
            &None,
            &Vec::new(&env),
        );

        let credential_id = 1u64;
        let mut attestors = Vec::new(&env);
        attestors.push_back(attestor);

        let result = client.evaluate_condition(&credential_id, &condition_id, &attestors);
        assert!(result.is_satisfied);
    }
}
