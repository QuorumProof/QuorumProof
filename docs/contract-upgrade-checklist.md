# Contract Upgrade Validation Checklist

> **Issue #1316** — This checklist is the human-process companion to the
> automated tests in `contracts/quorum_proof/src/upgrade_safety_tests.rs`.
> Every item below must be verified before merging a contract upgrade PR and
> before executing an upgrade on testnet or mainnet.

---

## 1. Pre-Upgrade — Code Review

- [ ] **No `DataKey*` reordering** — All `#[contracttype]` enum variants used
  as storage keys must retain their existing numeric order. New variants must
  only be appended at the end. Reordering or inserting silently invalidates
  every affected storage entry.
  - Verified by: `storage_layout_*` tests in `upgrade_safety_tests.rs`

- [ ] **No `ContractError` renumbering** — `ContractError` is `#[repr(u32)]`.
  Every existing variant must keep its assigned integer value. Off-chain
  clients parse raw error integers; renumbering is a silent breaking change.
  - Verified by: `error_code_*` tests in `upgrade_safety_tests.rs`
  - Reference: the full error table in `docs/error-codes.md`

- [ ] **No breaking function signature changes** — Existing public entry
  points must retain their argument count, order, and types. New optional
  arguments are acceptable only if the SDK client generator will preserve
  backward-compatible call sites.
  - Verified by: `signature_compat_*` tests in `upgrade_safety_tests.rs`

- [ ] **State version bumped if schema changes** — Any change to a stored
  struct layout (adding/removing/reordering fields) requires a `migrate_state`
  path from the current version to the new version.

- [ ] **Migration is sequential** — `migrate_state` enforces `from == current`
  and `to == from + 1`. Version jumps are forbidden.

- [ ] **WASM hash is non-zero** — `validate_upgrade` rejects an all-zero hash.
  Confirm the correct WASM is compiled and its hash captured before scheduling.

---

## 2. Pre-Upgrade — Environment Checks

- [ ] **Run full test suite green** — `cargo test -p quorum_proof` must pass
  with 0 failures, including the `upgrade_safety_tests` module.

