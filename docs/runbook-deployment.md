# Runbook: Deployment

> Issue #1645. This is the standard procedure for releasing QuorumProof: the
> API server image, and the contracts when they change. Use it for every
> production release. For a first-ever mainnet contract deployment, use
> [mainnet-deployment-runbook.md](./mainnet-deployment-runbook.md), which has
> per-contract confirmation gates. For background, see
> [deployment-guide.md](./deployment-guide.md) and
> [architecture-diagrams.md §4](./architecture-diagrams.md#4-deployment).

| | |
|---|---|
| **Owner** | Release engineer on duty |
| **Approvals** | One maintainer for API-only releases; two maintainers for contract releases |
| **Duration** | ~30 min (API only) · ~90 min (with contract upgrade) |
| **Rollback** | [runbook-rollback.md](./runbook-rollback.md) |

---

## 0. Before you start

- [ ] The release PR is merged to `main` and CI is green (`ci.yml`,
      `security.yml`, `container-scan.yml`).
- [ ] The [deployment checklist](./deployment-checklist.md) is complete.
- [ ] The release is not in a change freeze. Check the maintenance calendar in
      [runbook-maintenance.md](./runbook-maintenance.md#1-maintenance-windows).
- [ ] There's no open SEV-1 or SEV-2 incident.
- [ ] You've posted the release plan in the ops channel: version, image tag,
      whether contracts change, and the rollback owner.
- [ ] The environment is correct:
      ```bash
      ./scripts/validate_env.sh
      ```

Record the **current** state before changing anything. You'll need it to
roll back:

```bash
./scripts/blue_green_deploy.sh status          # active slot + image
stellar contract info wasm-hash --network "$STELLAR_NETWORK" --id "$CONTRACT_QUORUM_PROOF"
./scripts/snapshot.sh --network "$STELLAR_NETWORK" --output "snapshots/pre-release-$(date -u +%Y%m%dT%H%MZ).json"
```

---

## 1. Testnet (automatic)

Every merge to `main` runs `testnet-deploy.yml`. It deploys with
`deploy_testnet.sh`, then runs `testnet_smoke_test.sh`. If the smoke test
fails, `testnet_rollback.sh` restores the previous manifest.

- [ ] Confirm the latest `testnet-deploy.yml` run for the release commit
      passed: `gh run list --workflow testnet-deploy.yml --limit 3`.
- [ ] If it rolled back, **stop**. Fix the problem on `main` first.

---

## 2. Database migrations (if the release has any)

- [ ] Check that the backup is fresh: `gh run list --workflow backup.yml --limit 1`.
- [ ] Apply the migrations. They must be backward compatible with the image
      currently live, because it keeps serving until the switch:
      ```bash
      cd api-server && DATABASE_URL=... npm run migrate
      ```
- [ ] Confirm `db-migrations.yml` / the migration log shows every migration applied.
- [ ] If this fails, `npm run migrate:rollback` and **abort** the release. See
      [database-migrations.md](./database-migrations.md).

---

## 3. Contract upgrade (only if contracts changed)

Upgrade in dependency order: `quorum_proof`, then `zk_verifier`, then
`sbt_registry`. For each contract:

1. [ ] Build the release WASM and record its hash:
       ```bash
       ./scripts/build.sh
       sha256sum target/wasm32-unknown-unknown/release/<contract>.wasm
       ```
2. [ ] Run the safety checks against the live contract:
       ```bash
       ./scripts/pre_upgrade_checks.sh <contract_id> <new_wasm_path> "$ADMIN_KEY"
       ```
       All three check classes must pass: data migration, backward
       compatibility and state consistency.
3. [ ] Upgrade, with automatic rollback if the post-upgrade smoke tests fail:
       ```bash
       STELLAR_NETWORK=mainnet ./scripts/upgrade_rollback.sh <contract_id> <new_wasm_path> "$ADMIN_KEY"
       ```
4. [ ] Confirm the new WASM hash is live and that the `ContractUpgradeDetected`
       alert fired and was acknowledged. Confirm `StateVersionMismatch` is
       **not** firing.

For scheduled or time-locked upgrades, see
[scheduled-upgrades.md](./scheduled-upgrades.md). The full procedure is in
[contract-upgrade-guide.md](./contract-upgrade-guide.md).

---

## 4. API server release (blue/green)

1. [ ] Deploy the new image to the idle slot. The script health-checks it
       through the preview Service before it switches traffic:
       ```bash
       ./scripts/blue_green_deploy.sh deploy <registry>/quorumproof-api-server:<tag>
       ```
       Or run the `blue-green-deploy.yml` workflow with the image tag.
2. [ ] If the preview health checks fail, the script leaves traffic where it
       is. Investigate using
       [troubleshooting D3](./troubleshooting-guide.md#d3-api-server-unhealthy-or-slow).
3. [ ] After the switch:
       ```bash
       ./scripts/blue_green_deploy.sh status
       curl -fsS https://<api-host>/health | jq .status        # "healthy"
       curl -fsS https://<api-host>/health/ready | jq .ready   # true
       ```

For risky changes, prefer a canary (`./scripts/canary_deploy.sh`, see
`canary-deploy.yml`) over an immediate full switch.

---

## 5. Post-deployment verification (30 minutes)

- [ ] Smoke-test the core path: look up a known credential, verify it, and
      check that the WebSocket event stream connects.
- [ ] Error rate and p95 latency on Grafana are at or below the pre-release
      baseline. Watch `HighErrorRate`, `ApiLatencyP95High` and
      `ContractErrorBurst`.
- [ ] No new `RpcCircuitBreakerOpen` or `DbPoolSaturated` alerts.
- [ ] The multi-region secondary (if deployed) runs the same image. Run
      `./scripts/deploy_multi_region.sh` per
      [multi-region-deployment.md](./multi-region-deployment.md).

**Roll back immediately** (don't debug in production) if any of these happen
within the 30 minutes:

- the error rate is more than 2× baseline for 5 minutes,
- `/health` returns `unhealthy`,
- a SEV-1 or SEV-2 symptom appears.

See [runbook-rollback.md](./runbook-rollback.md).

---

## 6. Close out

- [ ] Post "release complete" with the version, image tag, WASM hashes and
      migration IDs.
- [ ] Keep the previous blue/green slot warm for **at least 24 hours**. It's
      your instant rollback.
- [ ] For a minor or major release, cut the docs version:
      `python3 scripts/docs_versions.py cut <MAJOR.MINOR>` (see
      [documentation-versioning.md](./documentation-versioning.md#3-cutting-a-new-version)).
- [ ] Update the release notes and changelog.
