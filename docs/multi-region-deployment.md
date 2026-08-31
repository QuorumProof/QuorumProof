# Multi-Region Deployment Guide

## Overview

QuorumProof supports deployment to multiple Stellar networks (testnet, mainnet) with automated failover and consistency verification. This guide covers deployment strategies, failover procedures, and cross-region verification.

---

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│                  QuorumProof Contracts                  │
├─────────────────────────────────────────────────────────┤
│                                                         │
│  ┌──────────────────┐         ┌──────────────────┐    │
│  │   Testnet        │         │   Mainnet        │    │
│  │  (Development)   │         │  (Production)    │    │
│  │                  │         │                  │    │
│  │ Primary RPC:     │         │ Primary RPC:     │    │
│  │ soroban-testnet  │         │ soroban-mainnet  │    │
│  │                  │         │                  │    │
│  │ Backup RPC:      │         │ Backup RPC:      │    │
│  │ horizon-testnet  │         │ horizon          │    │
│  └──────────────────┘         └──────────────────┘    │
│         │                              │               │
│         └──────────────┬───────────────┘               │
│                        │                               │
│                   Failover Layer                       │
│                   (Automatic)                          │
│                                                         │
└─────────────────────────────────────────────────────────┘
```

---

## Quick Start

### 1. Configure Networks

```bash
# Add networks to Stellar CLI
stellar network add --rpc-url https://soroban-testnet.stellar.org testnet
stellar network add --rpc-url https://soroban-mainnet.stellar.org mainnet

# Verify networks
stellar network list
```

### 2. Deploy to Multiple Regions

```bash
# Deploy to testnet and mainnet
./scripts/deploy_multi_region.sh --networks testnet,mainnet --verify

# Deploy to testnet only
./scripts/deploy_multi_region.sh --networks testnet

# Deploy to mainnet only
./scripts/deploy_multi_region.sh --networks mainnet
```

### 3. Verify Deployments

```bash
# Check RPC endpoint health
./scripts/failover.sh --check

# Verify consistency across regions
./scripts/failover.sh --verify
```

---

## Deployment Strategies

### Strategy 1: Staged Rollout

Deploy to testnet first, verify, then deploy to mainnet:

```bash
# 1. Deploy to testnet
./scripts/deploy_multi_region.sh --networks testnet --verify

# 2. Run integration tests
cargo test --release

# 3. Deploy to mainnet
./scripts/deploy_multi_region.sh --networks mainnet --verify
```

### Strategy 2: Parallel Deployment

Deploy to both networks simultaneously (use with caution):

```bash
# Deploy to both networks in parallel
./scripts/deploy_multi_region.sh --networks testnet,mainnet --verify
```

### Strategy 3: Blue-Green Deployment

Maintain two contract versions for zero-downtime upgrades:

```bash
# Deploy new version (green)
./scripts/deploy_multi_region.sh --networks testnet

# Verify new version
./scripts/failover.sh --verify

# Switch traffic to new version
./scripts/failover.sh --switch https://soroban-testnet.stellar.org

# Keep old version (blue) as fallback
```

---

## RPC Endpoints

### Testnet

| Endpoint | Type | Purpose |
|---|---|---|
| `https://soroban-testnet.stellar.org` | Primary | Main RPC for testnet |
| `https://horizon-testnet.stellar.org` | Backup | Fallback RPC |

### Mainnet

| Endpoint | Type | Purpose |
|---|---|---|
| `https://soroban-mainnet.stellar.org` | Primary | Main RPC for mainnet |
| `https://horizon.stellar.org` | Backup | Fallback RPC |

---

## Failover Procedures

### What Failover Changes

`scripts/failover.sh --switch` updates:

1. **Primary RPC endpoint** (`STELLAR_RPC_URL` in `.env`) — the node the API server and exporter query for contract state and events
2. **Load balancer DNS target** — if using DNS-based load balancing, the switch may trigger a DNS TTL refresh (typically 60s)
3. **RPC endpoint preference** — future transactions use the new endpoint; in-flight requests complete against the old endpoint

