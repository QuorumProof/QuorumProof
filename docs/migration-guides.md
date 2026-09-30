# Migration Guides Between Versions

Step-by-step upgrade guides for every versioned surface of QuorumProof, with
the breaking changes in each version and how to roll back (issue #1641).

QuorumProof has **four independently versioned surfaces**. Find the one(s)
your upgrade touches, then follow that guide:

| Surface | Versions | Who migrates | Guide |
|---|---|---|---|
| REST API | v1 → v2 | API clients / integrators | [API v1 → v2](#api-v1--v2) |
| Contract state layout (`StateVersion`) | 0 → 1 | Contract admin | [Contract state v0 → v1](#contract-state-v0--v1) |
| Credential data schema (`SchemaVersion`) | V1 → V2 | Contract admin | [Credential schema V1 → V2](#credential-schema-v1--v2) |
| Contract WASM | any → any | Contract admin | [Contract WASM upgrade](#contract-wasm-upgrade) |
| API-server database | `0001` → `0009` | API-server operator | [Database schema](#database-schema) |

Every guide follows the same shape: **breaking changes → prerequisites →
steps → verify → rollback**. Rollback procedures are collected in
[Rollback procedures](#rollback-procedures), and how to rehearse a migration
before running it for real is in the
[migration testing guide](./migration-testing-guide.md).

> **Before any migration:** take a backup (`./scripts/backup.sh --encrypt`),
> confirm it with `./scripts/verify_backup.sh`, and read the rollback section
> for the surface you are touching. Never start a migration you do not know
> how to undo.

---

## Breaking changes by version

### REST API v2 (GA 2026-09-01)

| Change | v1 | v2 | Action |
|---|---|---|---|
| Response envelope | `{ "ok", "version", "data" }` | Raw resource object | Read fields from the body root. |
| Credential metadata field | `metadata` | `metadata_hash` | Rename in your models. |
| Address field | `address` | `stellar_address` | Rename in your models. |
| Pagination cursor | `next_cursor` | `cursor` | Rename when paging. |
| Errors | `{ "error": "…" }` | RFC 9457 Problem Details (`type`, `title`, `status`, `detail`) | Read `title`/`detail`; switch on `status`. |
| New endpoints | — | `/api/v2/proof-requests`, `/api/v2/revocation-registry`, `/api/v2/bbs-credentials` | Optional adoption. |

v1 lifecycle: **maintenance since 2026-09-01** (no new features, `Deprecation`
and `Sunset` headers on every response), **sunset 2027-03-01** (returns
`410 Gone`). Unversioned `/api/...` paths behave as v1.

### Contract state version 1

No data transformation. Version 1 is the versioning baseline: it records a
`StateVersion` so that future layout changes can be migrated one step at a
time. See [ADR-011](./adr/adr-011-state-versioning-and-upgrades.md).

### Credential schema V2

Credential metadata is migrated to the V2 schema by a chunked, resumable
migration job. Reads during the migration are unaffected; the per-credential
metadata schema version is tracked as described in
[METADATA_SCHEMA_VERSIONING_PLAN.md](./METADATA_SCHEMA_VERSIONING_PLAN.md).
The invariants the migration must preserve are listed in
[migration-invariants.md](./migration-invariants.md).

### Contract releases (semver)

Contract releases follow the semver rules in
[contract-upgrade-guide.md](./contract-upgrade-guide.md#semantic-versioning):
a **MAJOR** bump means a breaking change to storage, error codes or public
function signatures. Each release's breaking changes are listed in its
changelog entry under *Breaking Changes* and *Migration Required*; that entry
is the input to the WASM upgrade guide below.

---

## API v1 → v2

**Who:** anyone calling the REST API. **Downtime:** none — v1 and v2 are
served side by side until the v1 sunset.

### Prerequisites

- Know which endpoints you call. The `API-Version` response header and the
  `Deprecation` header on v1 responses show where you are still on v1.
- Your client can be deployed with v1 and v2 code paths behind a flag.

### Steps

1. **Switch path prefix.** Replace `/api/` or `/api/v1/` with `/api/v2/` for
   the endpoints you call.
2. **Remove envelope unwrapping.** v1 clients typically read `body.data`;
   read the body directly instead.
   ```diff
   - const credential = (await res.json()).data;
   + const credential = await res.json();
   ```
3. **Rename fields.** `metadata` → `metadata_hash`, `address` →
   `stellar_address`, `next_cursor` → `cursor`.
   ```diff
   - const hash = credential.metadata;
   + const hash = credential.metadata_hash;
   - while (page.next_cursor) { page = await list(page.next_cursor); }
   + while (page.cursor)      { page = await list(page.cursor); }
   ```
4. **Update error handling.** Parse Problem Details: branch on HTTP status,
   show `title`/`detail` to users. `error` is no longer present.
   ```diff
   - if (!res.ok) throw new Error(body.error);
   + if (!res.ok) throw new Error(`${body.title}: ${body.detail ?? ''}`);
   ```
5. **Roll out behind a flag.** Ship both code paths, enable v2 for a small
   share of traffic, compare responses and error rates, then ramp to 100%.
6. **Remove v1 code** once v2 has run at 100% for a full release cycle, and
   before 2027-03-01.

Working v2 clients in four languages are in
[code-examples.md](./code-examples.md); every v1/v2 response shape is in
[api-response-examples.md](./api-response-examples.md#v1--v2-response-differences).

### Verify

- No response on your traffic carries a `Deprecation` header.
- Error-rate and parse-failure metrics are unchanged after the ramp.

### Rollback

Flip the flag back to the v1 code path. Nothing is stored server-side per
client version, so rollback is immediate. This option disappears on
2027-03-01.

---

## Contract state v0 → v1

**Who:** contract admin. **Downtime:** none (one transaction).

### Prerequisites

- The contract is running a WASM that includes `migrate_state`.
- Backup taken and verified.

### Steps

1. Read the current version — it must be `0`:
   ```bash
   stellar contract invoke --id "$CONTRACT_QUORUM_PROOF" --network "$NETWORK" \
     -- get_state_version
   ```
2. Migrate one step. `to_version` must equal `from_version + 1`:
   ```bash
   stellar contract invoke --id "$CONTRACT_QUORUM_PROOF" --network "$NETWORK" \
     --source-account admin -- migrate_state \
     --admin "$ADMIN_ADDRESS" --from_version 0 --to_version 1
   ```
3. For future versions, repeat one step at a time (`1 → 2`, `2 → 3`, …).
   Skipping versions is rejected by the contract.

### Verify

`get_state_version` returns `1`, and the smoke tests pass:
`./scripts/testnet_smoke_test.sh`.

### Rollback

v0 → v1 changes no stored data, so rolling back is not required; a
previous WASM ignores the `StateVersion` key. For later versions that do
transform data, see [Rollback procedures](#rollback-procedures).

---

## Credential schema V1 → V2

**Who:** contract admin. **Downtime:** none; the migration runs in chunks
across many transactions while the contract stays live.

### Prerequisites

- `get_schema_version` returns `1`.
- The contract is **not** paused (chunk calls are rejected while paused).
- Backup taken and verified.
- Rehearsed on a testnet copy of mainnet state
  ([migration testing guide](./migration-testing-guide.md#3-rehearse-on-testnet)).

### Steps

1. **Start the job:**
   ```bash
   stellar contract invoke --id "$CONTRACT_QUORUM_PROOF" --network "$NETWORK" \
     --source-account admin -- start_migration_v1_to_v2 --admin "$ADMIN_ADDRESS"
   ```
2. **Drive chunks to completion.** Use the crash-safe orchestrator, which
   reads progress from the chain on every run and can be restarted at any
   time:
   ```bash
   CONTRACT_QUORUM_PROOF=... STELLAR_SECRET_KEY=... \
     python3 scripts/migration_orchestrator.py --to-version 2 --chunk-size 100
   ```
   Or call `migrate_chunk_v1_to_v2 --admin ... --chunk_size 100` by hand
   until the checkpoint status is `Completed`.
3. **Monitor progress:**
   ```bash
   stellar contract invoke --id "$CONTRACT_QUORUM_PROOF" --network "$NETWORK" \
     -- get_migration_status
   ```
   Watch `migrated_items`, `failed_items` and `status`.
4. **Pause if needed.** `pause_migration` stops progress without losing the
   checkpoint; `resume_migration` continues from where it stopped.

### Verify

```bash
stellar contract invoke --id "$CONTRACT_QUORUM_PROOF" --network "$NETWORK" \
  -- validate_migration_integrity      # must return true
stellar contract invoke --id "$CONTRACT_QUORUM_PROOF" --network "$NETWORK" \
  -- get_schema_version                # must return 2
```

`validate_migration_integrity` is `true` only when the schema version is 2,
the checkpoint is `Completed` and `failed_items` is `0`.

### Rollback

- **While `InProgress` or `Paused`:** call `rollback_migration --admin ...`.
  It resets the schema version to V1 and marks the checkpoint `Failed`.
- **After `Completed`:** `rollback_migration` has no effect. Follow
  [Restore from backup](#restore-from-backup).

---

## Contract WASM upgrade

**Who:** contract admin. **Downtime:** none; `upgrade` swaps the WASM in place
and keeps the contract address and storage.

### Prerequisites

- Release changelog read; every item under *Migration Required* planned.
- Static compatibility check passes against the deployed tag:
  `python3 scripts/upgrade/check_state_compat.py --base <deployed-tag>`.
- [contract-upgrade-checklist.md](./contract-upgrade-checklist.md) complete.
- Contract **not** paused (upgrades are blocked while paused).

### Steps

1. Record the current WASM hash — this is your rollback target:
   ```bash
   stellar contract invoke --id "$CONTRACT_QUORUM_PROOF" --network "$NETWORK" \
     -- get_upgrade_history
   ```
2. Run pre-upgrade checks:
   ```bash
   ./scripts/pre_upgrade_checks.sh "$CONTRACT_QUORUM_PROOF" target/wasm32-unknown-unknown/release/quorum_proof.wasm
   ```
3. Upgrade with automatic smoke-test rollback:
   ```bash
   ./scripts/upgrade_rollback.sh "$CONTRACT_QUORUM_PROOF" <new.wasm> <admin_key>
   ```
   The script snapshots the current hash, installs the new WASM, runs
   post-upgrade smoke tests and reverts automatically if they fail.
4. Run any state or schema migrations the release requires (guides above).
5. Repeat for `zk_verifier` and `sbt_registry` if the release touches them,
   in [deployment order](./architecture.md#deployment-order).

For mainnet, follow the per-contract confirmation gates in
[mainnet-deployment-runbook.md](./mainnet-deployment-runbook.md). To schedule
the upgrade for a later ledger, see [scheduled-upgrades.md](./scheduled-upgrades.md).

### Verify

`get_upgrade_history` shows the new hash as the latest record, smoke tests
pass, and contract monitoring ([contract-monitoring.md](./contract-monitoring.md))
shows no new error codes.

### Rollback

See [Revert a contract WASM](#revert-a-contract-wasm).

---

## Database schema

**Who:** API-server operator. **Downtime:** none for additive migrations;
check each migration's notes for locking operations.

### Steps

1. Back up Postgres.
2. Deploy the new API-server build (migrations ship with it).
3. Apply pending migrations:
   ```bash
   cd api-server && npm run migrate
   ```
   The runner applies each pending `NNNN_*.up.sql` in order, one transaction
   per migration, and records it in `schema_migrations`.

### Verify

`schema_migrations` lists the new migrations, and `/health/ready` returns
`200`.

### Rollback

```bash
cd api-server && npm run migrate:rollback        # undo the latest migration
cd api-server && npm run migrate:rollback -- 3   # undo the latest 3
```

Each rollback runs the matching `.down.sql`. Roll the database back
**before** rolling the API server back to an older build. See
[database-migrations.md](./database-migrations.md).

---

## Rollback procedures

Rollback order is the **reverse of the upgrade order**: API clients →
API-server database → schema/state migrations → contract WASM.

### Revert a contract WASM

1. Find the previous WASM hash in `get_upgrade_history` (or the snapshot
   file written by `upgrade_rollback.sh`).
2. Call `upgrade` with that hash:
   ```bash
   stellar contract invoke --id "$CONTRACT_QUORUM_PROOF" --network "$NETWORK" \
     --source-account admin -- upgrade \
     --admin "$ADMIN_ADDRESS" --new_wasm_hash <previous_hash>
   ```
   On testnet, `./scripts/testnet_rollback.sh` automates this.
3. Only revert the WASM if the old code can still read the current storage.
   If a data migration already rewrote storage into a format the old WASM
   cannot decode, roll the data back first (below) — otherwise the reverted
   contract will fail on read.

### Roll back a data migration

| Migration | In progress / paused | Completed |
|---|---|---|
| Credential schema V1 → V2 | `rollback_migration` | Restore from backup |
| State version N → N+1 (data-changing) | n/a (single transaction) | Ship and run a reverse migration, or restore from backup |
| Database `NNNN` | n/a (transactional) | `npm run migrate:rollback` |

### Restore from backup

Use when a completed migration must be undone and no reverse migration
exists.

1. `pause` the contract to stop new writes.
2. Restore state with `./scripts/restore_from_backup.sh` following
   [backup-system.md](./backup-system.md) and
   [disaster-recovery.md](./disaster-recovery.md).
3. Reconcile with `./scripts/reconcile_state.sh` and review any writes that
   happened between the backup and the pause.
4. Revert the WASM if needed, then `unpause`.

### After any rollback

- Record what happened and why in the release's incident notes.
- Keep the failed migration job's checkpoint for diagnosis — do not delete it.
- Fix forward in a new release; do not re-run the same migration unchanged.

---

## Writing a migration guide for a new release

Every release with a breaking change adds a section to this page in the same
PR that introduces the change:

1. Add a row under [Breaking changes by version](#breaking-changes-by-version).
2. Add a guide section using the **breaking changes → prerequisites → steps →
   verify → rollback** shape.
3. Add or update the rehearsal steps in
   [migration-testing-guide.md](./migration-testing-guide.md).
4. Link the guide from the release's changelog *Migration Required* entry.

See also: [contract-upgrade-guide.md](./contract-upgrade-guide.md) ·
[contract-upgrade-strategy.md](./contract-upgrade-strategy.md) ·
[FAQ](./faq.md#upgrades--versions) · [Glossary](./glossary.md)
