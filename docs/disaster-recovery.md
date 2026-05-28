# Disaster Recovery Procedures

## Overview

This document covers recovery procedures, backup strategy, automated state snapshots, and recovery testing for QuorumProof. Because core credential data lives on the Stellar blockchain, recovery focuses on restoring contract access, operator keys, and off-chain supporting infrastructure.

---

## 1. Recovery Procedures

### 1.1 Lost Deployer / Admin Key

1. If a backup key was pre-registered as a secondary admin via the contract's admin management, invoke `set_admin(new_admin)` from the backup key.
2. If no backup key exists, the contract is unrecoverable — redeploy all three contracts and re-issue credentials from source institutions.
3. Update `.env` and GitHub secrets (`STELLAR_SECRET_KEY`) with the new key immediately.

### 1.2 Contract Redeployment

Use this procedure when a contract must be redeployed (e.g. critical bug, key compromise):

```bash
# 1. Build fresh WASM artifacts
./scripts/build.sh

# 2. Deploy to the target network
./scripts/deploy_testnet.sh   # or deploy_mainnet.sh for production

# 3. Update contract addresses in .env
CONTRACT_QUORUM_PROOF=<new-id>
CONTRACT_SBT_REGISTRY=<new-id>
CONTRACT_ZK_VERIFIER=<new-id>

# 4. Update frontend/dashboard env files and redeploy frontend
```

> Existing on-chain SBTs issued under the old contract address are not migrated automatically. Coordinate with attestors to re-attest affected credentials.

### 1.3 RPC / Network Outage

- Switch `STELLAR_RPC_URL` to an alternate RPC endpoint (e.g. Horizon public API or a self-hosted Stellar node).
- Testnet: `https://soroban-testnet.stellar.org`
- Mainnet fallback: `https://horizon.stellar.org`
- No contract redeployment is needed; only the client configuration changes.

### 1.4 Frontend / Dashboard Outage

1. Redeploy from the latest tagged release on the `main` branch via the CI/CD pipeline (`workflow_dispatch` on `deploy.yml`).
2. If the hosting provider is unavailable, deploy to an alternate static host using `npm run build` output from `frontend/` or `dashboard/`.

---

## 2. Backup Strategy

| Asset | What to Back Up | Where | Frequency |
|---|---|---|---|
| Deployer secret key | Stellar secret key (`S...`) | Encrypted cold storage + GitHub secret | On creation / rotation |
| Contract IDs | `CONTRACT_QUORUM_PROOF`, `CONTRACT_SBT_REGISTRY`, `CONTRACT_ZK_VERIFIER` | `.env`, repo wiki, team password manager | After every deployment |
| Environment config | `.env` values (non-secret portions) | `.env.example` kept up to date in repo | On every config change |
| WASM artifacts | Built `.wasm` files | GitHub Actions artifacts (retained 90 days) | Every CI run on `main` |
| On-chain state | Credential and attestation records | Inherently replicated by Stellar network | Continuous (blockchain) |
| State snapshots | JSON export of all credentials, slices, attestors | `backups/snapshots/` (see §2.1) | Daily via cron |

**Key rotation policy**: Rotate the deployer key every 90 days or immediately after any suspected compromise.

### 2.1 Automated State Snapshots

The snapshot script exports all on-chain state to a timestamped JSON file. Run it via cron or CI on a schedule.

```bash
# scripts/snapshot.sh — export contract state to backups/snapshots/
./scripts/snapshot.sh
# Output: backups/snapshots/quorumproof-<YYYY-MM-DD>.json
```

The snapshot includes:
- All credentials (id, subject, issuer, type, metadata_hash, revoked, expires_at)
- All quorum slices (id, creator, attestors, weights, threshold)
- All attestation records per credential
- Contract metadata (admin address, paused state, counts)

Snapshots are stored in `backups/snapshots/` and should be copied to durable off-chain storage (S3, GCS, or equivalent) after generation.

```bash
# Example: upload to S3
aws s3 cp backups/snapshots/quorumproof-$(date +%F).json \
  s3://your-backup-bucket/quorumproof/snapshots/
```

