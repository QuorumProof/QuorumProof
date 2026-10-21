/// Tests for Issue #1731: the V1→V2 migration transforms real credential records,
/// fails records that do not validate, and records those failures in `ValidationErrors`.
#[cfg(test)]
mod tests_v1_to_v2_transform {
    use super::*;
    use crate::migration_v2::{self, DataKeyMigrationV2, MigrationStatus};

    struct Fixture<'a> {
        env: Env,
        client: QuorumProofContractClient<'a>,
        contract_id: Address,
        admin: Address,
        issuer: Address,
        subject: Address,
    }

    fn setup<'a>() -> Fixture<'a> {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register_contract(None, QuorumProofContract);
        let client = QuorumProofContractClient::new(&env, &contract_id);
        let admin = Address::generate(&env);
        client.initialize(&admin);
        client.init_migration_v2(&admin);

        let issuer = Address::generate(&env);
        let subject = Address::generate(&env);
        Fixture {
            env,
            client,
            contract_id,
            admin,
            issuer,
            subject,
        }
    }

    /// Issue a real V1 credential through the public API.
    fn issue(f: &Fixture, credential_type: u32, tag: &[u8]) -> u64 {
        let metadata = Bytes::from_slice(&f.env, tag);
        f.client
            .issue_credential(&f.issuer, &f.subject, &credential_type, &metadata, &None, &0u64)
    }

    /// Corrupt a stored credential so it fails V2 validation.
    fn set_credential_type(f: &Fixture, credential_id: u64, credential_type: u32) {
        let env = &f.env;
        env.as_contract(&f.contract_id, || {
            let mut credential: Credential = env
                .storage()
                .instance()
                .get(&DataKey::Credential(credential_id))
                .unwrap();
            credential.credential_type = credential_type;
            env.storage()
                .instance()
                .set(&DataKey::Credential(credential_id), &credential);
        });
    }

    fn validation_errors(f: &Fixture, job_id: u32) -> Vec<(u64, String)> {
        f.env.as_contract(&f.contract_id, || {
            f.env
                .storage()
                .persistent()
                .get(&DataKeyMigrationV2::ValidationErrors(job_id))
                .unwrap_or(Vec::new(&f.env))
        })
    }

    fn version_tag(f: &Fixture, credential_id: u64) -> Option<String> {
        f.env.as_contract(&f.contract_id, || {
            migration_v2::get_credential_version_tag(&f.env, credential_id)
        })
    }

    #[test]
    fn test_v1_records_migrate_to_v2() {
        let f = setup();
        let ids = [
            issue(&f, 1, b"degree_hash_001"),
            issue(&f, 2, b"license_hash_02"),
            issue(&f, 3, b"experience_hash"),
        ];

        assert_eq!(f.client.get_schema_version(), 1);
        let job_id = f.client.start_migration_v1_to_v2(&f.admin);
        assert_eq!(job_id, 2);

        let checkpoint = f.client.migrate_chunk_v1_to_v2(&f.admin, &200u32);
        assert_eq!(checkpoint.total_items, 3);
        assert_eq!(checkpoint.migrated_items, 3);
        assert_eq!(checkpoint.failed_items, 0);
        assert_eq!(checkpoint.status, MigrationStatus::Completed);

        assert_eq!(f.client.get_schema_version(), 2);
        assert!(f.client.validate_migration_integrity());
        for id in ids {
            assert_eq!(version_tag(&f, id), Some(String::from_str(&f.env, "v2")));
        }
        assert_eq!(validation_errors(&f, job_id).len(), 0);
    }

    #[test]
    fn test_migration_is_chunked_and_completes_across_calls() {
        let f = setup();
        for i in 0..5u8 {
            issue(&f, 1, &[b'h', b'0' + i]);
        }
        f.client.start_migration_v1_to_v2(&f.admin);

        let first = f.client.migrate_chunk_v1_to_v2(&f.admin, &2u32);
        assert_eq!(first.status, MigrationStatus::InProgress);
        assert_eq!(f.client.get_schema_version(), 1);

        let second = f.client.migrate_chunk_v1_to_v2(&f.admin, &2u32);
        assert_eq!(second.status, MigrationStatus::InProgress);

        let last = f.client.migrate_chunk_v1_to_v2(&f.admin, &2u32);
        assert_eq!(last.status, MigrationStatus::Completed);
        assert_eq!(last.migrated_items, 5);
        assert_eq!(f.client.get_schema_version(), 2);
    }

    #[test]
    fn test_invalid_v1_record_fails_and_is_recorded() {
        let f = setup();
        issue(&f, 1, b"good_record_hash");
        let bad = issue(&f, 2, b"will_be_corrupted");
        issue(&f, 3, b"another_good_hash");
        set_credential_type(&f, bad, 0);

        let job_id = f.client.start_migration_v1_to_v2(&f.admin);
        let checkpoint = f.client.migrate_chunk_v1_to_v2(&f.admin, &200u32);

        assert_eq!(checkpoint.migrated_items, 2);
        assert_eq!(checkpoint.failed_items, 1);
        assert_eq!(checkpoint.status, MigrationStatus::Failed);
        assert_eq!(f.client.get_schema_version(), 1);
        assert!(!f.client.validate_migration_integrity());

        assert_eq!(version_tag(&f, bad), None);
        let errors = validation_errors(&f, job_id);
        assert_eq!(errors.len(), 1);
        let (failed_id, reason) = errors.get(0).unwrap();
        assert_eq!(failed_id, bad);
        assert_eq!(
            reason,
            String::from_str(&f.env, "credential_type must be greater than 0")
        );
    }

    #[test]
    fn test_validation_errors_accumulate_across_chunks() {
        let f = setup();
        let first_bad = issue(&f, 1, b"bad_one_hash_aa");
        issue(&f, 1, b"good_middle_hash");
        let second_bad = issue(&f, 1, b"bad_two_hash_bb");
        set_credential_type(&f, first_bad, 0);
        set_credential_type(&f, second_bad, 0);

        let job_id = f.client.start_migration_v1_to_v2(&f.admin);
        // One credential per chunk, so each failure lands in a different chunk.
        for _ in 0..3 {
            f.client.migrate_chunk_v1_to_v2(&f.admin, &1u32);
        }

        let errors = validation_errors(&f, job_id);
        assert_eq!(errors.len(), 2, "failures from earlier chunks must be kept");
        assert_eq!(errors.get(0).unwrap().0, first_bad);
        assert_eq!(errors.get(1).unwrap().0, second_bad);
    }

    #[test]
    fn test_empty_registry_completes_immediately() {
        let f = setup();
        f.client.start_migration_v1_to_v2(&f.admin);

        assert_eq!(f.client.get_schema_version(), 2);
        assert!(f.client.validate_migration_integrity());
    }

    #[test]
    #[should_panic(expected = "unauthorized")]
    fn test_non_admin_cannot_start_migration() {
        let f = setup();
        issue(&f, 1, b"some_metadata_hash");
        let stranger = Address::generate(&f.env);

        f.client.start_migration_v1_to_v2(&stranger);
    }
}
