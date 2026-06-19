#[cfg(test)]
mod weighted_voting_tests {
    use crate::{QuorumProofContract, QuorumProofContractClient, ThresholdType};
    use soroban_sdk::{testutils::Address as _, vec, Address, Bytes, Env, Vec};

    fn setup(env: &Env) -> QuorumProofContractClient<'_> {
        env.mock_all_auths_allowing_non_root_auth();
        let contract_id = env.register_contract(None, QuorumProofContract);
        let client = QuorumProofContractClient::new(env, &contract_id);
        client.initialize(&Address::generate(env));
        client
    }

    fn issue(client: &QuorumProofContractClient<'_>, env: &Env) -> u64 {
        client.issue_credential(
            &Address::generate(env),
            &Address::generate(env),
            &1,
            &Bytes::from_slice(env, b"weighted-voting"),
            &None,
            &0,
        )
    }

    #[test]
    fn weighted_absolute_consensus_uses_trust_not_headcount() {
        let env = Env::default();
        let client = setup(&env);
        let creator = Address::generate(&env);
        let licensing_body = Address::generate(&env);
        let employer = Address::generate(&env);
        let peer = Address::generate(&env);
        let attestors = vec![&env, licensing_body.clone(), employer.clone(), peer];
        let weights = vec![&env, 2u32, 1u32, 1u32];
        let slice_id = client.create_slice(&creator, &attestors, &weights, &3);
        let credential_id = issue(&client, &env);

        client.attest(&licensing_body, &credential_id, &slice_id, &true, &None);
        assert!(!client.is_attested(&credential_id, &slice_id));
        client.attest(&employer, &credential_id, &slice_id, &true, &None);
        assert!(client.is_attested(&credential_id, &slice_id));
    }

    #[test]
    fn percentage_threshold_rounds_up_and_supports_supermajority() {
        let env = Env::default();
        let client = setup(&env);
        let creator = Address::generate(&env);
        let first = Address::generate(&env);
        let second = Address::generate(&env);
        let third = Address::generate(&env);
        let attestors = vec![&env, first.clone(), second.clone(), third.clone()];
        let weights = vec![&env, 2u32, 1u32, 2u32];
        let slice_id = client.create_slice_percentage(&creator, &attestors, &weights, &67);
        let config = client.get_slice_threshold_config(&slice_id);
        assert_eq!(config.threshold_type, ThresholdType::Percentage);
        assert_eq!(config.required_weight, 4); // ceil(5 * 67 / 100)

        let credential_id = issue(&client, &env);
        client.attest(&first, &credential_id, &slice_id, &true, &None);
        client.attest(&second, &credential_id, &slice_id, &true, &None);
        assert!(!client.is_attested(&credential_id, &slice_id));
        client.attest(&third, &credential_id, &slice_id, &true, &None);
        assert!(client.is_attested(&credential_id, &slice_id));
    }

    #[test]
    fn weight_changes_do_not_revalue_existing_attestations() {
        let env = Env::default();
        let client = setup(&env);
        let creator = Address::generate(&env);
        let first = Address::generate(&env);
        let second = Address::generate(&env);
        let attestors = vec![&env, first.clone(), second.clone()];
        let weights = vec![&env, 2u32, 1u32];
        let slice_id = client.create_slice(&creator, &attestors, &weights, &3);
        let credential_id = issue(&client, &env);

        client.attest(&first, &credential_id, &slice_id, &true, &None);
        client.update_attestor_weight(&creator, &slice_id, &first, &100);
        assert!(!client.is_attested(&credential_id, &slice_id));
        client.attest(&second, &credential_id, &slice_id, &true, &None);
        assert!(client.is_attested(&credential_id, &slice_id));

        let audit = client.get_weight_audit(&slice_id);
        assert_eq!(audit.len(), 1);
        assert_eq!(audit.get(0).unwrap().old_weight, 2);
        assert_eq!(audit.get(0).unwrap().new_weight, 100);
    }

    #[test]
    fn creator_only_weight_management_is_enforced() {
        let env = Env::default();
        let client = setup(&env);
        let creator = Address::generate(&env);
        let attacker = Address::generate(&env);
        let attestor = Address::generate(&env);
        let slice_id = client.create_slice(
            &creator,
            &vec![&env, attestor.clone()],
            &vec![&env, 10u32],
            &5,
        );

        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            client.update_attestor_weight(&attacker, &slice_id, &attestor, &20);
        }));
        assert!(result.is_err());
        assert_eq!(client.get_slice(&slice_id).weights.get(0).unwrap(), 10);
    }

    #[test]
    fn consensus_and_metrics_cover_five_to_twenty_attestors() {
        for count in 5u32..=20 {
            let env = Env::default();
            let client = setup(&env);
            let creator = Address::generate(&env);
            let mut attestors = Vec::new(&env);
            let mut weights = Vec::new(&env);
            let mut expected_total = 0u32;
            for index in 0..count {
                attestors.push_back(Address::generate(&env));
                let weight = (index % 100) + 1;
                weights.push_back(weight);
                expected_total += weight;
            }
            let slice_id = client.create_slice(&creator, &attestors, &weights, &expected_total);
            let metrics = client.get_weight_distribution(&slice_id);
            assert_eq!(metrics.attestor_count, count);
            assert_eq!(metrics.total_weight, expected_total);
            assert_eq!(metrics.minimum_weight, 1);
            assert_eq!(metrics.maximum_weight, count);
            assert_eq!(metrics.average_weight, expected_total / count);

            let credential_id = issue(&client, &env);
            for index in 0..count {
                let attestor = attestors.get(index).unwrap();
                client.attest(&attestor, &credential_id, &slice_id, &true, &None);
                assert_eq!(
                    client.is_attested(&credential_id, &slice_id),
                    index + 1 == count
                );
            }
        }
    }

    #[test]
    fn rejects_out_of_range_weights_and_thresholds() {
        let env = Env::default();
        let client = setup(&env);
        let creator = Address::generate(&env);
        let attestor = Address::generate(&env);

        for weight in [0u32, 101u32] {
            let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                client.create_slice(
                    &creator,
                    &vec![&env, attestor.clone()],
                    &vec![&env, weight],
                    &1,
                );
            }));
            assert!(result.is_err());
        }

        for percentage in [0u32, 101u32] {
            let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                client.create_slice_percentage(
                    &creator,
                    &vec![&env, attestor.clone()],
                    &vec![&env, 1u32],
                    &percentage,
                );
            }));
            assert!(result.is_err());
        }
    }

    #[test]
    fn creator_can_switch_between_percentage_and_absolute_thresholds() {
        let env = Env::default();
        let client = setup(&env);
        let creator = Address::generate(&env);
        let attestors = vec![&env, Address::generate(&env), Address::generate(&env)];
        let slice_id = client.create_slice(&creator, &attestors, &vec![&env, 2u32, 1u32], &2);

        client.update_percentage_threshold(&creator, &slice_id, &67);
        let percentage = client.get_slice_threshold_config(&slice_id);
        assert_eq!(percentage.threshold_type, ThresholdType::Percentage);
        assert_eq!(percentage.required_weight, 3);

        client.update_slice_threshold(&creator, &slice_id, &1);
        let absolute = client.get_slice_threshold_config(&slice_id);
        assert_eq!(absolute.threshold_type, ThresholdType::Absolute);
        assert_eq!(absolute.required_weight, 1);
    }

    #[test]
    fn negative_attestation_contributes_no_weight() {
        let env = Env::default();
        let client = setup(&env);
        let creator = Address::generate(&env);
        let attestor = Address::generate(&env);
        let slice_id = client.create_slice(
            &creator,
            &vec![&env, attestor.clone()],
            &vec![&env, 100u32],
            &100,
        );
        let credential_id = issue(&client, &env);
        client.attest(&attestor, &credential_id, &slice_id, &false, &None);
        assert!(!client.is_attested(&credential_id, &slice_id));
    }
}