### 2.2 Snapshot Verification

After each snapshot, run the verification script to confirm integrity:

```bash
./scripts/verify_snapshot.sh backups/snapshots/quorumproof-<date>.json
```

The verifier checks:
- JSON is well-formed and non-empty
- Credential count matches `get_credential_count()` on-chain
- Slice count matches `get_slice_count()` on-chain
- No credential IDs are missing from the sequence

---

## 3. Recovery Runbook

Follow these steps in order when a recovery event is declared.

### Step 1 — Declare Incident

1. Notify the team in the ops channel.
2. Identify the failure mode: key loss, contract bug, RPC outage, or data corruption.
3. Pause the contract if it is still accessible: `soroban contract invoke -- pause --admin <ADMIN>`.

### Step 2 — Assess Data Loss

1. Retrieve the latest snapshot from `backups/snapshots/` or the off-chain backup store.
2. Run `./scripts/verify_snapshot.sh <snapshot>` to confirm it is intact.
3. Compare snapshot credential count against the current on-chain count (if accessible).

### Step 3 — Restore Access

- **Key loss**: Follow §1.1.
- **Contract bug**: Follow §1.2 (redeploy), then re-import state from snapshot using `./scripts/restore_from_snapshot.sh`.
- **RPC outage**: Follow §1.3 (switch endpoint).

### Step 4 — Re-import State (if redeployed)

```bash
# Restore credentials and slices from the latest snapshot
./scripts/restore_from_snapshot.sh \
  --snapshot backups/snapshots/quorumproof-<date>.json \
  --contract <NEW_CONTRACT_ID> \
  --network testnet
```

The restore script replays `issue_credential`, `create_slice`, and `attest` calls from the snapshot. Attestors must re-authorize their attestations.

### Step 5 — Verify Recovery

1. Run `cargo test` against the restored contract.
2. Confirm credential count matches the snapshot.
3. Spot-check 5 random credentials via `get_credential`.
4. Unpause the contract: `soroban contract invoke -- unpause --admin <ADMIN>`.
5. Log the incident with date, cause, and resolution.

---

## 4. Recovery Testing

Run recovery drills on testnet. Do **not** use mainnet for drills.

### 4.1 Key Recovery Drill (quarterly)

1. Generate a temporary test key: `stellar keys generate dr-test --network testnet`
2. Register it as a secondary admin on the testnet contract.
3. Revoke the primary test key and confirm `dr-test` can call admin-gated functions.
4. Clean up: remove `dr-test` and restore primary key.

### 4.2 Contract Redeployment Drill (per release)

1. On testnet, run `./scripts/deploy_testnet.sh` from a clean environment (no cached `.env`).
2. Verify all three contract IDs are returned and functional via `cargo test`.
3. Confirm the CI deploy workflow (`deploy.yml`) completes successfully end-to-end.

### 4.3 Snapshot & Restore Drill (monthly)

1. Run `./scripts/snapshot.sh` on testnet and confirm output file is created.
2. Run `./scripts/verify_snapshot.sh <snapshot>` and confirm all checks pass.
3. Redeploy a fresh testnet contract.
4. Run `./scripts/restore_from_snapshot.sh` and confirm credential count matches.
5. Run `cargo test` against the restored contract.

### 4.4 RPC Failover Drill (quarterly)

1. Point `STELLAR_RPC_URL` at the fallback endpoint in `.env`.
2. Run `cargo test` and confirm all contract interactions succeed.
3. Restore the primary RPC URL.

### 4.5 Checklist

- [ ] Deployer key backup verified in cold storage
- [ ] Contract IDs recorded and accessible to the team
- [ ] Secondary admin key registered on-chain
- [ ] CI deploy workflow tested via `workflow_dispatch`
- [ ] RPC failover endpoint confirmed reachable
- [ ] Latest snapshot verified and uploaded to off-chain storage
- [ ] Restore drill completed successfully on testnet
- [ ] Recovery drill results logged with date and outcome
