//! Example: Soroban Contract Unit Test
//! Constructed using QuorumProof snippet: `qp-contract-test`.

#[cfg(test)]
mod test {
    use super::super::credential_attestation_contract::*;
    use soroban_sdk::{testutils::Address as _, vec, Address, Env, Vec};

    #[test]
    fn test_credential_attestation_flow() {
        let env = Env::default();
        env.mock_all_auths();

        let contract_id = env.register_contract(None, CredentialAttestationContract);
        let client = CredentialAttestationContractClient::new(&env, &contract_id);

        let admin = Address::generate(&env);
        let subject = Address::generate(&env);
        let attestor1 = Address::generate(&env);
        let attestor2 = Address::generate(&env);

        // Initialize with threshold = 50
        client.initialize(&admin, &50);

        let attestations = vec![
            &env,
            Attestation {
                attestor: attestor1,
                weight: 30,
                timestamp: 1000,
            },
            Attestation {
                attestor: attestor2,
                weight: 25,
                timestamp: 1005,
            },
        ];

        // Total weight is 55 >= 50 threshold
        let success = client.submit_attestations(&admin, &subject, &attestations);
        assert!(success);

        let recorded_weight = client.get_attestation(&subject);
        assert_eq!(recorded_weight, Some(55));
    }
}