What it **does NOT** change:
- Contract addresses (`CONTRACT_*` variables) — these are immutable
- Network selection (`STELLAR_NETWORK`) — use `deploy_multi_region.sh` to deploy to a different network
- Historical event data or ledger history — existing backups remain on their original chain

### Pre-Failover Checklist

Before initiating a failover during an incident:

```bash
# 1. Check health of all endpoints
./scripts/failover.sh --check

# 2. Verify current state consistency
./scripts/failover.sh --verify

# 3. Confirm backup endpoint is reachable and synchronized
curl -X POST https://backup-rpc-endpoint/ \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"getHealth"}'

# 4. Log the decision and time (store in failover.log)
echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] Initiating failover from primary to backup" >> failover.log
```

### Manual Failover Runbook

Execute this sequence during a primary endpoint outage:

```bash
#!/bin/bash
set -e

# Step 1: Confirm primary is down
echo "Step 1: Confirming primary endpoint is unreachable..."
./scripts/failover.sh --check | grep -E "✗|unreachable" || {
  echo "ERROR: Primary endpoint appears reachable; aborting failover"
  exit 1
}

# Step 2: Confirm backup is healthy
echo "Step 2: Confirming backup endpoint is healthy..."
BACKUP_HEALTHY=$(./scripts/failover.sh --check | grep -E "✓.*backup" | wc -l)
if [ "$BACKUP_HEALTHY" -eq 0 ]; then
  echo "ERROR: Backup endpoint is not healthy; cannot failover"
  exit 1
fi

# Step 3: Execute switch
echo "Step 3: Switching to backup endpoint..."
BACKUP_URL="https://horizon-testnet.stellar.org"  # Or your backup RPC URL
./scripts/failover.sh --switch "$BACKUP_URL"

# Step 4: Wait for DNS propagation
echo "Step 4: Waiting for DNS propagation (60–120 seconds)..."
sleep 90

# Step 5: Verify consistency
echo "Step 5: Verifying contract state consistency..."
./scripts/failover.sh --verify

# Step 6: Run reconciliation (see Reconciliation & State Sync below)
echo "Step 6: Running state reconciliation..."
./scripts/reconcile_state.sh --network testnet --contract "$CONTRACT_QUORUM_PROOF"

# Step 7: Resume monitoring
echo "Step 7: Failover complete. Monitoring resumed on backup endpoint."
echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] Failover completed to backup endpoint" >> failover.log
```

### Expected Propagation Time

- **DNS update**: 60–120 seconds (typical TTL for Stellar RPC endpoints)
- **Load balancer target switch**: immediate (if using API-based load balancing)
- **Client reconnection**: within 1–2 request retry cycles (5–10 seconds)
- **Full state consistency check**: 30–60 seconds
- **Total estimated time to recovery**: 2–3 minutes

### Automatic Failover (Exporter)

The exporter (`monitoring/exporter/exporter.py`) includes automatic RPC failover:

```python
# Attempt primary RPC; on failure, fall back to backup
try:
    response = self.get_events_from_rpc(self.primary_rpc_url)
except RpcException:
    logger.warning("Primary RPC failed; trying backup")
    response = self.get_events_from_rpc(self.backup_rpc_url)
```

### Failover Configuration

Configure primary and backup endpoints in `.env`:

```bash
# Primary RPC endpoint (used for all contract queries)
STELLAR_RPC_URL=https://soroban-testnet.stellar.org
STELLAR_NETWORK=testnet

# Backup RPC endpoints (environment variable overrides in failover.sh)
RPC_TESTNET_BACKUP=https://horizon-testnet.stellar.org
RPC_MAINNET_BACKUP=https://horizon.stellar.org

# Optional: Timeout for RPC calls (seconds)
RPC_FAILOVER_TIMEOUT=10
```

### Reconciliation & State Sync

After a failover, run `scripts/reconcile_state.sh` to:

1. **Verify contract state** on the new endpoint matches expectations
2. **Compare credential counts** between endpoint replicas
3. **Detect orphaned transactions** that may not have replicated
4. **Replay missed events** if the backup endpoint is behind