- [ ] **Run integration tests** — `cargo test -p integration_tests` must pass,
  including `upgrade_safety.rs` (issue #558) and `integration_tests.rs`
  (issue #1002).

- [ ] **Check current deployed state version** — Call `get_state_version()` on
  the live contract and confirm it matches the `from` argument you plan to pass
  to `migrate_state`.

- [ ] **Back up current state** — Run `scripts/snapshot.sh` (or
  `scripts/export_state.py`) to capture a full state snapshot before the
  upgrade. Record the snapshot id.

- [ ] **Verify WASM builds for `wasm32-unknown-unknown`** — The deployed
  binary is the WASM target, not the native test binary. Confirm:
  ```bash
  cargo build --target wasm32-unknown-unknown --release -p quorum_proof
  ```
  completes without errors.

- [ ] **Compute WASM hash** — Record the SHA-256 / Soroban hash of the
  compiled WASM and store it in the upgrade PR description. The hash you
  schedule must match this value exactly.

---

## 3. Scheduled Upgrade Path (Recommended)

Prefer `schedule_upgrade` + `execute_scheduled_upgrade` over an immediate
`upgrade` call for any mainnet change. This gives a notice window for
holders and monitoring to react.

- [ ] **Schedule at least 1 hour ahead** — `NOTICE_WINDOW_SECONDS = 3600`.
  Scheduling further ahead (e.g. 24 h) is recommended for non-emergency
  upgrades.

- [ ] **Emit notification** — Call `notify_if_imminent` from a monitoring job
  within the notice window. Confirm the event appears in the audit log.

- [ ] **Confirm the pending schedule** — Call `get_scheduled_upgrade()` and
  verify `new_wasm_hash` and `execution_time` match the intended values.

- [ ] **Do not cancel unless necessary** — `cancel_scheduled_upgrade` removes
  the pending slot permanently. If the upgrade is cancelled, re-schedule and
  restart the notification cycle.

---

## 4. Execution

- [ ] **Execute at or after `execution_time`** — `execute_scheduled_upgrade`
  silently returns `None` if called too early. Confirm the ledger timestamp
  has passed the gate before triggering.

- [ ] **For immediate upgrades** — Call `upgrade(admin, new_wasm_hash)`. This
  path is reserved for emergency hotfixes where the scheduling window is
  impractical.

- [ ] **Confirm upgrade history** — Call `get_upgrade_history()` immediately
  after. The new entry must appear with the correct `new_wasm_hash`,
  `upgraded_at`, and `was_scheduled` flag.

---

## 5. Post-Upgrade Validation

### 5a. Automated Smoke Tests (Programmatic Verification)

The `scripts/upgrade_rollback.sh` script runs automated smoke tests before and
after the upgrade:

- **Pre-upgrade smoke test** — Verifies the live contract responds to
  `get_version()` and `get_state_metrics()` calls. If this check fails, the
  upgrade is aborted and no WASM is deployed.
- **Post-upgrade smoke test** — Re-runs the same checks (`get_version()` and
  `get_state_metrics()`) against the live contract **after** the new WASM is
  deployed. If this check fails, `scripts/upgrade_rollback.sh` automatically:
  1. Rolls back the WASM to the previous hash
  2. Sends a failure notification to `NOTIFY_WEBHOOK` (if configured)
  3. Exits with status code 1

**Why these specific checks?**

- `get_version()` confirms the contract code is live and responds to read
  calls. A broken WASM or deployment failure will not respond.
- `get_state_metrics()` confirms the contract can access its stored state. A
  storage layout regression (e.g., reordered `DataKey` variants) would cause
  this to fail or return incorrect values.

**These automated checks do NOT replace manual validation** (section 5b below).
They are a rapid failure-detection mechanism for deployments; operator review
is still required.

### 5b. Manual Spot-Check Verification

Run these checks immediately after the upgrade transaction confirms:

- [ ] **Contract still responds** — Call `is_paused()`. Any response (true or
  false) confirms the contract is live.

- [ ] **Admin check** — Call `get_admin()` and verify it matches the expected
  admin address. A storage layout regression would return the wrong value or
  panic.

- [ ] **Credential count unchanged** — Call `get_credential_count()` and
  confirm it matches the pre-upgrade snapshot.

- [ ] **Slice count unchanged** — Call `get_slice_count()` and confirm it
  matches the pre-upgrade snapshot.

- [ ] **Sample credential readable** — Retrieve 3–5 credentials from the live
  contract and verify all fields (id, subject, issuer, credential_type,
  metadata_hash, revoked) are intact.

- [ ] **Sample attestation intact** — For each sampled credential, call
  `is_attested(cred_id, slice_id)` and confirm it matches the pre-upgrade
  state.

- [ ] **State version correct** — Call `get_state_version()`. If a migration
  was included in the upgrade, confirm it reflects the new version; otherwise
  confirm it is unchanged.

- [ ] **Post-upgrade issuance works** — Issue one test credential with a
  throwaway issuer/subject and confirm the returned id is strictly greater
  than the highest pre-upgrade id (no counter reset).

---

## 6. Migration Execution (if schema version bump included)

- [ ] **Call `migrate_state(admin, from, to)`** — where `from` is the current
  on-chain version and `to = from + 1`.

- [ ] **For chunked credential-metadata migrations** — Use the paginated
  migration engine:
  ```
  start_metadata_migration(admin, schema_version)
  # loop until job.status == Completed:
  migrate_next_chunk(admin, schema_version, chunk_size=50)
  ```
  Recommended chunk size: 50 (safe for mainnet CPU budget per transaction).

- [ ] **Monitor migration progress** — Call `get_migration_job(schema_version)`
  between chunks to track `cursor`, `migrated_count`, and `progress_bps`.

- [ ] **Confirm migration complete** — `job.status == Completed` and
  `job.migrated_count == job.total_items - job.skipped_count`.

---

## 7. Rollback Plan

If any post-upgrade check fails:

1. **Do not panic** — the contract's existing state is still readable; the
   upgrade only swapped code.
2. **Prepare the rollback WASM** — the previous version's compiled binary
   (its hash is in `get_upgrade_history()[last - 1].new_wasm_hash`).
3. **Emergency `upgrade(admin, previous_hash)`** — immediately reverts to the
   prior binary. All storage written by the new binary must be
   forward-compatible with the old binary (test with `upgrade_then_migrate_full_scenario`).
4. **File a post-mortem** — document what failed, which storage keys were
   affected, and what migration is needed before re-attempting.

---

## 8. Automated Test Coverage Summary

| Test file | What it covers |
|---|---|
| `upgrade_safety_tests.rs` (this issue) | Storage layout stability, error code pinning, function signature compat, upgrade pitfalls |
| `integration_tests/src/upgrade_safety.rs` (#558) | State preservation, no data loss, rollback scenarios |
| `integration_tests/tests/integration_tests.rs` (#1002) | Multi-contract upgrade + migration full flow |
| `migration_tests.rs` | Chunked migration engine idempotency and crash-restart safety |
| `upgrade_history.rs` (inline tests) | Upgrade audit log ring-buffer behavior |

All suites must pass before any upgrade proceeds.
