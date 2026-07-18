//! Tests for the paginated/chunked migration protocol (`migration.rs` +
//! `QuorumProofContract::{start_metadata_migration, migrate_next_chunk, get_migration_job}`).
//!
//! Covers:
//!   - multi-step completion of a large synthetic dataset (many chunks, not one)
//!   - idempotency: re-running a completed job, or mixing the old batch entrypoint
//!     with the new cursor entrypoint over the same range, is a safe no-op
//!   - crash/restart semantics: repeating the exact same call an orchestrator would
//!     replay after a crash never reprocesses or loses items
//!   - reads and writes remaining available (and correct) while a migration is
//!     partway through

#[cfg(test)]
mod migration_tests {
    use crate::migration::MigrationStatus;
    use crate::{CompressionType, QuorumProofContract, QuorumProofContractClient};
    use soroban_sdk::{testutils::Address as _, Address, Bytes, Env};

    fn setup(env: &Env) -> (QuorumProofContractClient<'_>, Address) {
        env.mock_all_auths();
        let contract_id = env.register_contract(None, QuorumProofContract);
        let client = QuorumProofContractClient::new(env, &contract_id);
        let admin = Address::generate(env);
        client.initialize(&admin);
        (client, admin)
    }

    fn register_and_activate_v2(client: &QuorumProofContractClient<'_>, env: &Env, admin: &Address) {
        let hash = Bytes::from_slice(env, b"v2-hash");
        let desc = Bytes::from_slice(env, b"v2");
        client.register_metadata_schema(admin, &2u32, &hash, &desc);
        client.set_active_metadata_schema(admin, &2u32);
    }

    /// Issue `n` credentials under schema v1, each with metadata set, so each one
    /// is a real candidate for the v1 -> v2 migration below.
    fn issue_credentials_with_metadata(
        env: &Env,
        client: &QuorumProofContractClient<'_>,
        issuer: &Address,
        subject: &Address,
        n: u64,
    ) -> u64 {
        // Setup represents pre-existing chain history, not the migration
        // transaction under test, so it isn't bound by a single invocation's
        // CPU/memory ceiling (Env::default() otherwise ships with that same
        // realistic ceiling active, matching Soroban's real per-invocation
        // budget) — give it an unlimited budget.
        env.budget().reset_unlimited();
        let meta = Bytes::from_slice(env, b"QmTestHash000000000000000000000000");
        let mut last_id = 0u64;
        for i in 0..n {
            let id = client.issue_credential(issuer, subject, &1u32, &meta, &None, &0u64);
            let data = Bytes::from_slice(env, &[b"metadata-for-cred-", &i.to_be_bytes()[..]].concat());
            client.set_credential_metadata(issuer, &id, &data, &CompressionType::None);
            last_id = id;
        }
        last_id
    }

    // ── Large synthetic dataset: multi-step completion ──────────────────────

    #[test]
    fn test_chunked_migration_completes_over_many_steps_on_large_dataset() {
        let env = Env::default();
        let (client, admin) = setup(&env);
        let issuer = Address::generate(&env);
        let subject = Address::generate(&env);

        // Large enough that it cannot complete in a single chunk: chunk_size
        // 50 forces at least 10 separate `migrate_next_chunk` invocations to
        // fully migrate (well under migration::MAX_CHUNK_SIZE's cap of 200,
        // which is a hard ceiling/circuit-breaker on any one invocation, not
        // a claim that 200 itself is a safe chunk size for every deployment —
        // see test_single_shot_batch_migration_exceeds_a_single_invocation_budget
        // and docs/contract-upgrade-strategy.md for why the real per-item
        // cost has to be measured on testnet, not assumed).
        const TOTAL: u64 = 500;
        issue_credentials_with_metadata(&env, &client, &issuer, &subject, TOTAL);

        register_and_activate_v2(&client, &env, &admin);

        let job = client.start_metadata_migration(&admin, &2u32);
        assert_eq!(job.total_items, TOTAL);
        assert_eq!(job.cursor, 1);
        assert_eq!(job.status, MigrationStatus::InProgress);

        let mut steps = 0u32;
        let mut latest = job;
        while latest.status != MigrationStatus::Completed {
            latest = client.migrate_next_chunk(&admin, &2u32, &50u32);
            steps += 1;
            assert!(steps <= 200, "migration should complete well within 200 steps");
        }

        assert!(steps >= 10, "a 500-item dataset with chunk_size 50 must take >= 10 steps, took {steps}");
        assert_eq!(latest.cursor, TOTAL + 1);
        assert_eq!(latest.migrated_count, TOTAL);
        assert_eq!(latest.skipped_count, 0);
        assert!(latest.completed_at.is_some());

        // Every credential must now report the target schema version, and its
        // metadata must still be readable.
        for i in 1..=TOTAL {
            assert_eq!(client.get_credential_metadata_schema(&i), 2u32);
            assert!(client.get_credential_metadata(&i).is_some());
        }
    }

