# ADR-011: State Versioning and In-Place Contract Upgrades

## Status

Accepted

## Date

2026-09-26

## Context

Credentials are meant to be permanent records. A credential issued today must
still verify after any number of contract releases, and its contract address
is embedded in SBTs, the API server, the frontend and third-party integrations.

Soroban lets a contract replace its own WASM with
`env.deployer().update_current_contract_wasm(hash)`. The contract keeps its
address and all of its storage, and the new code has to be able to read the
data the old code wrote.

## Problem Statement

How should QuorumProof ship new code without losing or corrupting existing
credential state, and without breaking clients?

## Alternatives Considered

### Option 1: Deploy a new contract per release and migrate data

**Pros**: Old code stays immutable. Rollback means pointing back at the old address.

**Cons**: Every SBT and integration has to learn the new address. Migrating
thousands of entries costs many transactions and is not atomic. Attestation
history would be split across contracts.

### Option 2: Proxy / dispatcher contract

**Pros**: Familiar from the EVM world.

**Cons**: Soroban has native upgrades, so a proxy adds a call hop, fees and
extra attack surface for no benefit.

### Option 3: Native in-place upgrade plus a versioned state schema (chosen)

**Pros**: Stable address. Storage is kept. Migrations are explicit and ordered.

**Cons**: The new code has to decode old data. Every storage-layout change is
a potential outage unless it is caught before release.

## Decision

1. Each contract exposes an admin-only `upgrade(admin, new_wasm_hash)` that
   checks the stored admin before swapping code.
2. `quorum_proof::upgrade` first runs `validate_upgrade`: it rejects an
   all-zero hash, refuses to upgrade while paused, and emits an
   `UpgradeValidated` event. The upgrade is then recorded in the upgrade
   history log (#874) before the code is swapped.
3. `DataKey::StateVersion` records the schema version. `migrate_state(admin, from, to)`
   applies exactly one version step (`to == from + 1`) and must be called once
   per step after an upgrade that changes the layout.
4. Storage layout is append-only:
   - never remove or rename a `DataKey` / `DataKey2` variant, or change its payload types;
   - never remove, rename or retype a `#[contracttype]` struct field (adding one requires a migration arm);
   - never renumber or reuse a `ContractError` code;
   - never remove a public function or change its parameters.
5. These rules are enforced in CI by `scripts/upgrade/check_state_compat.py`
   and the upgrade tests in `contracts/integration_tests/src/` (`upgrade_safety.rs`,
   `contract_upgrade_testing.rs`, `upgrade_simulation.rs`)
   (see [docs/upgrade-testing.md](../upgrade-testing.md)).

## Rationale

Soroban encodes enum variants by **name** and structs as maps keyed by **field
name**. Renaming a storage-key variant therefore orphans every entry under it,
and removing a struct field makes stored values undecodable. Neither shows up
until a read fails in production. Making the layout append-only and checking it
mechanically turns silent data loss into a red CI build.

Sequential, single-step migrations keep each migration arm small and
reviewable, and they rule out running migrations twice or skipping one.

## Consequences

### Positive

- Contract addresses never change, so SBTs and integrations keep working.
- Breaking layout changes are caught at PR time, not after deployment.
- The upgrade history can be audited through `UpgradeValidated` events.

### Negative

- Storage enums only grow. `DataKey2` exists because `DataKey` hit Soroban's
  limit on the number of variants in a `#[contracttype]` enum, and more
  overflow enums may follow.
- Dead fields and keys stay in the code for good.

### Risks and Mitigations

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Admin key compromise allows a malicious upgrade | Low | Critical | Admin should be a multisig account; upgrades are logged on-chain; Semgrep rule `soroban-upgrade-without-admin-check` |
| Upgrade deployed but `migrate_state` not run | Med | High | Release checklist in docs/upgrade-testing.md; migration arms must tolerate old-shape data |
| `validate_upgrade` error-code baseline reuses `DataKey2::RateLimitConfig` | Med | Low | Known shortcut; replace with a dedicated key in a future schema version |
| `sbt_registry` / `zk_verifier` `upgrade` did not check the stored admin | Fixed | – | Fixed in #1630; both now compare the caller against the stored admin and reject a zero hash |

## Related Code

- `contracts/quorum_proof/src/lib.rs`: `upgrade`, `validate_upgrade`, `migrate_state`, `get_state_version`, `DataKey`, `DataKey2`, `ContractError`
- `contracts/sbt_registry/src/lib.rs`: `upgrade`
- `contracts/zk_verifier/src/lib.rs`: `upgrade`
- `scripts/upgrade/check_state_compat.py`
- `contracts/integration_tests/src/upgrade_safety.rs`, `upgrade_simulation.rs`, `contract_upgrade_testing.rs`
- `scripts/pre_upgrade_checks.sh`, `scripts/upgrade_rollback.sh`

## References

- [docs/contract-upgrade-strategy.md](../contract-upgrade-strategy.md)
- [docs/upgrade-testing.md](../upgrade-testing.md)
- [Soroban: upgrading contracts](https://developers.stellar.org/docs/build/guides/conventions/upgrading-contracts)
