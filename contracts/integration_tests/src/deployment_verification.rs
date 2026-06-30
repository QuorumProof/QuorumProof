// Issue #578: Automated deployment verification
// Verifies contract initialization, basic operations, and rollback on failure

#[cfg(test)]
mod deployment_verification {
    use quorum_proof::{QuorumProofContract, QuorumProofContractClient};
    use sbt_registry::{SbtRegistryContract, SbtRegistryContractClient};
    use zk_verifier::{ZkVerifierContract, ZkVerifierContractClient};
    use soroban_sdk::{
        testutils::Address as _,
        Bytes, BytesN, Env,
    };

    struct DeployedContracts<'a> {
        qp: QuorumProofContractClient<'a>,
        sbt: SbtRegistryContractClient<'a>,
        zk: ZkVerifierContractClient<'a>,
        admin: soroban_sdk::Address,
    }

    fn deploy_contracts(env: &Env) -> DeployedContracts<'_> {
        env.mock_all_auths();
        let admin = soroban_sdk::Address::generate(env);

        // Deploy QuorumProof contract
        let qp_id = env.register_contract(None, QuorumProofContract);
        let qp = QuorumProofContractClient::new(env, &qp_id);
        qp.initialize(&admin);

        // Deploy SBT Registry contract
        let sbt_id = env.register_contract(None, SbtRegistryContract);
        let sbt = SbtRegistryContractClient::new(env, &sbt_id);
        sbt.initialize(&admin, &qp_id);

        // Deploy ZK Verifier contract
        let zk_id = env.register_contract(None, ZkVerifierContract);
        let zk = ZkVerifierContractClient::new(env, &zk_id);
        zk.initialize(&admin);

        let vk_hash = BytesN::from_array(env, &[0u8; 32]);
        zk.set_verifying_key(&admin, &vk_hash);

        DeployedContracts { qp, sbt, zk, admin }
    }

    /// Test 1: Verify contract initialization
    #[test]
    fn test_deployment_contract_initialization() {
        let env = Env::default();
        let contracts = deploy_contracts(&env);

        // Verify QuorumProof is initialized
        let issuer = soroban_sdk::Address::generate(&env);
        let holder = soroban_sdk::Address::generate(&env);
        let metadata = Bytes::from_slice(&env, b"QmTestHash000000000000000000000000");

        // Should be able to issue credential after initialization
        let cred_id = contracts.qp.issue_credential(
            &issuer,
            &holder,
            &1u32,
            &metadata,
            &None,
            &0u64,
        );
        assert_eq!(cred_id, 1, "First credential should have ID 1");

        // Verify SBT Registry is initialized
        let uri = Bytes::from_slice(&env, b"ipfs://QmSBT");
        let token_id = contracts.sbt.mint(&holder, &cred_id, &uri);
        assert_eq!(token_id, 1, "First SBT should have ID 1");

        // Verify ZK Verifier is initialized
        let vk_hash = BytesN::from_array(&env, &[1u8; 32]);
        contracts.zk.set_verifying_key(&contracts.admin, &vk_hash);
        // If no panic, initialization succeeded
    }

    /// Test 2: Test basic operations after deployment
    #[test]
    fn test_deployment_basic_operations() {
        let env = Env::default();
        let contracts = deploy_contracts(&env);

        let issuer = soroban_sdk::Address::generate(&env);
        let holder = soroban_sdk::Address::generate(&env);
        let metadata = Bytes::from_slice(&env, b"QmTestHash000000000000000000000000");

        // Issue credential
        let cred_id = contracts.qp.issue_credential(
            &issuer,
            &holder,
            &1u32,
            &metadata,
            &None,
            &0u64,
        );

        // Retrieve credential
        let credential = contracts.qp.get_credential(&cred_id);
        assert_eq!(credential.holder, holder, "Credential holder mismatch");
        assert_eq!(credential.issuer, issuer, "Credential issuer mismatch");

        // Create quorum slice
        let attestors = soroban_sdk::vec![&env, issuer];
        let slice_id = contracts.qp.create_slice(&attestors, &1u32);
        assert_eq!(slice_id, 1, "First slice should have ID 1");

        // Attest credential
        contracts.qp.attest(&cred_id, &slice_id);
        let is_attested = contracts.qp.is_attested(&cred_id);
        assert!(is_attested, "Credential should be attested");
    }

    /// Test 3: Rollback on failure - verify state consistency
    #[test]
    fn test_deployment_rollback_on_failure() {
        let env = Env::default();
        let contracts = deploy_contracts(&env);

        let issuer = soroban_sdk::Address::generate(&env);
        let holder = soroban_sdk::Address::generate(&env);
        let metadata = Bytes::from_slice(&env, b"QmTestHash000000000000000000000000");

        // Issue first credential
        let cred_id_1 = contracts.qp.issue_credential(
            &issuer,
            &holder,
            &1u32,
            &metadata,
            &None,
            &0u64,
        );

        // Attempt invalid operation (should fail gracefully)
        let invalid_cred_id = 999u64;
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            contracts.qp.get_credential(&invalid_cred_id);
        }));
        assert!(result.is_err(), "Invalid credential retrieval should fail");

        // Verify state is consistent - first credential still exists
        let credential = contracts.qp.get_credential(&cred_id_1);
        assert_eq!(credential.holder, holder, "State should be consistent after failed operation");

        // Verify we can continue normal operations
        let cred_id_2 = contracts.qp.issue_credential(
            &issuer,
            &holder,
            &2u32,
            &metadata,
            &None,
            &0u64,
        );
        assert_eq!(cred_id_2, 2, "Should be able to issue new credential after failure");
    }

    /// Test 4: Cross-contract deployment verification
    #[test]
    fn test_deployment_cross_contract_integration() {
        let env = Env::default();
        let contracts = deploy_contracts(&env);

        let issuer = soroban_sdk::Address::generate(&env);
        let holder = soroban_sdk::Address::generate(&env);
        let metadata = Bytes::from_slice(&env, b"QmTestHash000000000000000000000000");

        // Issue credential in QuorumProof
        let cred_id = contracts.qp.issue_credential(
            &issuer,
            &holder,
            &1u32,
            &metadata,
            &None,
            &0u64,
        );

        // Mint SBT in SBT Registry
        let uri = Bytes::from_slice(&env, b"ipfs://QmSBT");
        let token_id = contracts.sbt.mint(&holder, &cred_id, &uri);

        // Verify both contracts are in sync
        assert_eq!(token_id, 1, "SBT token ID should be 1");
        assert_eq!(contracts.sbt.owner_of(&token_id), holder, "SBT owner should be holder");

        // Verify credential still exists in QuorumProof
        let credential = contracts.qp.get_credential(&cred_id);
        assert_eq!(credential.holder, holder, "Credential should still exist");
    }
}
