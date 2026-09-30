# Migration Testing Guide

How to prove a version migration — and its rollback — works **before** you
run it against production (issue #1641). Companion to
[migration-guides.md](./migration-guides.md), which describes the migrations
themselves.

A migration is ready to run only when all five stages below have passed.

| Stage | What it proves | Where |
|---|---|---|
| 1. Static checks | The new code can still read the old storage and error codes | Local + CI |
| 2. Automated tests | Migration logic, invariants and rollback work on synthetic state | Local + CI |
| 3. Testnet rehearsal | The migration works on real WASM with production-shaped data | Testnet |
| 4. Rollback rehearsal | You can get back to the previous version | Testnet |
| 5. Go / no-go review | Results recorded and signed off | Release PR |

---

## 1. Static checks

```bash
# Storage keys, struct fields, error codes and public signatures vs. the deployed tag
python3 scripts/upgrade/check_state_compat.py --base <deployed-tag>
```

Any **error** severity finding blocks the migration until it has a planned
migration step or is reverted. Details:
[upgrade-testing.md](./upgrade-testing.md#1-static-state-compatibility-check).

---

## 2. Automated tests

| Migration | Tests | Run |
|---|---|---|
| Contract WASM upgrade | `contracts/integration_tests/src/upgrade_simulation.rs`, `upgrade_safety.rs`, `contract_upgrade_testing.rs` | `cargo test -p integration_tests upgrade` |
| State / schema migrations | Unit tests in `contracts/quorum_proof/src/migration_v2.rs`; invariants in [migration-invariants.md](./migration-invariants.md) | `cargo test -p quorum_proof migration` |
| Database migrations | `db-migrations` workflow: up → rollback → up against real Postgres | `.github/workflows/db-migrations.yml` |
| API v1 → v2 | Contract tests and snapshots for both versions | `cd api-server && npm test` |

Every new migration must add tests that cover:

- **Happy path:** state before → migrate → expected state after.
- **Invariants:** credential count, attestations and SBT ownership unchanged
  (see [migration-invariants.md](./migration-invariants.md)).
- **Resumability:** interrupt a chunked migration midway, resume, and check
  no item is skipped or processed twice.
- **Idempotency:** calling a completed migration again is a no-op or rejected.
- **Authorization:** non-admin callers are rejected.
- **Rollback:** the rollback path restores the previous version and state.

---

## 3. Rehearse on testnet

1. Deploy the **currently released** WASM to testnet
   (`./scripts/deploy_testnet.sh`).
2. Load production-shaped data: export a state snapshot
   (`python3 scripts/export_state.py`) and seed testnet with a comparable
   number of credentials, slices and attestations.
3. Take a backup (`./scripts/backup.sh`), exactly as you will in production.
4. Run the migration using the **same commands** from
   [migration-guides.md](./migration-guides.md) that you will use on mainnet.
5. Record:
   - wall-clock time and number of transactions (chunk migrations),
   - fees spent,
   - `get_migration_status` at the end (`failed_items` must be `0`),
   - `validate_migration_integrity` result.
6. Run `./scripts/testnet_smoke_test.sh` and the E2E suite
   ([E2E_TESTING.md](./E2E_TESTING.md)).
7. **Kill test:** restart `scripts/migration_orchestrator.py` mid-run at
   least once and confirm it resumes from the on-chain checkpoint.

---

## 4. Rehearse the rollback

Run the rollback for real on testnet — a rollback that has never been
exercised is not a rollback plan.

```bash
./scripts/test_upgrade_rollback.sh   # automated WASM upgrade → rollback cycle
```

Then, for the migration being shipped:

- **Chunked schema migration:** start it, `pause_migration`, call
  `rollback_migration`, and confirm `get_schema_version` is back to `1`.
- **Completed migration:** perform a restore from the step-3 backup
  (`./scripts/restore_from_backup.sh`) and confirm state matches the
  pre-migration snapshot (`./scripts/reconcile_state.sh`).
- **WASM:** revert to the previous hash and confirm the old code still reads
  the (rolled-back) state.
- **Database:** `npm run migrate:rollback` then `npm run migrate` again.

---

## 5. Go / no-go

Paste this into the release PR and fill it in:

```markdown
### Migration test report — <release>

- [ ] Static compatibility check: no errors (base: <tag>)
- [ ] Automated tests pass (links to CI runs)
- [ ] Testnet rehearsal: <N> items, <T> minutes, <F> XLM fees, 0 failed items
- [ ] Orchestrator kill/resume tested
- [ ] Rollback rehearsed: <which paths>
- [ ] Backup taken and verified in the target environment
- [ ] Migration guide section added/updated in docs/migration-guides.md
- Approved by: <admin 1>, <admin 2>
```

Do not proceed to mainnet if any box is unchecked.

See also: [upgrade-testing.md](./upgrade-testing.md) ·
[contract-upgrade-checklist.md](./contract-upgrade-checklist.md) ·
[database-migrations.md](./database-migrations.md)
