# Contract Upgrade Testing

> Issue #1630. Companion to [contract-upgrade-strategy.md](./contract-upgrade-strategy.md)
> and [ADR-011: State Versioning and In-Place Upgrades](./adr/adr-011-state-versioning-and-upgrades.md).

Soroban upgrades swap a contract's WASM in place while keeping its address and
storage. A bad upgrade does not fail loudly: the new code deploys fine and then
fails to decode the stored data, or quietly changes an error code that clients
depend on. Upgrade testing catches these problems before deployment in three
layers.

| Layer | What it catches | Where |
|---|---|---|
| Static state-compatibility check | Removed/renamed storage keys, changed struct fields, renumbered error codes, removed or re-signed public functions | `scripts/upgrade/check_state_compat.py` |
| Upgrade simulation tests | State that is lost or changes across a code swap, broken migrations, missing upgrade guard rails | `contracts/integration_tests/src/upgrade_simulation.rs` (plus the existing `upgrade_safety.rs` #558 and `contract_upgrade_testing.rs` #579) |
| Pre-upgrade / rollback scripts | Environment readiness, rollback path | `scripts/pre_upgrade_checks.sh`, `scripts/test_upgrade_rollback.sh` |
| Testnet rehearsal | Real WASM, real ledger, real fees | Manual, see [contract-upgrade-strategy.md](./contract-upgrade-strategy.md) |

Layers 1 and 2 run automatically in `.github/workflows/upgrade-safety.yml` on
every PR that touches `contracts/**`.

## 1. Static state-compatibility check

```bash
# Compare the working tree against main (default: origin/main)
python3 scripts/upgrade/check_state_compat.py

# Compare against the tag that is actually deployed on mainnet
python3 scripts/upgrade/check_state_compat.py --base v1.0.0 --json compat.json
```

The script parses `#[contracttype]`, `#[contracterror]` and `#[contractimpl]`
items in each contract at the base ref and in the working tree, then applies
these rules:

| Rule | Severity | Why |
|---|---|---|
| Error variant removed or renumbered | **error** | Error codes are part of the public API (see `docs/error-codes.md`) |
| New error variant reuses an existing code | **error** | Clients would misinterpret the error |
| Storage-key enum variant removed or renamed | **error** | Soroban encodes enum variants by name, so every stored entry under that key is orphaned |
| Storage-key variant payload type changed | **error** | Existing keys no longer hash to the same ledger entry |
| Struct field removed, renamed or retyped | **error** | Structs are encoded as maps keyed by field name; stored values stop decoding |
| Struct field added | warning | Old entries lack the field, so a `migrate_state` arm must backfill them |
| Public function removed or its parameters changed | **error** | Breaks deployed callers and the API server |

Exit code `0` means compatible, `1` means breaking changes were found.

### Handling an intentional breaking change

When a breaking change really is necessary:

1. Add a new `migrate_state` arm in `contracts/quorum_proof/src/lib.rs` that
   rewrites the affected entries.
2. Add a simulation test in `upgrade_simulation.rs` that writes data in the old
   shape, runs the migration and checks the new shape.
3. Record the decision in a new ADR and link it from the PR.
4. Get sign-off from a maintainer. The CI job stays red until then, which is
   intentional.

## 2. Upgrade simulation tests

```bash
cargo test -p integration_tests upgrade_simulation
# all upgrade-related suites
cargo test -p integration_tests upgrade
```

A code swap is simulated by snapshotting the ledger (`env.to_snapshot()`),
rebuilding an `Env` from that snapshot and re-registering the contract at the
same address. That has the same effect as `update_current_contract_wasm`: the
address and storage are kept and only the executable changes.

| Test | Asserts |
|---|---|
| `upgrade_simulation_preserves_all_state` | Credentials, slices, attestors, attestation results, the subject index, counters and the pause flag are identical after the swap |
| `upgrade_simulation_then_migration_preserves_state` | Swap + `migrate_state(0→1)` keeps all data and bumps the schema version |
| `contract_remains_writable_after_upgrade` | New writes succeed and IDs don't collide with pre-upgrade IDs |
| `repeated_upgrades_preserve_state` | Several upgrades in a row don't lose state |
| `migration_rejects_*` | Migrations must be sequential, admin-only, non-replayable and defined |
| `validate_upgrade_*` | Zero hash and paused-contract upgrades are rejected |
| `*_upgrade_rejects_non_admin` / `*_rejects_zero_hash` | All three contracts protect `upgrade` |
| `failed_upgrade_attempt_leaves_state_untouched` | A rejected upgrade does not change state |

### Adding coverage for a new storage type

When you add a new `DataKey` variant or `#[contracttype]` struct that holds
persistent state:

1. Write some of that state in `populate()`.
2. Read it back in `capture()` and add it to `StateSnapshot`.
3. Compare it in `assert_state_compatible()`.

Existing tests will then fail if an upgrade drops or corrupts that state.

## 3. Upgrade guard rails in the contracts

All three contracts expose an admin-only `upgrade(admin, new_wasm_hash)`:

| Contract | Stored admin check | Zero-hash guard | Blocked while paused |
|---|---|---|---|
| `quorum_proof` | ✅ | ✅ (`validate_upgrade`) | ✅ |
| `sbt_registry` | ✅ | ✅ | n/a |
| `zk_verifier` | ✅ | ✅ | n/a |

Before #1630, `sbt_registry::upgrade` and `zk_verifier::upgrade` only called
`admin.require_auth()` on the address passed in. They never compared it with the
stored admin, so any account could authorise an upgrade by passing its own
address. Both now check the stored admin and reject an all-zero hash.

## Release checklist

- [ ] `check_state_compat.py --base <deployed tag>` passes, or the breaking changes are covered by a migration and an ADR
- [ ] `cargo test -p integration_tests upgrade` passes
- [ ] `scripts/pre_upgrade_checks.sh` passes for the target network
- [ ] New persistent state is covered in `populate()`/`capture()`
- [ ] `validate_upgrade` was called on testnet with the new WASM hash
- [ ] Testnet upgrade rehearsed and `migrate_state` run where needed
- [ ] Rollback WASM hash recorded (see [disaster-recovery.md](./disaster-recovery.md))
