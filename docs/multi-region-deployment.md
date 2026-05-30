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

### Automatic Failover

The exporter automatically switches to backup RPC if primary is unavailable:

```python
# In monitoring/exporter/exporter.py
def _fetch_events(self) -> list:
    try:
        # Try primary RPC
        response = requests.get(f"{self.rpc_url}/events", timeout=10)
        response.raise_for_status()
        return response.json().get("events", [])
    except requests.RequestException:
        # Switch to backup RPC
        backup_rpc = get_backup_rpc(self.network)
        response = requests.get(f"{backup_rpc}/events", timeout=10)
        return response.json().get("events", [])
```

### Manual Failover

Switch to backup RPC endpoint manually:

```bash
# Check endpoint health
./scripts/failover.sh --check

# Switch to backup endpoint
./scripts/failover.sh --switch https://horizon-testnet.stellar.org

# Verify switch
./scripts/failover.sh --verify
```

### Failover Configuration

```bash
# In .env
STELLAR_RPC_URL=https://soroban-testnet.stellar.org
STELLAR_RPC_BACKUP=https://horizon-testnet.stellar.org
RPC_FAILOVER_TIMEOUT=10
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
#       primary: 42 credentials
#       backup: 42 credentials
#       ✓ Consistent
#
#     mainnet (CAAAAAAA...):
#       primary: 100 credentials
#       backup: 100 credentials
#       ✓ Consistent
```

### Consistency Checks

The verification script checks:

1. **Credential count** — Same across all RPC endpoints
2. **Slice count** — Same across all RPC endpoints
3. **Contract state hash** — Identical across regions
4. **Attestation records** — Consistent across endpoints

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
