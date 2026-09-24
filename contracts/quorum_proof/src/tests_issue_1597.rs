/// Tests for Issue #1597: Slice Failover and Redundancy
#[cfg(test)]
mod tests_slice_failover {
    use super::*;

    #[test]
    fn test_configure_slice_redundancy() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register_contract(None, QuorumProofContract);
        let client = QuorumProofContractClient::new(&env, &contract_id);
        let admin = Address::generate(&env);

        client.initialize(&admin);

        let caller = Address::generate(&env);
        let slice_id = 1u64;
        let backup_slice_ids = Vec::new(&env);
        let failover_threshold = 1u32;

        client.configure_slice_redundancy(
            &caller,
            &slice_id,
            &backup_slice_ids,
            &failover_threshold,
        );
    }

    #[test]
    fn test_add_backup_attestor() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register_contract(None, QuorumProofContract);
        let client = QuorumProofContractClient::new(&env, &contract_id);
        let admin = Address::generate(&env);

        client.initialize(&admin);

        let caller = Address::generate(&env);
        let primary_attestor = Address::generate(&env);
        let backup_address = Address::generate(&env);

        let backup_id = client.add_backup_attestor(
            &caller,
            &primary_attestor,
            &backup_address,
            &1u32,
        );

        assert!(backup_id > 0);
    }

    #[test]
    fn test_trigger_failover() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register_contract(None, QuorumProofContract);
        let client = QuorumProofContractClient::new(&env, &contract_id);
        let admin = Address::generate(&env);

        client.initialize(&admin);

        let caller = Address::generate(&env);
        let slice_id = 1u64;
        let unavailable = Vec::new(&env);

        client.configure_slice_redundancy(
            &caller,
            &slice_id,
            &Vec::new(&env),
            &1u32,
        );

        client.trigger_failover(&caller, &slice_id, &unavailable);
    }

    #[test]
    fn test_resolve_failover() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register_contract(None, QuorumProofContract);
        let client = QuorumProofContractClient::new(&env, &contract_id);
        let admin = Address::generate(&env);

        client.initialize(&admin);

        let caller = Address::generate(&env);
        let slice_id = 1u64;

        client.configure_slice_redundancy(
            &caller,
            &slice_id,
            &Vec::new(&env),
            &1u32,
        );

        client.resolve_failover(&caller, &slice_id);
    }

    #[test]
    fn test_get_failover_status() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register_contract(None, QuorumProofContract);
        let client = QuorumProofContractClient::new(&env, &contract_id);
        let admin = Address::generate(&env);

        client.initialize(&admin);

        let slice_id = 1u64;
        let status = client.get_failover_status(&slice_id);

        assert_eq!(status.slice_id, slice_id);
    }
}
