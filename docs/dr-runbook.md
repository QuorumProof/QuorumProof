# DR Runbook — QuorumProof

Issue #1659 — Add Disaster Recovery Testing

This runbook is the single-page reference an operator reaches for during a
live incident. For background on the DR architecture, roles, and testing
schedule, see [docs/disaster-recovery.md](disaster-recovery.md).

---

## Quick-Reference: Recovery Decision Tree

```
Symptom
  │
  ├─ API returns 503 / no response
  │     └─► Go to §1: API Server Recovery
  │
  ├─ "RPC endpoint unreachable" in logs
  │     └─► Go to §2: RPC Failover
  │
  ├─ Contract returns unexpected errors
  │     └─► Go to §3: Contract Recovery
  │
  ├─ Backup integrity check failed
  │     └─► Go to §4: Backup & Restore
  │
  ├─ API key / secret compromised
  │     └─► Go to §5: Key Rotation
  │
  └─ Cost spike / budget alert
        └─► Go to §6: Cost Containment
```

---

## §1 API Server Recovery

**RTO target: 2 minutes**

### 1a. Pod crash / OOMKilled

```bash
# Check pod status
kubectl -n quorumproof get pods -l app=quorumproof-api-server

# View crash logs
kubectl -n quorumproof logs -l app=quorumproof-api-server --previous --tail=100

# Force restart all pods
kubectl -n quorumproof rollout restart deployment/quorumproof-api-server

# Watch rollout progress
kubectl -n quorumproof rollout status deployment/quorumproof-api-server
```

### 1b. All pods crash-looping

```bash
# Check if a bad config was recently applied
kubectl -n quorumproof describe deployment quorumproof-api-server

# Roll back to the last known-good deployment
kubectl -n quorumproof rollout undo deployment/quorumproof-api-server

# Verify rollback
kubectl -n quorumproof rollout status deployment/quorumproof-api-server
```

### 1c. Manual scale-up (emergency)

```bash
# Bypass HPA and scale to a fixed count
kubectl -n quorumproof scale deployment quorumproof-api-server --replicas=5
```

**Validation:**

```bash
curl -sf http://<API_URL>/health && echo "API is up"
```

---

## §2 RPC Failover

**RTO target: 5 minutes**

Run the automated failover script:

```bash
# Check which endpoints are healthy
./scripts/failover.sh --check

# Switch to backup endpoint
./scripts/failover.sh --switch testnet-backup    # testnet
./scripts/failover.sh --switch mainnet-backup    # mainnet

# Verify state consistency
./scripts/failover.sh --verify
```

Manual override (edit .env and restart):

```bash
# .env
STELLAR_RPC_URL=https://horizon-testnet.stellar.org   # testnet backup
# STELLAR_RPC_URL=https://horizon.stellar.org          # mainnet backup

# Restart api-server to pick up new RPC URL
kubectl -n quorumproof rollout restart deployment/quorumproof-api-server
```

**Validation:**

```bash
curl -sf http://<API_URL>/api/credentials/count && echo "Credential read works"
```

---

## §3 Contract Recovery

### 3a. Contract is paused

```bash
# Check pause state
soroban contract invoke --network testnet -- is_paused

# Unpause (requires admin key)
soroban contract invoke --network testnet -- set_paused --paused false
```

### 3b. Admin key loss

Follow `docs/disaster-recovery.md §1.1`. If a backup admin key was
pre-registered, invoke `set_admin(new_admin)` from it. Otherwise, redeploy.

### 3c. Contract redeployment

```bash
./scripts/build.sh
./scripts/deploy_testnet.sh    # or deploy_mainnet.sh
# Update CONTRACT_* env vars in .env and k8s Secret
```

---

## §4 Backup & Restore

**RTO target: 60 minutes | RPO: backup cadence (default 6 h)**

### 4a. Create a snapshot

```bash
./scripts/snapshot.sh
./scripts/verify_snapshot.sh
```

### 4b. Create an encrypted backup

```bash
./scripts/backup.sh
./scripts/verify_backup.sh
```

### 4c. Restore from backup

```bash
# List available backups
ls -lth backups/

# Dry-run (no writes)
./scripts/restore_from_backup.sh --dry-run

# Live restore
./scripts/restore_from_backup.sh backups/<timestamp>.enc.tar.gz
```

### 4d. Integrity check

```bash
./scripts/check_backup_integrity.sh
```

---

## §5 Key Rotation

**RTO target: 5 minutes**

### API secret / JWT key

```bash
# Generate a new secret
NEW_SECRET=$(openssl rand -base64 48)

# Update the Kubernetes secret
kubectl -n quorumproof create secret generic quorumproof-api-server-env \
  --from-literal=JWT_SECRET="${NEW_SECRET}" \
  --dry-run=client -o yaml | kubectl apply -f -

# Restart pods to pick up new secret
kubectl -n quorumproof rollout restart deployment/quorumproof-api-server
```

After rotation, all existing JWT tokens signed with the old key will be
rejected. Users must re-authenticate.

### Stellar deployer / admin key

See `docs/disaster-recovery.md §1.1`.

---

## §6 Cost Containment

See Prometheus alert `CostBudgetWarning` / `CostBudgetCritical` (defined in
`monitoring/prometheus/alerts.yml`).

```bash
# Check current cost report
curl -sf http://<API_URL>/api/costs/report | jq .

# Identify top spenders
curl -sf "http://<API_URL>/api/costs/optimizations?top=10" | jq .

# Emergency: disable non-critical background jobs
# (set env DISABLE_BACKGROUND_JOBS=true and restart)
kubectl -n quorumproof set env deployment/quorumproof-api-server \
  DISABLE_BACKGROUND_JOBS=true
```

See `docs/cost-alert-thresholds.md` for full alert tuning guidance.

---

## Recovery Metrics & RTO/RPO Targets

These targets are tested by `scripts/dr_test_harness.sh`.

| Scenario | RTO | RPO | Test script |
|---|---|---|---|
| API pod crash | 2 min | 0 (stateless) | `dr_test_harness.sh --scenario pod_kill` |
| RPC endpoint failure | 5 min | 0 | `dr_test_harness.sh --scenario rpc_failover` |
| Key rotation | 5 min | 0 | `dr_test_harness.sh --scenario key_rotation` |
| Snapshot + restore | 60 min | Backup cadence | `dr_test_harness.sh --scenario snapshot_restore` |
| Full backup restore | 60 min | Backup cadence | `dr_test_harness.sh --scenario backup_restore` |

Run all DR tests:

```bash
./scripts/dr_test_harness.sh --all --dry-run    # validate config without live ops
./scripts/dr_test_harness.sh --all              # live run against testnet
```

---

## Post-Incident Checklist

- [ ] Document root cause in an incident ticket
- [ ] Update `docs/disaster-recovery.md` if a procedure gap was found
- [ ] Run `./scripts/validate_dr.sh` to confirm all DR scripts are consistent
- [ ] Schedule a follow-up DR drill within 30 days if the incident revealed a gap
- [ ] Notify affected users via the communication plan in `docs/disaster-recovery.md §6`