```bash
# Reconcile state after failover
./scripts/reconcile_state.sh --network testnet \
  --contract "$CONTRACT_QUORUM_PROOF" \
  --primary "$STELLAR_RPC_URL" \
  --backup "$RPC_TESTNET_BACKUP"

# Output:
# Reconciliation report:
#   Primary endpoint: 42 credentials
#   Backup endpoint: 42 credentials
#   Status: ✓ Consistent
#   Last sync: 2024-05-29T14:32:00Z
#
# If backup is behind:
#   Primary endpoint: 45 credentials
#   Backup endpoint: 42 credentials
#   Status: ⚠ Behind by 3 credentials
#   Recommended action: Wait for replication or trigger manual sync
```

---

## Consistency Verification

### Cross-Region Verification

Verify contract state is consistent across regions:

```bash
./scripts/failover.sh --verify

# Output:
# ==> Verifying contract state consistency...
#
#     testnet (CAAAAAAA...):
#       testnet-backup: 42 credentials
#       testnet: 42 credentials
#       ✓ Consistent
#
#     mainnet (CAAAAAAA...):
#       mainnet-backup: 100 credentials
#       mainnet: 100 credentials
#       ✓ Consistent
```

If a query fails on either side, it is never treated as a matching count of
0 — it is surfaced explicitly instead:

```
#     testnet (CAAAAAAA...):
#       testnet-backup: UNKNOWN credentials
#       testnet: 42 credentials
#       ? Could not verify (one or more endpoints did not return a valid count)
```

### Consistency Checks

`--verify` checks:

1. **Credential count** — compared between a network's primary endpoint and
   its `-backup` endpoint, via a real Soroban RPC call
   (`stellar contract invoke ... get_credential_count`, simulated against
   each endpoint) — the same mechanism `scripts/reconcile_state.sh` uses for
   cross-instance comparison

Slice count, a contract state hash, and attestation records are **not**
checked by this script. Earlier revisions of this doc listed all four as
checked; that described capabilities `failover.sh` never had.

Because Horizon (the `-backup` endpoint for both networks by default) has no
Soroban RPC and cannot serve contract-state queries, `--verify` will report
"Could not verify" for the backup side against stock config. To get a real
cross-region divergence check, point the backup override
(`RPC_TESTNET_BACKUP` / `RPC_MAINNET_BACKUP`) at a second genuine Soroban RPC
endpoint in another region/provider rather than Horizon.

`--check` validates reachability using the protocol each endpoint type
actually speaks: `getHealth` (JSON-RPC) for Soroban RPC endpoints, and a
check for `horizon_version` on the root endpoint for Horizon endpoints —
neither endpoint type has a `/health` REST route.

### Handling Inconsistencies

If inconsistencies are detected:

1. **Identify the source** — Which region is out of sync?
2. **Check RPC health** — Is the endpoint experiencing issues?
3. **Review recent transactions** — Were there recent state changes?
4. **Pause contract** — If critical, pause to prevent further divergence
5. **Restore from backup** — Use latest backup to restore consistency

```bash
# Pause contract if inconsistent
soroban contract invoke --id CAAAAAAA... -- pause --admin <ADMIN>

# Restore from backup
export BACKUP_ENCRYPTION_KEY="your-key"
./scripts/restore_from_backup.sh \
  --backup backups/daily/quorumproof-2026-05-29.json.enc \
  --contract CAAAAAAA... \
  --network testnet

# Unpause after verification
soroban contract invoke --id CAAAAAAA... -- unpause --admin <ADMIN>
```

---

## Deployment Workflow

### GitHub Actions Workflow

The `.github/workflows/deploy-multi-region.yml` workflow:

1. Builds contracts
2. Deploys to testnet
3. Verifies testnet deployment
4. Deploys to mainnet
5. Verifies mainnet deployment
6. Checks consistency across regions

### Manual Trigger

```bash
# Trigger deployment workflow
gh workflow run deploy-multi-region.yml \
  -f networks=testnet,mainnet \
  -f verify=true

# View workflow status
gh run list --workflow deploy-multi-region.yml
```

### Deployment Log

Each deployment is logged to `deployments.log`:

