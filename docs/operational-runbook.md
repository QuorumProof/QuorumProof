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
