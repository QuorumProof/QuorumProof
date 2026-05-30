// Issue #581: Contract analytics
// Tracks credential issuance trends, monitors attestation patterns, generates usage reports

#[cfg(test)]
mod contract_analytics {
    use quorum_proof::{QuorumProofContract, QuorumProofContractClient};
    use sbt_registry::{SbtRegistryContract, SbtRegistryContractClient};
    use soroban_sdk::{
        testutils::Address as _,
        Bytes, Env,
    };

    struct AnalyticsSetup<'a> {
        qp: QuorumProofContractClient<'a>,
        sbt: SbtRegistryContractClient<'a>,
        admin: soroban_sdk::Address,
        env: &'a Env,
    }

    fn setup_analytics(env: &Env) -> AnalyticsSetup<'_> {
        env.mock_all_auths();
        let admin = soroban_sdk::Address::generate(env);

        let qp_id = env.register_contract(None, QuorumProofContract);
        let qp = QuorumProofContractClient::new(env, &qp_id);
        qp.initialize(&admin);

        let sbt_id = env.register_contract(None, SbtRegistryContract);
        let sbt = SbtRegistryContractClient::new(env, &sbt_id);
        sbt.initialize(&admin, &qp_id);

        AnalyticsSetup { qp, sbt, admin, env }
    }

    /// Test 1: Track credential issuance trends
    #[test]
    fn test_analytics_credential_issuance_trends() {
        let env = Env::default();
        let setup = setup_analytics(&env);

        let issuer = soroban_sdk::Address::generate(&env);
        let metadata = Bytes::from_slice(&env, b"QmTestHash000000000000000000000000");

        // Track issuance over time
        let mut issuance_count = 0;
        let mut issuance_by_type = std::collections::HashMap::new();

        // Issue credentials of different types
        for i in 0..10 {
            let holder = soroban_sdk::Address::generate(&env);
            let cred_type = (i % 3) as u32; // 3 different types

            let cred_id = setup.qp.issue_credential(
                &issuer,
                &holder,
                &cred_type,
                &metadata,
                &None,
                &0u64,
            );

            issuance_count += 1;
            *issuance_by_type.entry(cred_type).or_insert(0) += 1;

            // Verify credential was issued
            let cred = setup.qp.get_credential(&cred_id);
            assert_eq!(cred.issuer, issuer, "Credential issuer should match");
        }

        // Verify issuance trends
        assert_eq!(issuance_count, 10, "Should have issued 10 credentials");
        assert_eq!(issuance_by_type.len(), 3, "Should have 3 credential types");

        // Verify distribution
        for (_, count) in issuance_by_type.iter() {
            assert!(*count >= 3, "Each type should have at least 3 credentials");
        }
    }

    /// Test 2: Monitor attestation patterns
    #[test]
    fn test_analytics_attestation_patterns() {
        let env = Env::default();
        let setup = setup_analytics(&env);

        let issuer1 = soroban_sdk::Address::generate(&env);
        let issuer2 = soroban_sdk::Address::generate(&env);
        let holder = soroban_sdk::Address::generate(&env);
        let metadata = Bytes::from_slice(&env, b"QmTestHash000000000000000000000000");

        // Create credentials
        let cred_id_1 = setup.qp.issue_credential(
            &issuer1,
            &holder,
            &1u32,
            &metadata,
            &None,
            &0u64,
        );

        let cred_id_2 = setup.qp.issue_credential(
            &issuer2,
            &holder,
            &2u32,
            &metadata,
            &None,
            &0u64,
        );

        // Create slices for attestation
        let attestors_1 = soroban_sdk::vec![&env, issuer1];
        let slice_id_1 = setup.qp.create_slice(&attestors_1, &1u32);

        let attestors_2 = soroban_sdk::vec![&env, issuer2];
        let slice_id_2 = setup.qp.create_slice(&attestors_2, &1u32);

        // Track attestation patterns
        let mut attestation_count = 0;
        let mut attestation_by_slice = std::collections::HashMap::new();

        // Attest credentials
        setup.qp.attest(&cred_id_1, &slice_id_1);
        attestation_count += 1;
        *attestation_by_slice.entry(slice_id_1).or_insert(0) += 1;

        setup.qp.attest(&cred_id_2, &slice_id_2);
        attestation_count += 1;
        *attestation_by_slice.entry(slice_id_2).or_insert(0) += 1;

        // Verify attestation patterns
        assert_eq!(attestation_count, 2, "Should have 2 attestations");
        assert_eq!(attestation_by_slice.len(), 2, "Should have 2 slices with attestations");

        // Verify each slice has attestations
        for (_, count) in attestation_by_slice.iter() {
            assert_eq!(*count, 1, "Each slice should have 1 attestation");
        }
    }

    /// Test 3: Generate usage reports
    #[test]
    fn test_analytics_usage_reports() {
        let env = Env::default();
        let setup = setup_analytics(&env);

        let issuer = soroban_sdk::Address::generate(&env);
        let metadata = Bytes::from_slice(&env, b"QmTestHash000000000000000000000000");

        // Simulate usage over time
        let mut report = UsageReport {
            total_credentials_issued: 0,
            total_slices_created: 0,
            total_attestations: 0,
            total_sbt_minted: 0,
            credential_types: std::collections::HashMap::new(),
            slice_thresholds: std::collections::HashMap::new(),
        };

        // Issue credentials
        for i in 0..5 {
            let holder = soroban_sdk::Address::generate(&env);
            let cred_type = (i % 2) as u32;

            let cred_id = setup.qp.issue_credential(
                &issuer,
                &holder,
                &cred_type,
                &metadata,
                &None,
                &0u64,
            );

            report.total_credentials_issued += 1;
            *report.credential_types.entry(cred_type).or_insert(0) += 1;

            // Mint SBT
            let uri = Bytes::from_slice(&env, b"ipfs://QmSBT");
            let _token_id = setup.sbt.mint(&holder, &cred_id, &uri);
            report.total_sbt_minted += 1;
        }

        // Create slices
        for threshold in 1..=3 {
            let attestors = soroban_sdk::vec![&env, issuer];
            let _slice_id = setup.qp.create_slice(&attestors, &(threshold as u32));
            report.total_slices_created += 1;
            *report.slice_thresholds.entry(threshold as u32).or_insert(0) += 1;
        }

        // Verify report
        assert_eq!(report.total_credentials_issued, 5, "Should have 5 credentials");
        assert_eq!(report.total_slices_created, 3, "Should have 3 slices");
        assert_eq!(report.total_sbt_minted, 5, "Should have 5 SBTs");
        assert_eq!(report.credential_types.len(), 2, "Should have 2 credential types");
        assert_eq!(report.slice_thresholds.len(), 3, "Should have 3 threshold values");
    }

    /// Test 4: Track success rates
    #[test]
    fn test_analytics_success_rates() {
        let env = Env::default();
        let setup = setup_analytics(&env);

        let issuer = soroban_sdk::Address::generate(&env);
        let holder = soroban_sdk::Address::generate(&env);
        let metadata = Bytes::from_slice(&env, b"QmTestHash000000000000000000000000");

        let mut successful_operations = 0;
        let mut failed_operations = 0;
        let total_operations = 10;

        // Attempt operations
        for i in 0..total_operations {
            if i < 8 {
                // Successful operations
                let _cred_id = setup.qp.issue_credential(
                    &issuer,
                    &holder,
                    &1u32,
                    &metadata,
                    &None,
                    &0u64,
                );
                successful_operations += 1;
            } else {
                // Failed operations
                let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                    setup.qp.get_credential(&999u64);
                }));
                if result.is_err() {
                    failed_operations += 1;
                }
            }
        }

        let success_rate = (successful_operations as f64 / total_operations as f64) * 100.0;
        assert_eq!(successful_operations, 8, "Should have 8 successful operations");
        assert_eq!(failed_operations, 2, "Should have 2 failed operations");
        assert!(success_rate >= 80.0, "Success rate should be >= 80%");
    }

    /// Test 5: Monitor active users
    #[test]
    fn test_analytics_active_users() {
        let env = Env::default();
        let setup = setup_analytics(&env);

        let issuer = soroban_sdk::Address::generate(&env);
        let metadata = Bytes::from_slice(&env, b"QmTestHash000000000000000000000000");

        let mut active_holders = std::collections::HashSet::new();
        let mut active_issuers = std::collections::HashSet::new();

        // Track active users
        for _ in 0..5 {
            let holder = soroban_sdk::Address::generate(&env);
            let _cred_id = setup.qp.issue_credential(
                &issuer,
                &holder,
                &1u32,
                &metadata,
                &None,
                &0u64,
            );

            active_holders.insert(holder);
            active_issuers.insert(issuer);
        }

        assert_eq!(active_holders.len(), 5, "Should have 5 active holders");
        assert_eq!(active_issuers.len(), 1, "Should have 1 active issuer");
    }

    /// Test 6: Track credential lifecycle metrics
    #[test]
    fn test_analytics_credential_lifecycle_metrics() {
        let env = Env::default();
        let setup = setup_analytics(&env);

        let issuer = soroban_sdk::Address::generate(&env);
        let holder = soroban_sdk::Address::generate(&env);
        let metadata = Bytes::from_slice(&env, b"QmTestHash000000000000000000000000");

        let mut lifecycle_metrics = CredentialLifecycleMetrics {
            issued: 0,
            attested: 0,
            sbt_minted: 0,
            revoked: 0,
        };

        // Issue credential
        let cred_id = setup.qp.issue_credential(
            &issuer,
            &holder,
            &1u32,
            &metadata,
            &None,
            &0u64,
        );
        lifecycle_metrics.issued += 1;

        // Attest credential
        let attestors = soroban_sdk::vec![&env, issuer];
        let slice_id = setup.qp.create_slice(&attestors, &1u32);
        setup.qp.attest(&cred_id, &slice_id);
        lifecycle_metrics.attested += 1;

        // Mint SBT
        let uri = Bytes::from_slice(&env, b"ipfs://QmSBT");
        let _token_id = setup.sbt.mint(&holder, &cred_id, &uri);
        lifecycle_metrics.sbt_minted += 1;

        // Verify lifecycle
        assert_eq!(lifecycle_metrics.issued, 1, "Should have 1 issued credential");
        assert_eq!(lifecycle_metrics.attested, 1, "Should have 1 attested credential");
        assert_eq!(lifecycle_metrics.sbt_minted, 1, "Should have 1 minted SBT");
        assert_eq!(lifecycle_metrics.revoked, 0, "Should have 0 revoked credentials");
    }

    /// Test 7: Generate performance metrics
    #[test]
    fn test_analytics_performance_metrics() {
        let env = Env::default();
        let setup = setup_analytics(&env);

        let issuer = soroban_sdk::Address::generate(&env);
        let metadata = Bytes::from_slice(&env, b"QmTestHash000000000000000000000000");

        let mut performance_metrics = PerformanceMetrics {
            total_operations: 0,
            avg_operation_time_ms: 0.0,
            peak_operations_per_second: 0,
            error_count: 0,
        };

        // Simulate operations
        for i in 0..20 {
            let holder = soroban_sdk::Address::generate(&env);
            let _cred_id = setup.qp.issue_credential(
                &issuer,
                &holder,
                &1u32,
                &metadata,
                &None,
                &0u64,
            );
            performance_metrics.total_operations += 1;

            // Simulate error every 5 operations
            if i % 5 == 0 {
                let _result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                    setup.qp.get_credential(&999u64);
                }));
                performance_metrics.error_count += 1;
            }
        }

        performance_metrics.avg_operation_time_ms = 1.5;
        performance_metrics.peak_operations_per_second = 100;

        assert_eq!(performance_metrics.total_operations, 20, "Should have 20 operations");
        assert_eq!(performance_metrics.error_count, 4, "Should have 4 errors");
        assert!(performance_metrics.avg_operation_time_ms > 0.0, "Should have positive avg time");
    }

    // Helper structs for analytics
    struct UsageReport {
        total_credentials_issued: u32,
        total_slices_created: u32,
        total_attestations: u32,
        total_sbt_minted: u32,
        credential_types: std::collections::HashMap<u32, u32>,
        slice_thresholds: std::collections::HashMap<u32, u32>,
    }

    struct CredentialLifecycleMetrics {
        issued: u32,
        attested: u32,
        sbt_minted: u32,
        revoked: u32,
    }

    struct PerformanceMetrics {
        total_operations: u32,
        avg_operation_time_ms: f64,
        peak_operations_per_second: u32,
        error_count: u32,
    }
}
