# QuorumProof Operational Runbook

Standard operating procedures for daily operations, incident response, and escalation paths for QuorumProof platform operators.

---

## Table of Contents

1. [Daily Operations](#daily-operations)
2. [Monitoring & Alerting](#monitoring--alerting)
3. [Incident Response](#incident-response)
4. [Escalation Procedures](#escalation-procedures)
5. [Maintenance Windows](#maintenance-windows)
6. [Disaster Recovery](#disaster-recovery)
7. [Contact Information](#contact-information)

---

## Daily Operations

### 1.1 Pre-Shift Checklist

**Time**: Start of each shift (every 8 hours)

**Checklist**:
- [ ] Check monitoring dashboard for alerts
- [ ] Review contract event logs from past 8 hours
- [ ] Verify all contract instances are responding
- [ ] Check RPC endpoint health
- [ ] Review dispute queue for pending resolutions
- [ ] Verify admin key accessibility (hardware wallet connected)
- [ ] Check IPFS pinning service status
- [ ] Review credential issuance volume (compare to baseline)

**Tools**:
- Grafana dashboard: `https://monitoring.quorumproof.io/grafana`
- Soroban RPC: `https://soroban-testnet.stellar.org` (testnet) or `https://soroban-mainnet.stellar.org` (mainnet)
- IPFS status: `ipfs daemon --stats` or Pinata dashboard

**Expected Baseline**:
- Credential issuance: 10-50 per day (testnet), 100-500 per day (mainnet)
- Dispute filings: 0-5 per day
- Failed transactions: < 1% of total

**Action if Baseline Exceeded**:
- Investigate unusual activity (see Section 3: Incident Response)
- Check for DDoS or spam attacks
- Review recent contract changes

---

### 1.2 Hourly Health Checks

**Time**: Every hour, automated

**Checks**:
```bash
# Check contract responsiveness
stellar contract invoke \
  --network testnet \
  --contract $CONTRACT_QUORUM_PROOF \
  -- get_credential_count

# Check RPC latency
time curl -X POST https://soroban-testnet.stellar.org \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"getLatestLedger","params":[]}'

# Check IPFS connectivity
ipfs swarm peers | wc -l

# Check contract pause status
stellar contract invoke \
  --network testnet \
  --contract $CONTRACT_QUORUM_PROOF \
  -- is_paused
```

**Expected Results**:
- `get_credential_count`: Returns u64 (no error)
- RPC latency: < 500ms
- IPFS peers: > 10
- `is_paused`: false

**Action if Check Fails**:
- See Section 3: Incident Response

---

### 1.3 Daily Credential Audit

**Time**: Once per day (recommended: 00:00 UTC)

**Procedure**:
1. Export credential count: `get_credential_count()`
2. Export slice count: `get_slice_count()`
3. Export revocation count: `get_revoked_count()`
4. Compare to previous day
5. Flag unusual changes (> 50% increase/decrease)

**Script**:
```bash
#!/bin/bash
DATE=$(date +%Y-%m-%d)
CRED_COUNT=$(stellar contract invoke --network testnet --contract $CONTRACT_QUORUM_PROOF -- get_credential_count)
SLICE_COUNT=$(stellar contract invoke --network testnet --contract $CONTRACT_QUORUM_PROOF -- get_slice_count)
REVOKED_COUNT=$(stellar contract invoke --network testnet --contract $CONTRACT_QUORUM_PROOF -- get_revoked_count)

echo "$DATE,credentials=$CRED_COUNT,slices=$SLICE_COUNT,revoked=$REVOKED_COUNT" >> audit.log
```

**Retention**: Keep audit logs for 2 years

---

### 1.4 Dispute Resolution Queue

**Time**: Twice per day (08:00 UTC, 16:00 UTC)

**Procedure**:
1. Query pending disputes: `get_pending_disputes()`
2. For each dispute:
   - Check filing timestamp
   - Verify evidence hash is accessible on IPFS
   - Notify slice members if > 24 hours old
   - Escalate if > 7 days old (see Section 4: Escalation)

**Script**:
```bash
#!/bin/bash
DISPUTES=$(stellar contract invoke --network testnet --contract $CONTRACT_QUORUM_PROOF -- get_pending_disputes)

for DISPUTE_ID in $DISPUTES; do
  DISPUTE=$(stellar contract invoke --network testnet --contract $CONTRACT_QUORUM_PROOF -- get_dispute $DISPUTE_ID)
  FILED_AT=$(echo $DISPUTE | jq .filed_at)
  EVIDENCE_HASH=$(echo $DISPUTE | jq .evidence_hash)
  
  # Check if evidence is available on IPFS
  ipfs cat $EVIDENCE_HASH > /dev/null 2>&1
  if [ $? -ne 0 ]; then
    echo "WARNING: Evidence unavailable for dispute $DISPUTE_ID"
  fi
  
  # Check age
  AGE_HOURS=$(( ($(date +%s) - $FILED_AT) / 3600 ))
  if [ $AGE_HOURS -gt 24 ]; then
    echo "ALERT: Dispute $DISPUTE_ID pending for $AGE_HOURS hours"
  fi
done
```

---

### 1.5 Key Rotation Schedule

**Frequency**: Quarterly (every 90 days)

**Keys to Rotate**:
- Admin Stellar account (if single-sig; multi-sig rotates individual signers)
- Issuer accounts (if managed by operator)
- ZK prover private key (annually)

**Procedure**:
1. Generate new key
2. Test new key with testnet deployment
3. Schedule rotation window (low-traffic period)
4. Update key in hardware wallet
5. Document old key in secure archive
6. Verify new key works with all operations

**Backup**:
- Store encrypted backup in secure vault
- Maintain geographically distributed copies
- Test recovery procedure quarterly

---

## Monitoring & Alerting

### 2.1 Metrics to Monitor

| Metric | Threshold | Severity | Action |
|--------|-----------|----------|--------|
| RPC Latency | > 1000ms | High | Check RPC endpoint, consider failover |
| Contract Error Rate | > 5% | High | Investigate error logs |
| Credential Issuance Rate | > 2x baseline | Medium | Check for spam, investigate source |
| Dispute Filing Rate | > 10/day | Medium | Monitor for abuse |
| IPFS Availability | < 80% | High | Check pinning service, add replicas |
| TTL Expiry Events | > 0 | Critical | Immediate investigation (data loss) |
| Pause Events | Any | High | Verify admin action, check logs |
| Unauthorized Auth Attempts | > 0 | Critical | Investigate potential attack |

### 2.2 Alert Configuration

**Grafana Alerts**:
```yaml
- alert: HighRPCLatency
  expr: rpc_latency_ms > 1000
  for: 5m
  annotations:
    summary: "RPC latency high: {{ $value }}ms"
    action: "Check RPC endpoint health"

- alert: HighContractErrorRate
  expr: rate(contract_errors[5m]) > 0.05
  for: 5m
  annotations:
    summary: "Contract error rate: {{ $value }}"
    action: "Review contract logs"

- alert: UnusualCredentialVolume
  expr: rate(credentials_issued[1h]) > 2 * avg_over_time(credentials_issued[24h])
  for: 10m
  annotations:
    summary: "Credential issuance spike"
    action: "Investigate source, check for spam"

- alert: TTLExpiryDetected
  expr: ttl_expiry_events > 0
  for: 1m
  annotations:
    summary: "TTL expiry detected (data loss)"
    action: "CRITICAL: Immediate investigation required"
```

### 2.3 Log Aggregation

**Logs to Collect**:
- Contract event logs (Soroban RPC)
- RPC endpoint logs
- IPFS daemon logs
- Application logs (API server, dashboard)
- Admin action logs

**Retention**: 90 days (hot), 2 years (archive)

**Tools**: ELK Stack, Datadog, or CloudWatch

---

## Incident Response

### 3.1 Incident Classification

| Severity | Response Time | Escalation | Example |
|----------|---------------|-----------|---------|
| **Critical** | Immediate (< 5 min) | Level 2 | Data loss, unauthorized access, contract exploit |
| **High** | 15 minutes | Level 1 | Service degradation, high error rate, DDoS |
| **Medium** | 1 hour | Level 1 | Unusual activity, performance degradation |
| **Low** | 4 hours | None | Minor bugs, documentation issues |

### 3.2 Critical Incident Response

**Scenario**: TTL Expiry Detected (Data Loss)

**Steps**:
1. **Immediate (< 1 min)**:
   - Pause contract: `pause()`
   - Alert Level 2 on-call engineer
   - Notify stakeholders

2. **Investigation (1-5 min)**:
   - Identify affected credentials
   - Check TTL extension logs
   - Determine root cause (code bug, missed extension, etc.)

3. **Remediation (5-30 min)**:
   - If code bug: Deploy fix
   - If missed extension: Manually extend TTL
   - Restore from backup if necessary

4. **Verification (30-60 min)**:
   - Verify affected credentials are recoverable
   - Test contract operations
   - Unpause contract

5. **Post-Incident (1-24 hours)**:
   - Root cause analysis
   - Implement preventive measures
   - Update runbook

**Escalation**: Immediately to Level 2 (Security Lead)

---

**Scenario**: Unauthorized Credential Issuance

**Steps**:
1. **Immediate (< 1 min)**:
   - Pause contract
   - Alert Level 2 on-call engineer
   - Preserve transaction logs

2. **Investigation (1-10 min)**:
   - Identify unauthorized issuer
   - Check if issuer key was compromised
   - Determine scope (how many credentials issued)

3. **Remediation (10-30 min)**:
   - Revoke unauthorized credentials
   - Rotate compromised key
   - Deploy contract fix if vulnerability found

4. **Verification (30-60 min)**:
   - Verify revocations are effective
   - Test contract with new key
   - Unpause contract

5. **Post-Incident (1-24 hours)**:
   - Security audit
   - Notify affected parties
   - Update security procedures

**Escalation**: Immediately to Level 2 (Security Lead) and Level 3 (CISO)

---

**Scenario**: High Error Rate (> 5%)

**Steps**:
1. **Immediate (< 5 min)**:
   - Check RPC endpoint health
   - Review error logs
   - Check contract state

2. **Investigation (5-15 min)**:
   - Identify error type (contract error, RPC error, network error)
   - Check for recent deployments
   - Check for DDoS or spam

3. **Remediation (15-60 min)**:
   - If RPC issue: Failover to backup RPC
   - If contract issue: Pause and investigate
   - If DDoS: Enable rate limiting

4. **Verification (60-120 min)**:
   - Monitor error rate
   - Verify normal operation
   - Document root cause

**Escalation**: To Level 1 (On-call Engineer) if not resolved in 15 minutes

---

### 3.3 High Incident Response

**Scenario**: Service Degradation (RPC Latency > 1000ms)

**Steps**:
1. **Immediate (< 5 min)**:
   - Check RPC endpoint status
   - Check network connectivity
   - Review recent changes

2. **Investigation (5-15 min)**:
   - Check RPC logs for errors
   - Monitor latency trend
   - Check for DDoS

3. **Remediation (15-60 min)**:
   - If RPC overloaded: Failover to backup RPC
   - If network issue: Contact ISP
   - If DDoS: Enable rate limiting

4. **Verification (60-120 min)**:
   - Monitor latency
   - Verify normal operation

**Escalation**: To Level 1 (On-call Engineer) if not resolved in 15 minutes

---

### 3.4 Incident Log Template

```
INCIDENT REPORT
===============

ID: INC-2026-05-29-001
Severity: [Critical/High/Medium/Low]
Status: [Open/Resolved/Closed]

Timeline:
- 2026-05-29 14:30 UTC: Alert triggered
- 2026-05-29 14:32 UTC: On-call engineer notified
- 2026-05-29 14:35 UTC: Investigation started
- 2026-05-29 14:45 UTC: Root cause identified
- 2026-05-29 15:00 UTC: Fix deployed
- 2026-05-29 15:15 UTC: Verified resolved

Root Cause:
[Description of root cause]

Impact:
- Affected users: [number]
- Affected credentials: [number]
- Duration: [time]

Resolution:
[Description of fix]

Prevention:
[Steps to prevent recurrence]

Lessons Learned:
[What we learned]

Owner: [Name]
Reviewer: [Name]
```

---

## Escalation Procedures

### 4.1 Escalation Levels

**Level 0**: Automated monitoring and alerting
- No human intervention required
- Automatic remediation (e.g., failover)

**Level 1**: On-call Engineer
- Response time: 15 minutes
- Authority: Investigate, implement fixes, pause contract
- Cannot: Deploy to mainnet, rotate admin keys

**Level 2**: Security Lead
- Response time: 30 minutes
- Authority: All Level 1 + security decisions, key rotation
- Cannot: Override business decisions

**Level 3**: CISO / Executive
- Response time: 1 hour
- Authority: All Level 2 + business decisions, public communication
- Cannot: Technical decisions (deferred to Level 2)

### 4.2 Escalation Triggers

| Condition | Escalate To | Reason |
|-----------|-------------|--------|
| Incident not resolved in 15 min | Level 1 | Requires human intervention |
| Security incident | Level 2 | Requires security expertise |
| Data loss or corruption | Level 2 | Requires security review |
| Mainnet impact | Level 3 | Requires executive approval |
| Public communication needed | Level 3 | Requires executive decision |
| Regulatory notification required | Level 3 | Requires legal review |

### 4.3 Contact Information

See Section 7: Contact Information

---

## Maintenance Windows

### 5.1 Planned Maintenance Schedule

**Frequency**: Monthly (first Sunday of each month)

**Duration**: 2 hours (02:00-04:00 UTC)

**Activities**:
- Contract upgrades
- Dependency updates
- Database maintenance
- Security patches

**Notification**:
- Announce 2 weeks in advance
- Send reminder 24 hours before
- Post status updates during maintenance

### 5.2 Maintenance Checklist

**Before Maintenance**:
- [ ] Backup contract state
- [ ] Backup database
- [ ] Notify stakeholders
- [ ] Prepare rollback plan
- [ ] Test changes on testnet

**During Maintenance**:
- [ ] Pause contract
- [ ] Deploy changes
- [ ] Run smoke tests
- [ ] Monitor for errors
- [ ] Unpause contract

**After Maintenance**:
- [ ] Verify all operations
- [ ] Check monitoring dashboard
- [ ] Document changes
- [ ] Send completion notification

### 5.3 Emergency Maintenance

**Trigger**: Critical security vulnerability or data loss

**Procedure**:
1. Pause contract immediately
2. Assess impact
3. Develop fix
4. Deploy fix to testnet
5. Test thoroughly
6. Deploy to mainnet
7. Unpause contract
8. Notify stakeholders

**No advance notice required** (security incident)

---

## Disaster Recovery

### 6.1 Backup Strategy

**What to Backup**:
- Contract state (ledger entries)
- Database (credentials, slices, disputes)
- Configuration files
- Admin keys (encrypted)

**Backup Frequency**:
- Contract state: Continuous (Stellar ledger)
- Database: Daily (incremental), Weekly (full)
- Configuration: On change
- Keys: On rotation

**Backup Location**:
- Primary: Secure vault (on-premises)
- Secondary: Cloud storage (encrypted)
- Tertiary: Geographically distributed (different region)

### 6.2 Recovery Procedures

**Scenario**: Database Corruption

**Steps**:
1. Pause contract
2. Restore database from latest backup
3. Verify data integrity
4. Replay transactions from contract logs
5. Unpause contract

**RTO**: 1 hour
**RPO**: 1 day

---

**Scenario**: Contract State Loss

**Steps**:
1. Pause contract
2. Redeploy contract from source
3. Restore state from backup
4. Verify state matches ledger
5. Unpause contract

**RTO**: 2 hours
**RPO**: Continuous (Stellar ledger is immutable)

---

**Scenario**: Admin Key Compromise

**Steps**:
1. Pause contract immediately
2. Rotate admin key
3. Audit all admin actions since compromise
4. Revoke any unauthorized changes
5. Unpause contract

**RTO**: 30 minutes
**RPO**: Depends on detection time

---

### 6.3 Disaster Recovery Testing

**Frequency**: Quarterly

**Test Scenarios**:
- [ ] Database restore from backup
- [ ] Contract state recovery
- [ ] Admin key rotation
- [ ] RPC failover
- [ ] IPFS pinning service failover

**Documentation**: Record test results and any issues found

---

## Contact Information

### 7.1 On-Call Rotation

| Role | Name | Phone | Email | Backup |
|------|------|-------|-------|--------|
| On-Call Engineer | [Name] | [Phone] | [Email] | [Backup Name] |
| Security Lead | [Name] | [Phone] | [Email] | [Backup Name] |
| CISO | [Name] | [Phone] | [Email] | [Backup Name] |

**On-Call Schedule**: [Link to calendar]

### 7.2 Escalation Contacts

**Level 1 (On-Call Engineer)**:
- Phone: [Number]
- Slack: #incidents
- Email: oncall@quorumproof.io

**Level 2 (Security Lead)**:
- Phone: [Number]
- Slack: @security-lead
- Email: security@quorumproof.io

**Level 3 (CISO)**:
- Phone: [Number]
- Slack: @ciso
- Email: ciso@quorumproof.io

### 7.3 External Contacts

**Stellar Support**:
- Email: support@stellar.org
- Slack: [Stellar Dev Slack]

**IPFS Support**:
- Email: support@protocol.ai
- Slack: [IPFS Community Slack]

**Cloud Provider** (if applicable):
- Support Portal: [URL]
- Phone: [Number]

---

## Appendix: Useful Commands

### A.1 Contract Queries

```bash
# Get credential count
stellar contract invoke --network testnet --contract $CONTRACT_QUORUM_PROOF -- get_credential_count

# Get credential details
stellar contract invoke --network testnet --contract $CONTRACT_QUORUM_PROOF -- get_credential 1

# Check if paused
stellar contract invoke --network testnet --contract $CONTRACT_QUORUM_PROOF -- is_paused

# Get pending disputes
stellar contract invoke --network testnet --contract $CONTRACT_QUORUM_PROOF -- get_pending_disputes

# Get slice details
stellar contract invoke --network testnet --contract $CONTRACT_QUORUM_PROOF -- get_slice 1
```

### A.2 Admin Operations

```bash
# Pause contract
stellar contract invoke --network testnet --contract $CONTRACT_QUORUM_PROOF \
  --source-account $ADMIN_KEY -- pause

# Unpause contract
stellar contract invoke --network testnet --contract $CONTRACT_QUORUM_PROOF \
  --source-account $ADMIN_KEY -- unpause

# Revoke credential
stellar contract invoke --network testnet --contract $CONTRACT_QUORUM_PROOF \
  --source-account $ISSUER_KEY -- revoke_credential $CREDENTIAL_ID
```

### A.3 Monitoring Commands

```bash
# Check RPC health
curl -X POST https://soroban-testnet.stellar.org \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"getLatestLedger","params":[]}'

# Check IPFS connectivity
ipfs swarm peers

# Monitor contract events
stellar contract invoke --network testnet --contract $CONTRACT_QUORUM_PROOF -- get_events

# Check transaction status
stellar transaction info $TX_HASH
```

---

## Document History

| Version | Date | Author | Changes |
|---------|------|--------|---------|
| 1.0 | 2026-05-29 | [Author] | Initial version |

**Last Updated**: May 29, 2026
**Next Review**: November 29, 2026

## WS Message Drops {#ws-message-drops}

### Alert: SustainedWsMessageDrops

**Meaning:** The `quorumproof_ws_messages_dropped_total` counter is growing faster than 0.1 drops/s sustained for 2+ minutes. This means one or more WebSocket clients are consuming messages slower than the server is producing them, causing the per-connection send queue (`api-server/src/ws/connectionQueue.ts`) to overflow and drop the oldest queued messages. A push-based alert is also dispatched via `alertChannels.ts` when the in-process drop window counter reaches `WS_DROP_ALERT_THRESHOLD` (default: 10) within a `WS_DROP_ALERT_WINDOW_SECONDS` (default: 60s) window.

**Impact:** Affected clients will miss real-time events. They should reconcile on reconnect via REST (see `useRealtimeUpdates.ts` which performs a full fetch on reconnect).

**Recommended operator response:**

1. Identify the affected instance: check `quorumproof_ws_connections{instance=...}` and `quorumproof_ws_messages_dropped_total{instance=...}` to pinpoint which replica is dropping.
2. Inspect client connectivity: are specific clients on slow networks, in tight receive loops, or experiencing high CPU load on their side?
3. If drops are concentrated on one client, consider terminating that WebSocket connection (the client will reconnect and reconcile via REST).
4. If drops are systemic across many connections, check server CPU and memory — an overloaded server may be unable to drain queues fast enough.
5. Tune queue limits for bursty workloads: increase `WS_SEND_QUEUE_MAX_MESSAGES` (default: 200) and/or `WS_SEND_QUEUE_MAX_BYTES` (default: 1 MiB) at the cost of higher memory usage per connection.
6. Tune alert sensitivity via `WS_DROP_ALERT_THRESHOLD` (drops per window before alerting) and `WS_DROP_ALERT_WINDOW_SECONDS` (observation window length).

## High Error Rate {#high-error-rate}

### Alert: HighErrorRate

**Meaning:** The API error rate exceeds 10% over the last 5 minutes.

**Recommended operator response:**

1. Check the API server logs for the dominant error type (contract trap, RPC timeout, validation failure).
2. Verify Soroban RPC health: `curl -X POST https://soroban-testnet.stellar.org -H "Content-Type: application/json" -d '{"jsonrpc":"2.0","id":1,"method":"getLatestLedger","params":[]}'`
3. If error rate is climbing, pause the contract to stop further failed writes while investigating.
4. If caused by a recent deploy, roll back using `scripts/upgrade_rollback.sh`.
5. See Section 3.2 (High Error Rate scenario) for the full incident procedure.

---

## API Down {#api-down}

### Alert: APIDown

**Meaning:** The `quorumproof-exporter` Prometheus target has been unreachable for more than 1 minute (`up == 0`).

**Recommended operator response:**

1. Check whether the exporter process is running: `systemctl status quorumproof-exporter` or equivalent container health check.
2. Check exporter logs for startup errors or panics.
3. Verify network connectivity between Prometheus and the exporter host/pod.
4. Restart the exporter if it has crashed.
5. If the exporter is healthy but Prometheus cannot scrape it, check firewall rules and the `scrape_configs` in `monitoring/prometheus/prometheus.yml`.

---

## Contract Paused {#contract-paused}

### Alert: ContractPaused

**Meaning:** `quorumproof_contract_paused == 1` — an admin has paused the contract. All mutating operations are blocked.

**Recommended operator response:**

1. Confirm the pause was intentional (check admin action logs and Slack/PagerDuty for a corresponding maintenance notice).
2. If unintentional, identify who triggered the pause: query the ledger for recent `pause()` invocations.
3. Once the reason is understood and resolved, unpause: `stellar contract invoke --network <net> --contract $CONTRACT_QUORUM_PROOF --source-account $ADMIN_KEY -- unpause`
4. If the pause was triggered by an automated security rule, do not unpause until the triggering condition is investigated.

---

## Low Attestation Rate {#low-attestation-rate}

### Alert: LowAttestationRate

**Meaning:** The attestation success rate has been below 50% for 10+ minutes.

**Recommended operator response:**

1. Check for errors in `quorumproof_attestation_*` metrics to identify the failure mode (timeout, auth failure, quorum threshold not met).
2. Verify that attestor nodes in the affected slices are reachable and have valid keys.
3. Check whether a recent slice configuration change reduced the effective attestor pool below the threshold.
4. Review the quorum slice model docs: `docs/quorum-slice-guide.md`.

---

## Rate Limit Spike {#rate-limit-spike}

### Alert: RateLimitSpike

**Meaning:** The rate-limit counter is increasing faster than 5 hits/s sustained for 2 minutes, indicating unusual traffic or a misbehaving client.

**Recommended operator response:**

1. Identify the source of rate-limited requests from API access logs (client IP, API key, operation).
2. If a single client is responsible, consider temporarily blocking it or reducing its quota.
3. If the spike is broad, check for a DDoS pattern and engage your CDN/WAF rate-limiting layer.
4. Review `docs/throttling.md` for configuration options.

---

## Contract Error Burst {#contract-error-burst}

### Alert: ContractErrorBurst

**Meaning:** More than 20 contract errors occurred within a 10-minute window — a sudden burst rather than a sustained high rate.

**Recommended operator response:**

1. Correlate the burst timestamp with recent deployments, cron jobs, or batch operations.
2. Inspect contract error codes in the API server logs to identify the dominant error type.
3. If the burst is still ongoing and errors are growing, pause the contract.
4. If caused by a bad deployment, roll back with `scripts/upgrade_rollback.sh`.

---

## Backup Missing {#backup-missing}

### Alert: BackupMissing

**Meaning:** No successful backup has been recorded in the last 25 hours. The expected backup cadence is every 24 hours.

**Recommended operator response:**

1. Check `scripts/automated_backup.sh` logs and the backup job scheduler (cron / CI schedule).
2. Verify that `quorumproof_backup_last_success_timestamp` is being updated by the exporter after a successful backup run.
3. Trigger a manual backup: `./scripts/backup.sh`
4. After the backup completes, confirm `quorumproof_backup_last_success_timestamp` advances and the alert resolves.
5. See `docs/backup-system.md` for the full backup architecture.

---

## Backup Verification Failed {#backup-verification-failed}

### Alert: BackupVerificationFailed

**Meaning:** `quorumproof_backup_verification_status == 0` — the most recent backup failed its integrity check. Restore from this backup may not be possible.

**Recommended operator response:**

1. Run `scripts/verify_backup.sh` manually to get detailed failure output.
2. Check whether the backup storage location is accessible and the archive is intact (no truncation, checksum mismatch).
3. If the backup is corrupted, trigger a fresh backup immediately: `./scripts/backup.sh`
4. Verify the new backup passes: `scripts/check_backup_integrity.sh`
5. Investigate the root cause (storage provider issue, interrupted write, etc.) and document in the incident log.
6. See `docs/backup-verification.md` for verification procedures.

---

## Query SLA Breach {#query-sla-breach}

### Alert: QuerySLABreach

**Meaning:** One or more operations are producing SLA violations (latency above the per-operation threshold defined in `quorumproof_query_sla_threshold_seconds`).

**Recommended operator response:**

1. Identify the affected `operation` label from the alert.
2. Check `quorumproof_contract_invocation_duration_seconds` histogram for that operation.
3. Look for recent changes that could have increased latency: new contract logic, increased data volume, degraded RPC.
4. Apply tuning guidance from `docs/performance-tuning-guide.md` section 4.
5. If latency is RPC-driven, check `RpcCircuitBreakerOpen` alert and `docs/performance-tuning-guide.md` section 4.2.

---

## Performance Regression Detected {#performance-regression-detected}

### Alert: PerformanceRegressionDetected

**Meaning:** `quorumproof_performance_regression_detected == 1` — p95 latency for an operation is ≥20% above the recorded baseline for 5+ minutes.

**Recommended operator response:**

1. Identify the affected `operation` from the alert labels.
2. Check recent deployments: did a contract or API server change land near the regression start time?
3. Compare current p95 against the baseline stored in `quorumproof_query_sla_threshold_seconds`.
4. If regression is caused by a new deploy, roll back: `scripts/upgrade_rollback.sh`.
5. See `docs/perf-regression.md` for the regression detection methodology and baseline update procedure.

---

## High P95 Latency {#high-p95-latency}

### Alert: HighP95Latency

**Meaning:** p95 contract invocation latency for an operation exceeds its configured SLA ceiling for 5+ minutes.

**Recommended operator response:**

1. Check which `operation` label is firing.
2. Look for concurrent `RpcCircuitBreakerOpen` or `DbPoolSaturated` alerts — these are common upstream causes.
3. If the issue is isolated to one operation, review recent changes to that contract path.
4. Apply tuning steps from `docs/performance-tuning-guide.md` section 4.2.
5. If latency does not resolve, consider pausing background jobs (`DISABLE_BACKGROUND_JOBS=true`) to reduce RPC load.

---

## Storage Growth Anomaly {#storage-growth-anomaly}

### Alert: StorageGrowthAnomaly

**Meaning:** The storage entries estimate is growing faster than 500 entries/s, well above normal credential issuance rates.

**Recommended operator response:**

1. Check `quorumproof_credentials_active_total` and `quorumproof_storage_entries_estimate` to confirm abnormal growth.
2. Identify the source: which issuer or API key is responsible for the volume spike?
3. Review `docs/operator-health-metrics.md` for the `get_state_metrics` snapshot interpretation.
4. If the growth is caused by a runaway integration, rate-limit or block the caller.
5. If it looks like an attack (credential spam), pause the contract and escalate to Level 2.

---

## High Credential Revocation Rate {#high-credential-revocation-rate}

### Alert: HighCredentialRevocationRate

**Meaning:** Over 30% of recent credential activity in the last hour has been revocations — a potential sign of issuer compromise or a bulk-revocation event.

**Recommended operator response:**

1. Identify which issuers are performing the revocations (check API access logs and on-chain events).
2. Verify whether this is a planned bulk-revocation (e.g., a batch cleanup) or unexpected activity.
3. If issuer keys may be compromised, pause the contract and rotate the affected keys immediately (see Section 3.2).
4. Notify affected credential holders if the revocations are unauthorized.

---

## State Version Mismatch {#state-version-mismatch}

### Alert: StateVersionMismatch

**Meaning:** More than one distinct `quorumproof_state_version` value is being reported — an upgrade may have partially rolled out, or a stale exporter is scraping an old deployment.

**Recommended operator response:**

1. Check which instances are reporting each state version: filter `quorumproof_state_version` by `instance` label.
2. Verify that all contract instances (if running multiple replicas) are on the same contract hash.
3. If a stale exporter is present, remove it from the scrape config or redeploy it pointing at the current contract.
4. If a partial upgrade is in progress, follow `docs/contract-upgrade-strategy.md` to complete or roll it back cleanly.

---

## Migration Stalled {#migration-stalled}

### Alert: MigrationStalled

**Meaning:** A migration job (`quorumproof_migration_status == 0` / InProgress) has not advanced its cursor in 30+ minutes.

**Recommended operator response:**

1. Check whether `scripts/migration_orchestrator.py` is still running and healthy.
2. Inspect migration logs for the stalled `migration_id` from the alert label.
3. Check for upstream blockers: RPC errors, storage quota, or credential lock contention.
4. If the orchestrator has crashed, restart it: `python3 scripts/migration_orchestrator.py --resume`
5. See `docs/contract-upgrade-strategy.md` for the paginated migration protocol and recovery steps.

---

## Revocation Spike {#revocation-spike}

### Alert: RevocationSpike

**Meaning:** More than 10 revocation-category critical events were emitted in the last 15 minutes.

**Recommended operator response:**

1. Check `GET /events/critical/recent?category=revocation` for the specific credentials and issuers involved.
2. Determine whether this matches scheduled or authorized bulk-revocation activity.
3. If unexpected, treat as a potential issuer compromise: pause the contract and escalate to Level 2.
4. See `docs/critical-event-alerting.md` for the full interpretation of revocation events.

---

## Dispute Raised {#dispute-raised}

### Alert: DisputeRaised

**Meaning:** One or more credential disputes were raised on-chain in the last 5 minutes.

**Recommended operator response:**

1. Retrieve dispute details: `GET /events/critical/recent?category=dispute` for topic, ledger, and tx hash.
2. Add the dispute to the resolution queue (Section 1.4).
3. Notify the relevant slice members so they can review the dispute evidence.
4. If multiple disputes fire simultaneously, escalate to Level 2 — this may indicate coordinated fraud.
5. See `docs/critical-event-alerting.md` for dispute event interpretation.

---

## Contract Upgrade Detected {#contract-upgrade-detected}

### Alert: ContractUpgradeDetected

**Meaning:** An upgrade or migration event was detected on-chain in the last 5 minutes.

**Recommended operator response:**

1. Confirm this corresponds to a planned, authorized upgrade: check the maintenance calendar and Slack.
2. If unexpected, treat as a security incident: pause the contract immediately and escalate to Level 2.
3. Verify the new contract hash matches the expected build artifact.
4. Check `GET /events/critical/recent?category=upgrade` for ledger and tx details.
5. See `docs/contract-upgrade-strategy.md` and `docs/contract-upgrade-checklist.md`.

---

## Critical Event Alerting Degraded {#critical-event-alerting-degraded}

### Alert: CriticalEventAlertingDegraded

**Meaning:** One or more critical-event alerts failed to reach a configured channel (Slack/PagerDuty) in the last 15 minutes.

**Recommended operator response:**

1. Check `api-server` logs for `alertChannels.ts` errors (authentication failures, network timeouts).
2. Verify Slack webhook and PagerDuty integration keys are valid and not rotated/expired.
3. Test channel reachability manually.
4. While degraded, monitor `GET /events/critical/recent` directly — do not assume the absence of alerts means no critical events occurred.
5. See `docs/critical-event-alerting.md` for channel configuration and troubleshooting.

---

## Region Failover Active {#region-failover-active}

### Alert: RegionFailoverActive

**Meaning:** A secondary region is now serving traffic because the primary region is unreachable.

**Recommended operator response:**

1. Confirm Route 53 health check and DNS failover have completed correctly.
2. Investigate the primary region outage: check cloud provider status page and instance health.
3. Decide whether to run a planned promotion: `scripts/region_failover.sh planned` once the primary is confirmed unavailable for an extended period.
4. When the primary recovers, follow the failback procedure in `docs/multi-region-failover.md` before switching DNS back.
5. Do not switch back without verifying Aurora data replication has caught up.

---

## Region Peer Unreachable {#region-peer-unreachable}

### Alert: RegionPeerUnreachable

**Meaning:** A region cannot reach its peer region for 5+ minutes. Failover capacity is degraded.

**Recommended operator response:**

1. Check the network link between regions (VPC peering, Transit Gateway, or direct connect health).
2. Verify the peer region's health endpoint from the alerting region.
3. If the primary region cannot reach the secondary, failover capacity is lost — treat this as high priority.
4. Engage the cloud provider if the network link itself is faulty.
5. See `docs/multi-region-failover.md` for the full failover architecture.

---

## API Latency P95 High {#api-latency-p95-high}

### Alert: ApiLatencyP95High

**Meaning:** The p95 API response latency has exceeded 500 ms for 10+ minutes.

**Recommended operator response:**

1. Check whether `RpcCircuitBreakerOpen` or `DbPoolSaturated` alerts are also firing — they are common causes.
2. Review `docs/performance-tuning-guide.md` section 4.2 for tuning steps.
3. Check API server CPU and memory usage for resource exhaustion.
4. If latency is RPC-driven, consider increasing `RPC_POOL_SIZE` or switching to the backup RPC endpoint.

---

## API Latency P99 Critical {#api-latency-p99-critical}

### Alert: ApiLatencyP99Critical

**Meaning:** The p99 API response latency has exceeded 2 s for 5+ minutes. Tail latency is critically high.

**Recommended operator response:**

1. Check the RPC circuit breaker state (`quorumproof_rpc_circuit_breaker_state`).
2. Check the concurrency queue depth — the API server may be queueing requests behind a saturated RPC pool.
3. Reduce concurrency: lower `RPC_MAX_CONCURRENT_REQUESTS` temporarily to shed tail latency.
4. See `docs/performance-tuning-guide.md` section 4.2.

---

## RPC Circuit Breaker Open {#rpc-circuit-breaker-open}

### Alert: RpcCircuitBreakerOpen

**Meaning:** `quorumproof_rpc_circuit_breaker_state == 2` — the Soroban RPC circuit breaker has tripped. Verification requests are being served from cache or failing fast.

**Recommended operator response:**

1. Check the Soroban RPC endpoint health directly.
2. Review the circuit breaker error log in the API server for the failure that tripped it.
3. If the RPC is recovering, the breaker will automatically move to half-open and probe. Do not manually reset unless necessary.
4. If the RPC is persistently down, switch to the backup RPC URL in the API server config.
5. See `docs/performance-tuning-guide.md` section 4.2 for breaker configuration.

---

## DB Pool Saturated {#db-pool-saturated}

### Alert: DbPoolSaturated

**Meaning:** Database connection pool utilisation exceeds 90%, or requests are waiting for a connection.

**Recommended operator response:**

1. Check which query paths are holding connections longest (slow query log).
2. Check for long-running transactions that are not releasing connections.
3. Temporarily reduce background job concurrency (`BACKGROUND_JOB_CONCURRENCY`) to free pool capacity.
4. If the load is genuinely growing, increase `DB_POOL_MAX` and add read replicas.
5. See `docs/performance-tuning-guide.md` section 4.2.

---

## WS Messages Dropping {#ws-messages-dropping}

### Alert: WsMessagesDropping

**Meaning:** WebSocket message drop rate exceeds 1 drop/s sustained for 5+ minutes. Slow consumers are overflowing send queues.

**Recommended operator response:**

1. Identify affected connections via `quorumproof_ws_messages_dropped_total{instance=...}`.
2. Check for slow or stalled consumers — clients on poor network connections or in tight processing loops.
3. Consider terminating connections with consistently large queues so clients reconnect and reconcile via REST.
4. Increase `WS_SEND_QUEUE_MAX_MESSAGES` if the workload is bursty and clients can catch up after spikes.
5. See the `#ws-message-drops` section above for full tuning guidance.

---

## Cost Budget Warning {#cost-budget-warning}

### Alert: CostBudgetWarning

**Meaning:** Rolling 24-hour gas cost has exceeded 80% of the configured daily budget.

**Recommended operator response:**

1. Identify top-spending operations: `GET /api/costs/optimizations`.
2. Review whether recent usage growth is expected or anomalous.
3. Apply tuning steps from `docs/cost-alert-thresholds.md` §Reducing Cost before the critical threshold is reached.
4. Consider increasing `quorumproof_cost_daily_budget_stroops` if legitimate usage has grown.

---

## Cost Budget Critical {#cost-budget-critical}

### Alert: CostBudgetCritical

**Meaning:** Rolling 24-hour gas cost has exceeded 100% of the configured daily budget.

**Recommended operator response:**

1. Immediate: check `GET /api/costs/report` for the top spenders.
2. Apply quick wins from `GET /api/costs/optimizations`.
3. Consider setting `DISABLE_BACKGROUND_JOBS=true` to shed non-critical gas spend immediately.
4. Throttle or block high-volume callers if the overage is caused by a runaway integration.
5. See `docs/cost-alert-thresholds.md` §Emergency Response.

---

## Cost Operation Spike {#cost-operation-spike}

### Alert: CostOperationSpike

**Meaning:** A single operation consumed more than 50% of the expected hourly budget allocation in the last hour.

**Recommended operator response:**

1. Identify the `operation` label from the alert.
2. Investigate at `GET /api/costs/projection?operation=<name>&callsPerDay=...` to understand the cost driver.
3. Check whether call volume spiked or per-call cost increased (e.g., larger payloads, more storage writes).
4. Apply per-operation tuning from `docs/cost-alert-thresholds.md` §Per-Operation Tuning.
