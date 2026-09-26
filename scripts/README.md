# scripts/ — Operational Script Index

This directory holds **29 shell and Python scripts** that span the full QuorumProof
operational lifecycle: build, test, deploy, backup/DR, migration, benchmarking, and
security scanning. This index groups them by purpose so you can find the right script
without opening every file.

Columns:

| Column | Meaning |
|---|---|
| **Script** | File name (all in `scripts/` unless otherwise noted) |
| **What it does** | One-line summary |
| **Invoked by** | CI workflow name, or `manual` for operator-run scripts |
| **Test coverage** | Corresponding test in `scripts/tests/`, if any |

---

## Build & Test

| Script | What it does | Invoked by | Test coverage |
|---|---|---|---|
| `build.sh` | Compiles all contract crates to `wasm32-unknown-unknown` via `cargo build --release` | `ci.yml` (`contracts` job) | — |
| `test.sh` | Runs `cargo test` for the full workspace | `ci.yml` (`contracts` job) | — |
| `run_e2e_tests.sh` | Runs the Soroban end-to-end test suite (`contracts/e2e_tests`) against a live testnet | `ci.yml` (`e2e-tests` job) | — |
| `coverage.sh` | Generates an LLVM/gcov coverage report for the frontend (`npm run test:coverage`) | `ci.yml` (`frontend` job) | — |
| `check_unwraps.sh` | Ratchet check — fails if new bare `.unwrap()` calls appear in contract source (issue #1391) | `ci.yml` (`contracts` job) | — |
| `check_docs_index.sh` | Verifies every `docs/*.md` file is linked from `docs/README.md` (issue #1498) | `ci.yml` (`docs-index` job) | — |
| `validate_env.sh` | Cross-checks `environments.toml` against `.env` to ensure the selected network matches the contract addresses | `manual` | — |

---

## Deploy

| Script | What it does | Invoked by | Test coverage |
|---|---|---|---|
| `deploy_testnet.sh` | Deploys all three Soroban contracts to Stellar testnet and writes contract IDs to `.env` | `testnet-deploy.yml` | — |
| `deploy_multi_region.sh` | Deploys contracts to multiple Stellar network environments in one pass (testnet + mainnet) | `manual` | — |
| `testnet_smoke_test.sh` | Post-deploy smoke tests: reads back each deployed contract to confirm it is reachable and functional | `testnet-deploy.yml` | — |
| `canary_deploy.sh` | Canary deployment pipeline — uploads new WASM, routes 10% of traffic, runs health-check soak, promotes or rolls back (issue #847) | `canary-deploy.yml` | — |
| `canary_test.sh` | Smoke-test suite invoked by `canary_deploy.sh` immediately after the canary goes live | `canary-deploy.yml` (via `canary_deploy.sh`) | — |
| `upgrade_rollback.sh` | Performs a contract upgrade with an automatic on-chain rollback if post-upgrade health checks fail (issue #595) | `manual` | — |
| `testnet_rollback.sh` | Rolls back a failed testnet CI deploy by re-deploying the last known-good WASM artifact | `testnet-deploy.yml` (on failure) | — |
| `pre_upgrade_checks.sh` | Safety gate run before any contract upgrade: validates data-migration compatibility, storage layout, and verifying-key consistency (issue #848) | `manual` / `canary-deploy.yml` | — |

---

## Backup & Disaster Recovery

| Script | What it does | Invoked by | Test coverage |
|---|---|---|---|
| `backup.sh` | Creates an encrypted, timestamped backup of on-chain contract state and uploads it to off-chain storage | `backup.yml` | — |
| `restore_from_backup.sh` | Restores contract state from an encrypted backup file by replaying `issue_credential`, `create_slice`, and `attest` calls | `manual` | — |
| `snapshot.sh` | Exports current on-chain contract state to a plain JSON snapshot in `backups/snapshots/` | `backup.yml` / `manual` | — |
| `verify_snapshot.sh` | Verifies a snapshot file is well-formed and that its credential and slice counts match current on-chain state | `backup.yml` | — |
| `verify_backup.sh` | Checks backup completeness, validates the SHA-256 checksum, and optionally runs a restore dry-run | `backup.yml` | — |
| `failover.sh` | Manages RPC endpoint failover — checks endpoint health, switches `STELLAR_RPC_URL`, verifies state consistency across endpoints | `manual` | `tests/test_failover.sh` |
| `reconcile_state.sh` | Compares key state counters across two contract instances (e.g. primary vs replica) and flags inconsistencies for manual recovery (issue #596) | `manual` | `tests/test_reconcile_state.sh` |
| `export_state.py` | Exports contract state to JSON or CSV for off-chain analysis (issue #591) | `manual` | — |

---

## Migration

| Script | What it does | Invoked by | Test coverage |
|---|---|---|---|
| `migration_orchestrator.py` | Crash-safe off-chain driver for the chunked migration protocol — resumes from the on-chain cursor on restart, no local checkpoint (see `docs/contract-upgrade-strategy.md`) | `manual` | `tests/test_migration_orchestrator.py` |
| `upgrade_scheduler.py` | Off-chain relayer that polls the contract and triggers `check_upgrade_notification()` / `execute_scheduled_upgrade()` when a scheduled upgrade's `execution_time` arrives | `manual` (cron or long-lived process) | — |

---

## Benchmarking & Profiling

| Script | What it does | Invoked by | Test coverage |
|---|---|---|---|
| `benchmark_compare.sh` | Runs the Criterion benchmark suite and compares results against the stored baseline, failing if regression exceeds threshold (issue #576) | `benchmarks.yml` | — |
| `scaling_benchmark_report.sh` | Runs `*_scaling` benchmarks across a range of `n`, fits an empirical complexity class, and emits a Markdown scaling report | `benchmarks.yml` | — |
| `profile_contracts.sh` | Profiles contract hot paths via the existing bench suite and writes a Markdown optimization report to `target/profile_report.md` (issue #593) | `manual` | — |
| `mutation_test.sh` | Runs `cargo-mutants` against the three contract crates and appends the mutation score to the append-only JSONL history in `mutants/history/` | `mutation-testing.yml` | — |
| `mutation_history.py` | Queries and formats the mutation score history JSONL files for trend analysis | `manual` | — |

---

## Security Scanning & Docs

| Script | What it does | Invoked by | Test coverage |
|---|---|---|---|
| `scan_contracts.sh` | Security pattern scan — checks for bare `unwrap()`/`expect()`, unsafe integer arithmetic, and other Soroban-specific anti-patterns (issue #594) | `ci.yml` (`security` job) | — |
| `check_deps.sh` | Verifies contract `soroban-sdk` versions match `contracts/dependencies.toml`; warns if a pinned RUSTSEC advisory has been present >90 days (issues #589, #1490) | `ci.yml` (`security` job) | — |
| `generate_docs.sh` | Auto-generates contract API docs from Rust source comments and writes them to `docs/contracts/` with a version stamp (issue #590) | `manual` | — |

---

## Test Coverage Summary

Three scripts in `scripts/tests/` provide automated test coverage:

| Test file | Covers |
|---|---|
| `tests/test_failover.sh` | `failover.sh` — RPC failover logic and consistency checks |
| `tests/test_reconcile_state.sh` | `reconcile_state.sh` — state reconciliation diff and alerting logic |
| `tests/test_migration_orchestrator.py` | `migration_orchestrator.py` — cursor resume, chunk processing, error handling |

Scripts **without** dedicated test coverage (marked `—` in the table above) are either:
- Thin wrappers around well-tested tools (`stellar`, `cargo`, `aws s3`) where the test value is low, or
- DR procedures (`restore_from_backup.sh`, `testnet_rollback.sh`) that are exercised by periodic DR drills on testnet rather than automated unit tests — see [docs/disaster-recovery.md](../docs/disaster-recovery.md) §4.

---

## Run Order for a New Deployment

For a first-time or post-disaster deployment from scratch:

```
1.  validate_env.sh          — confirm environment config is consistent
2.  build.sh                 — compile contract WASMs
3.  test.sh                  — run full contract test suite
4.  check_unwraps.sh         — confirm no new unsafe patterns
5.  pre_upgrade_checks.sh    — safety gate before any deploy
6.  deploy_testnet.sh        — deploy to testnet
7.  testnet_smoke_test.sh    — confirm deployment is functional
8.  snapshot.sh              — capture baseline state snapshot
9.  verify_snapshot.sh       — confirm snapshot integrity
10. backup.sh                — create encrypted backup
```

For a canary upgrade:

```
1.  build.sh                 — build new WASM
2.  pre_upgrade_checks.sh    — validate migration compatibility
3.  canary_deploy.sh         — deploy to 10%, soak, promote or roll back
```