    /// The whole reason a paginated cursor protocol is needed: a single-shot
    /// migration over a large-enough dataset must not fit in one invocation's
    /// budget. Empirically, on this contract's cost profile, a few dozen
    /// credentials in one call is already enough to exceed the default
    /// per-invocation budget (Env::default() models Soroban's real
    /// per-invocation CPU/memory ceiling) — 200 gives comfortable headroom
    /// above that without needing a slow multi-thousand-credential setup.
    #[test]
    fn test_single_shot_batch_migration_exceeds_a_single_invocation_budget() {
        let env = Env::default();
        let (client, admin) = setup(&env);
        let issuer = Address::generate(&env);
        let subject = Address::generate(&env);

        const TOTAL: u64 = 200;
        issue_credentials_with_metadata(&env, &client, &issuer, &subject, TOTAL);
        register_and_activate_v2(&client, &env, &admin);

        // Give this one call a realistic, freshly-reset per-invocation budget,
        // exactly like a single real transaction would get on-chain.
        env.budget().reset_default();
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            client.migrate_metadata_schema(&admin, &2u32, &1u64, &TOTAL);
        }));
        assert!(
            result.is_err(),
            "migrating {TOTAL} records in a single invocation must exceed the budget ceiling"
        );

        // Heal the budget before this Env is dropped — the SDK's own drop-time
        // ledger-snapshot bookkeeping is itself budget-metered, so leaving the
        // budget exhausted here would panic again during cleanup.
        env.budget().reset_unlimited();
    }

    #[test]
    fn test_chunk_size_is_clamped_server_side() {
        let env = Env::default();
        let (client, admin) = setup(&env);
        let issuer = Address::generate(&env);
        let subject = Address::generate(&env);
        issue_credentials_with_metadata(&env, &client, &issuer, &subject, 500);
        register_and_activate_v2(&client, &env, &admin);

        client.start_metadata_migration(&admin, &2u32);
        // Ask for a chunk far larger than migration::MAX_CHUNK_SIZE (200); the
        // contract must clamp it rather than trying to walk all 500 in one call.
        let job = client.migrate_next_chunk(&admin, &2u32, &100_000u32);
        assert_eq!(job.cursor, 201, "chunk must be clamped to MAX_CHUNK_SIZE (200)");
        assert_eq!(job.migrated_count, 200);
        assert_eq!(job.status, MigrationStatus::InProgress);
    }

    // ── Idempotency ──────────────────────────────────────────────────────────

    #[test]
    fn test_completed_job_is_permanent_noop() {
        let env = Env::default();
        let (client, admin) = setup(&env);
        let issuer = Address::generate(&env);
        let subject = Address::generate(&env);
        issue_credentials_with_metadata(&env, &client, &issuer, &subject, 10);
        register_and_activate_v2(&client, &env, &admin);

        client.start_metadata_migration(&admin, &2u32);
        let completed = client.migrate_next_chunk(&admin, &2u32, &50u32);
        assert_eq!(completed.status, MigrationStatus::Completed);

        // Re-running against a completed job — exactly what a restarted
        // orchestrator that doesn't know the job already finished would do —
        // must return the identical job untouched, not re-scan or re-count.
        let replayed = client.migrate_next_chunk(&admin, &2u32, &50u32);
        assert_eq!(replayed.cursor, completed.cursor);
        assert_eq!(replayed.migrated_count, completed.migrated_count);
        assert_eq!(replayed.skipped_count, completed.skipped_count);
        assert_eq!(replayed.updated_at, completed.updated_at);
        assert_eq!(replayed.completed_at, completed.completed_at);
    }

    #[test]
    fn test_starting_an_existing_job_again_does_not_reset_progress() {
        let env = Env::default();
        let (client, admin) = setup(&env);
        let issuer = Address::generate(&env);
        let subject = Address::generate(&env);
        issue_credentials_with_metadata(&env, &client, &issuer, &subject, 300);
        register_and_activate_v2(&client, &env, &admin);

        client.start_metadata_migration(&admin, &2u32);
        client.migrate_next_chunk(&admin, &2u32, &100u32); // cursor -> 101

        // Simulate an orchestrator that crashed before recording that "start" had
        // already run, and unconditionally calls start again on restart.
        let resumed = client.start_metadata_migration(&admin, &2u32);
        assert_eq!(resumed.cursor, 101, "start_metadata_migration must not reset an in-flight job");
        assert_eq!(resumed.migrated_count, 100);
    }

    #[test]
    fn test_replayed_chunk_call_after_crash_never_reprocesses_items() {
        let env = Env::default();
        let (client, admin) = setup(&env);
        let issuer = Address::generate(&env);
        let subject = Address::generate(&env);
        issue_credentials_with_metadata(&env, &client, &issuer, &subject, 300);
        register_and_activate_v2(&client, &env, &admin);

        client.start_metadata_migration(&admin, &2u32);
        let first = client.migrate_next_chunk(&admin, &2u32, &100u32); // ids 1..100
        assert_eq!(first.cursor, 101);
        assert_eq!(first.migrated_count, 100);

        // "Crash" here: the orchestrator has no memory of what it already sent,
        // only that migration_id 2 exists, and issues the exact same call shape
        // again. Because the contract derives its start position from the
        // on-chain cursor (now 101), this must continue into 101..200 rather
        // than reprocessing 1..100.
        let second = client.migrate_next_chunk(&admin, &2u32, &100u32); // ids 101..200
        assert_eq!(second.cursor, 201);
        assert_eq!(second.migrated_count, 200, "total migrated must be additive, not doubled");
        assert_eq!(second.skipped_count, 0);

        for i in 1..=200u64 {
            assert_eq!(client.get_credential_metadata_schema(&i), 2u32);
        }
        // Not-yet-reached items remain at the pre-migration schema version.
        for i in 201..=300u64 {
            assert_eq!(client.get_credential_metadata_schema(&i), 1u32);
        }
    }

    #[test]
    fn test_old_batch_entrypoint_and_new_cursor_entrypoint_are_mutually_idempotent() {
        let env = Env::default();
        let (client, admin) = setup(&env);
        let issuer = Address::generate(&env);
        let subject = Address::generate(&env);
        issue_credentials_with_metadata(&env, &client, &issuer, &subject, 50);
        register_and_activate_v2(&client, &env, &admin);

        // Fully migrate via the new chunked engine.
        client.start_metadata_migration(&admin, &2u32);
        let job = client.migrate_next_chunk(&admin, &2u32, &100u32);
        assert_eq!(job.status, MigrationStatus::Completed);
        assert_eq!(job.migrated_count, 50);

        // Re-running the OLD single-shot batch migration over the same range
        // must find nothing left to do — the per-item schema marker, not which
        // entrypoint touched it, is what idempotency is keyed on.
        let migrated_again = client.migrate_metadata_schema(&admin, &2u32, &1u64, &50u64);
        assert_eq!(migrated_again, 0, "already-migrated credentials must not be re-migrated");
    }

    // ── Read/write availability during an in-progress migration ─────────────

    #[test]
    fn test_reads_and_writes_available_mid_migration() {
        let env = Env::default();
        let (client, admin) = setup(&env);
        let issuer = Address::generate(&env);
        let subject = Address::generate(&env);
        issue_credentials_with_metadata(&env, &client, &issuer, &subject, 30);
        register_and_activate_v2(&client, &env, &admin);

        client.start_metadata_migration(&admin, &2u32);
        let job = client.migrate_next_chunk(&admin, &2u32, &10u32); // migrates ids 1..10 only
        assert_eq!(job.status, MigrationStatus::InProgress);
        assert_eq!(job.cursor, 11);

        // The contract is not paused by an in-progress migration.
        assert!(!client.is_paused());

        // Reads succeed for both already-migrated (1..10) and not-yet-migrated
        // (11..30) ranges, and return intact data either way.
        for id in 1..=30u64 {
            let cred = client.get_credential(&id);
            assert_eq!(cred.subject, subject);
            assert_eq!(cred.issuer, issuer);
            assert!(client.get_credential_metadata(&id).is_some());
        }

        // Writes to not-yet-migrated records still succeed mid-migration...
        let new_data = Bytes::from_slice(&env, b"updated-while-migration-in-flight");
        client.set_credential_metadata(&issuer, &20u64, &new_data, &CompressionType::None);
        assert_eq!(client.get_credential_metadata(&20u64).unwrap().data, new_data);

        // ...and brand-new writes (new credentials) succeed too, landing directly
        // at the currently-active schema version without needing migration.
        let fresh_meta = Bytes::from_slice(&env, b"brand-new-credential");
        let new_id = client.issue_credential(&issuer, &subject, &1u32, &fresh_meta, &None, &1u64);
        assert_eq!(client.get_credential_metadata_schema(&new_id), 2u32);

        // The migration can still be resumed and completed afterwards, on top of
        // the concurrent writes above.
        let mut latest = job;
        while latest.status != MigrationStatus::Completed {
            latest = client.migrate_next_chunk(&admin, &2u32, &10u32);
        }
        assert_eq!(latest.migrated_count, 30);
    }

    // ── Auth / error paths ───────────────────────────────────────────────────

    #[test]
    fn test_get_migration_job_before_start_returns_none() {
        let env = Env::default();
        let (client, _admin) = setup(&env);
        assert!(client.get_migration_job(&2u32).is_none());
    }

    #[test]
    fn test_migrate_next_chunk_missing_job_panics() {
        let env = Env::default();
        let (client, admin) = setup(&env);
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            client.migrate_next_chunk(&admin, &99u32, &10u32);
        }));
        assert!(result.is_err(), "migrating a job that was never started must panic");
    }

    #[test]
    fn test_start_migration_requires_admin() {
        let env = Env::default();
        let (client, _admin) = setup(&env);
        register_and_activate_v2(&client, &env, &_admin);
        let stranger = Address::generate(&env);
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            client.start_metadata_migration(&stranger, &2u32);
        }));
        assert!(result.is_err(), "non-admin must not start a migration");
    }

    #[test]
    fn test_migrate_next_chunk_requires_admin() {
        let env = Env::default();
        let (client, admin) = setup(&env);
        register_and_activate_v2(&client, &env, &admin);
        client.start_metadata_migration(&admin, &2u32);

        let stranger = Address::generate(&env);
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            client.migrate_next_chunk(&stranger, &2u32, &10u32);
        }));
        assert!(result.is_err(), "non-admin must not advance a migration");
    }

    #[test]
    fn test_zero_item_job_completes_immediately() {
        let env = Env::default();
        let (client, admin) = setup(&env);
        register_and_activate_v2(&client, &env, &admin);

        // No credentials issued at all — total_items snapshot is 0.
        let job = client.start_metadata_migration(&admin, &2u32);
        assert_eq!(job.status, MigrationStatus::Completed);
        assert_eq!(job.total_items, 0);
        assert!(job.completed_at.is_some());
    }
}