```
=== Multi-Region Deployment Log ===
Timestamp: 2026-05-29T14:30:00Z
Networks: testnet,mainnet

Network: testnet
Contract ID: CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4
Timestamp: 2026-05-29T14:30:15Z

Network: mainnet
Contract ID: CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC5
Timestamp: 2026-05-29T14:31:00Z
```

---

## Contract Address Management

### Store Contract IDs

After deployment, store contract IDs in multiple places:

```bash
# 1. Update .env
export CONTRACT_QUORUM_PROOF_TESTNET=CAAAAAAA...
export CONTRACT_QUORUM_PROOF_MAINNET=CAAAAAAA...

# 2. Update GitHub Secrets
gh secret set CONTRACT_QUORUM_PROOF_TESTNET -b "CAAAAAAA..."
gh secret set CONTRACT_QUORUM_PROOF_MAINNET -b "CAAAAAAA..."

# 3. Update frontend config
echo "VITE_CONTRACT_QUORUM_PROOF_TESTNET=CAAAAAAA..." >> frontend/.env
echo "VITE_CONTRACT_QUORUM_PROOF_MAINNET=CAAAAAAA..." >> frontend/.env

# 4. Document in wiki
# Add to GitHub wiki or team documentation
```

### Contract ID Rotation

If a contract needs to be redeployed:

1. Deploy new contract to testnet
2. Verify new contract works
3. Update all references to new contract ID
4. Deploy new contract to mainnet
5. Update frontend and API server
6. Notify users of contract address change

---

## Monitoring Multi-Region Deployments

### Prometheus Metrics

Monitor deployment health across regions:

```promql
# Check RPC endpoint availability
up{job="quorumproof-exporter"}

# Compare metrics across regions
quorumproof_credentials_issued_total{region="testnet"}
quorumproof_credentials_issued_total{region="mainnet"}

# Detect consistency issues
abs(quorumproof_credentials_issued_total{region="testnet"} - 
    quorumproof_credentials_issued_total{region="mainnet"}) > 0
```

### Alerting Rules

```yaml
- alert: RegionInconsistency
  expr: |
    abs(quorumproof_credentials_issued_total{region="testnet"} - 
        quorumproof_credentials_issued_total{region="mainnet"}) > 10
  for: 5m
  labels:
    severity: warning
  annotations:
    summary: "Credential count inconsistency between regions"

- alert: RPCEndpointDown
  expr: up{job="quorumproof-exporter"} == 0
  for: 1m
  labels:
    severity: critical
  annotations:
    summary: "RPC endpoint is unreachable"
```

---

## Failover Testing & Audit Trail

### Last Tested Convention

Maintain a `failover-tests.log` at the root of the repository to track when failover procedures have been exercised:

```
# failover-tests.log format: ISO8601 timestamp, operator, result, notes

2024-06-15T10:30:00Z  alice   PASS  Testnet failover from soroban-testnet to horizon-testnet; state consistent; total time ~2m45s
2024-06-01T14:15:00Z  bob     PASS  Mainnet failover drill; no production impact (pre-incident test)
2024-05-29T14:32:00Z  charlie FAIL  Mainnet failover; backup endpoint was 3 credentials behind; required manual replay
2024-05-20T09:00:00Z  alice   PASS  Testnet failover; exporter reconnected in 45s
```

Add an entry after each failover test:

```bash
# During/after a failover:
echo "$(date -u +%Y-%m-%dT%H:%M:%SZ)  $(whoami)  PASS  Brief description of failover and any issues encountered" >> failover-tests.log
git add failover-tests.log
git commit -m "ops: log failover test on [network]"
```

### Determining if Failover Path is Current

Before trusting a failover during a real incident:

```bash
# Check when failover was last successfully tested
grep PASS failover-tests.log | tail -5

# If the last successful test is >1 month old, schedule a drill:
LAST_TEST=$(grep PASS failover-tests.log | tail -1 | cut -d' ' -f1)
echo "Failover last tested: $LAST_TEST (consider running a drill if older than 1 month)"
```

If failover has not been tested recently (>30 days):
1. Schedule a drill during a maintenance window
2. Notify the on-call team
3. Document any issues discovered
4. Update runbook procedures based on findings

