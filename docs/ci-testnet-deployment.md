# CI Testnet Deployment

Testnet deployment used to be a manual process: an operator ran
`scripts/deploy_testnet.sh` locally and copied the resulting contract IDs by
hand into whatever needed them. That's error-prone (stale IDs, skipped smoke
tests, no record of what was deployed when). This document describes the
automated replacement: `.github/workflows/testnet-deploy.yml`.

## When it runs

- Automatically on every push to `main` that touches `contracts/**`,
  `scripts/deploy_testnet.sh`, or `scripts/testnet_smoke_test.sh`.
- On demand via `workflow_dispatch` (Actions tab → Testnet Deployment → Run
  workflow).

Runs are serialized (`concurrency: testnet-deploy`) so two deployments never
race against the same testnet contracts.

## Pipeline steps

1. **Build** — compiles `quorum_proof`, `sbt_registry`, and `zk_verifier` to
   `wasm32-unknown-unknown` release WASM.
2. **Restore manifest** — pulls the last successful `testnet-deployment.json`
   from the GitHub Actions cache (`testnet-deployment-manifest` key), so
   `deploy_testnet.sh` can snapshot it as `.previous` before overwriting it.
3. **Deploy** — runs `scripts/deploy_testnet.sh`, which deploys all three
   contracts and writes `testnet-deployment.json`:
   ```json
   {
     "network": "testnet",
     "deployed_at": "2026-07-26T12:00:00Z",
     "deployer": "G...",
     "contracts": {
       "quorum_proof": "C...",
       "sbt_registry": "C...",
       "zk_verifier": "C..."
     }
   }
   ```
4. **Smoke test** — `scripts/testnet_smoke_test.sh` reads the manifest and
   invokes a handful of read calls (`get_version`, `get_state_metrics`) against
   each freshly-deployed contract to confirm they're actually live and
   responding before anything downstream starts depending on them.
5. **Rollback (on smoke test failure only)** — `scripts/testnet_rollback.sh`
   restores `testnet-deployment.json` from the `.previous` snapshot saved in
   step 3, archives the broken manifest as
   `testnet-deployment.json.broken-<timestamp>`, and posts to
   `NOTIFY_WEBHOOK` if configured. This does **not** roll back on-chain state —
   a fresh testnet deployment has no prior on-chain state to restore — it only
   ensures the manifest that other tooling reads never points at contract IDs
   that failed their smoke tests.
6. **Save manifest** — on success, the new manifest is written back to the
   Actions cache so the next run's "previous" snapshot is this run's result,
   and uploaded as a build artifact for 30 days for audit/debugging.

## Required secrets and variables

| Name | Purpose |
|---|---|
| `secrets.STELLAR_DEPLOY_SECRET_KEY` | Funds/authorizes the `deployer` identity used by `deploy_testnet.sh`. |
| `secrets.NOTIFY_WEBHOOK` | Optional Slack/Teams-style webhook for rollback notifications. |

Configure these under the `testnet` GitHub Environment so they're scoped to
this workflow.

## Running it locally

The same scripts work outside CI:

```bash
export STELLAR_SECRET_KEY=...
./scripts/deploy_testnet.sh
./scripts/testnet_smoke_test.sh
# only if smoke tests failed:
./scripts/testnet_rollback.sh
```

## Relationship to canary/mainnet deployment

This workflow is for **fresh testnet deployments** of all three contracts. For
**in-place upgrades** of an already-deployed contract (testnet or mainnet),
use `.github/workflows/canary-deploy.yml` and `scripts/upgrade_rollback.sh`
instead — those roll back an actual on-chain WASM hash, not just a manifest
file.