### Creating a Failover Test Drill

To safely test failover without impacting production:

```bash
#!/bin/bash
# scripts/test-failover-drill.sh

set -e

echo "=== Failover Test Drill (Non-Destructive) ==="
echo "Testing failover procedures against testnet..."
echo "Start time: $(date -u +%Y-%m-%dT%H:%M:%SZ)"

# 1. Snapshot current state
BEFORE=$(./scripts/failover.sh --verify)
echo "State before failover:"
echo "$BEFORE"

# 2. Execute failover
PRIMARY="https://soroban-testnet.stellar.org"
BACKUP="https://horizon-testnet.stellar.org"
echo ""
echo "Switching from $PRIMARY to $BACKUP..."
./scripts/failover.sh --switch "$BACKUP"

# 3. Wait for propagation
echo "Waiting for DNS/LB propagation..."
sleep 90

# 4. Verify consistency
echo "Verifying state after switch..."
./scripts/failover.sh --verify

# 5. Run reconciliation
echo "Running state reconciliation..."
./scripts/reconcile_state.sh --network testnet

# 6. Switch back to primary
echo "Switching back to $PRIMARY..."
./scripts/failover.sh --switch "$PRIMARY"

# 7. Final verification
echo "Final verification..."
./scripts/failover.sh --verify

echo ""
echo "=== Drill Complete ==="
echo "End time: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo "[PASS] All failover procedures executed successfully"

# Log the test
echo "$(date -u +%Y-%m-%dT%H:%M:%SZ)  $(whoami)  PASS  Failover drill completed; state remained consistent; round-trip time ~4m" >> failover-tests.log
```

---

## Disaster Recovery

### Scenario: Mainnet Contract Corrupted

1. **Pause mainnet contract**
   ```bash
   soroban contract invoke --id MAINNET_CONTRACT -- pause --admin <ADMIN>
   ```

2. **Verify testnet is healthy**
   ```bash
   ./scripts/failover.sh --verify
   ```

3. **Redeploy to mainnet**
   ```bash
   ./scripts/deploy_multi_region.sh --networks mainnet --verify
   ```

4. **Restore state from backup**
   ```bash
   export BACKUP_ENCRYPTION_KEY="your-key"
   ./scripts/restore_from_backup.sh \
     --backup backups/daily/quorumproof-mainnet-2026-05-29.json.enc \
     --contract <NEW_MAINNET_CONTRACT> \
     --network mainnet
   ```

5. **Verify consistency**
   ```bash
   ./scripts/failover.sh --verify
   ```

6. **Unpause mainnet contract**
   ```bash
   soroban contract invoke --id <NEW_MAINNET_CONTRACT> -- unpause --admin <ADMIN>
   ```

---

## Best Practices

1. **Always deploy to testnet first** — Verify before mainnet
2. **Test failover regularly** — Monthly failover drills
3. **Monitor consistency** — Set up alerts for region divergence
4. **Document contract IDs** — Keep wiki updated with current addresses
5. **Backup before deployment** — Always have a restore point
6. **Verify after deployment** — Run consistency checks
7. **Communicate changes** — Notify users of contract address changes
8. **Keep RPC endpoints updated** — Monitor Stellar network changes

---

## Troubleshooting

### Deployment fails with "Network not found"

```bash
# Add network to Stellar CLI
stellar network add --rpc-url https://soroban-testnet.stellar.org testnet
```

### Consistency check shows divergence

```bash
# Check RPC endpoint health
./scripts/failover.sh --check

# Switch to backup endpoint
./scripts/failover.sh --switch https://horizon-testnet.stellar.org

# Re-verify
./scripts/failover.sh --verify
```

### Contract ID not found after deployment

```bash
# Check deployment log
cat deployments.log

# Verify contract exists
soroban contract info --id CAAAAAAA... --network testnet
```

---

## Related Documentation

- [Deployment Guide](deployment-guide.md) — Single-region deployment
- [Disaster Recovery](disaster-recovery.md) — Recovery procedures
- [Backup System](backup-system.md) — Backup and restore
- [Monitoring Guide](monitoring-guide.md) — Health monitoring
