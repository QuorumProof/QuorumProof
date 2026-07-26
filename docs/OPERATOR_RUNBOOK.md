# Operator Runbook for Common Incidents — Issue #1254

## Overview

This runbook provides step-by-step procedures for responding to operational incidents in the QuorumProof platform. It covers common scenarios, decision trees, escalation paths, and remediation procedures for both technical and security-related incidents.

**Use this guide when**: Something is broken, performance is degraded, or a security incident occurs.

---

## Table of Contents

1. [Incident Severity Levels](#incident-severity-levels)
2. [Incident Response Process](#incident-response-process)
3. [Decision Tree](#decision-tree)
4. [Common Incidents](#common-incidents)
5. [Escalation Matrix](#escalation-matrix)
6. [Communication Templates](#communication-templates)
7. [Post-Incident Procedures](#post-incident-procedures)

---

## Incident Severity Levels

| Level | Name | User Impact | Example | Response SLA |
|-------|------|-------------|---------|--------------|
| **S0** | Critical | All users affected, system down | Attestor compromise, credential verification offline | 5 min |
| **S1** | High | Significant user impact, partial outage | API latency >10s, 50% credential validation failures | 15 min |
| **S2** | Medium | Some users impacted, degraded service | Single issuer unable to issue, 10% failure rate | 1 hour |
| **S3** | Low | Minor impact, workarounds available | Slow audit log queries, cosmetic UI bug | 4 hours |
| **S4** | Info | No immediate impact | Routine updates, maintenance | Next business day |

---

## Incident Response Process

### Phase 1: Detection (0-2 min)

**Trigger**: Alert, user report, or automated monitoring

```
Step 1: Identify severity level using decision tree
Step 2: Page on-call engineer (S0-S1) or log ticket (S2-S4)
Step 3: Create incident channel in Slack (#incident-TIMESTAMP)
Step 4: Add incident ID to all communications
```

### Phase 2: Triage (2-10 min)

**Objective**: Understand scope and root cause quickly

```
Step 1: Gather initial information
   - When did incident start?
   - What systems are affected?
   - How many users impacted?
   - Any recent changes?

Step 2: Assess if emergency action needed
   - Is a system down? (restart)
   - Is data being corrupted? (stop writes)
   - Is security compromised? (isolate/alert)

Step 3: Assign incident lead and communications lead
   - Lead: technical investigation
   - Communications: status updates, notifications
```

### Phase 3: Mitigation (10-30 min)

**Objective**: Reduce customer impact immediately

```
Step 1: Implement quick fix if obvious
   - Restart service
   - Scale up resources
   - Disable problematic feature

Step 2: If issue not obvious, begin investigation
   - Check logs
   - Review metrics
   - Run diagnostics

Step 3: Keep stakeholders informed
   - Update status page every 5 minutes
   - Post in incident channel
```

### Phase 4: Resolution (30 min - 4 hours)

**Objective**: Implement permanent fix

```
Step 1: Continue root cause analysis
Step 2: Implement fix
Step 3: Deploy to production
Step 4: Verify fix resolves issue
Step 5: Monitor for regression
```

### Phase 5: Close (N/A)

**Objective**: Document learnings and prevent recurrence

```
Step 1: Confirm all systems healthy
Step 2: Create post-mortem document
Step 3: Schedule postmortem meeting (within 48 hours)
Step 4: Update runbooks if necessary
Step 5: Close incident
```

---

## Decision Tree

Use this tree to determine incident severity and initial response:

```
                     INCIDENT DETECTED
                            |
                   ┌────────┴────────┐
                   |                 |
              Is system DOWN?     Can users GET DATA?
              (no api response)   (read operations)
                   |                 |
                  YES              YES
                   |                 |
              ┌────┴────┐        ┌────┴────┐
         MANUAL   DATABASE   Can users SET DATA?  Are MOST
         FAILOVER  RESTORE   (write operations)  credentials
         NEEDED?   NEEDED?         |              VALIDATING?
          |         |            YES              |
         [S0]      [S0]        ┌──┴──┐           YES
                              Can ISSUE   ┌────┴────┐
                              credentials? Isolated Widespread
                                  |        ISSUER    PROBLEM?
                                 YES       PROBLEM    |
                                  |        [S2]      [S1]
                              ┌───┴───┐
                         SINGLE  MANY
                         ISSUER  ISSUERS
                           |       |
                         [S2]    [S1]
```

### Severity Decision Flowchart

**Start here when incident is detected:**

1. **Is the API responding?**
   - No → **S0: Critical** (skip to API Recovery)
   - Yes → Continue to step 2

2. **Can credentials be verified?**
   - No → **S0: Critical** (Credential Verification Offline)
   - Partially (< 50%) → **S1: High** (Verification Degradation)
   - Yes → Continue to step 3

3. **Can credentials be issued?**
   - No → **S1: High** (Issuance Offline)
   - Partially (1 issuer) → **S2: Medium** (Issuer Failure)
   - Yes → Continue to step 4

4. **Is data being corrupted?**
   - Yes → **S0: Critical** (Data Integrity Issue)
   - No → Continue to step 5

5. **Is security compromised?**
   - Yes → **S0: Critical** (Security Incident)
   - No → Continue to step 6

6. **Are metrics significantly degraded?**
   - Yes (>10s latency, >10% errors) → **S1: High** (Performance Issue)
   - No → **S2-S3: Medium/Low** (Minor Issue)

---

## Common Incidents

### Incident 1: API Service Down

**Severity**: S0 (Critical)  
**Estimated Resolution Time**: 5-10 minutes

#### Detection
- Monitoring alert: "API service down"
- User reports: "Cannot access dashboard"
- Uptime check: All endpoints returning 503

#### Investigation

```bash
# Check service status
kubectl get pods -n quorumproof | grep api-server

# Check service logs
kubectl logs -n quorumproof -l app=api-server --tail=50

# Check resource usage
kubectl top pods -n quorumproof

# Check recent deployments
kubectl rollout history deployment/api-server -n quorumproof
```

#### Response Decision Tree

```
API Service Down?
├─ Pod is Running
│  ├─ Check Logs
│  │  ├─ Out of Memory → Increase Memory Limit
│  │  ├─ Database Connection Failed → Check DB Status
│  │  └─ Unhandled Exception → Rollback Last Deployment
│  │
│  └─ Check Readiness Probe
│     ├─ Failing → Service thinks it's healthy but isn't
│     └─ Restart Pod (kubectl delete pod...)
│
└─ Pod not Running / Crashing
   ├─ Resource Exhaustion → Scale up replicas
   ├─ Deployment Configuration → Rollback
   └─ Infrastructure Issue → Check Node Health
```

#### Mitigation Steps

**Immediate** (0-5 min):
```bash
# Check pod status
kubectl describe pod -n quorumproof <pod-name>

# Check for recent errors
kubectl logs -n quorumproof -l app=api-server --since=5m | grep -i error

# If pod is stuck, force restart
kubectl delete pod -n quorumproof <pod-name>

# Watch pod recovery
kubectl get pods -n quorumproof -w
```

**If restart doesn't help** (5-10 min):
```bash
# Rollback to last known good version
kubectl rollout undo deployment/api-server -n quorumproof

# Verify it's working
curl -s https://api.quorumproof.io/health | jq .
```

**If still down**:
```bash
# Check if database is reachable
kubectl run -it --rm debug --image=postgres:latest -- \
  psql -h postgres-service -U quorumproof -c "SELECT 1"

# Check Stellar RPC availability
curl -s https://soroban-testnet.stellar.org/health | jq .
```

#### Verification

```bash
# API is up
curl -s https://api.quorumproof.io/health | jq .
# Should return: {"status":"healthy","version":"x.y.z"}

# Credential verification works
curl -X POST https://api.quorumproof.io/verify \
  -H "Content-Type: application/json" \
  -d '{"credentialId":"test"}'

# Issuer API works
curl -s https://api.quorumproof.io/credentials/count
```

#### Escalation

- If rollback fails: Page Infrastructure team
- If database connection fails: Page DBA on-call
- If Stellar RPC down: Contact Stellar team (not our responsibility)

**Communications**:
```
🚨 INCIDENT #S0-2024-001: API Service Down

Detected: [TIME]
Status: INVESTIGATING
Impact: All users cannot access dashboard or verify credentials

Updates: [Slack #incident-2024-001]
```

---

### Incident 2: Attestor Compromise (Key Leaked)

**Severity**: S0 (Critical)  
**Estimated Resolution Time**: 30 minutes - 4 hours

#### Detection

**Internal signals**:
- Monitoring detects unusual issuance rate (10x normal)
- Audit log shows credentials issued at odd hours/high frequency
- Attestor reports suspicious activity

**External signals**:
- Verifiers report fraudulent credentials
- Attestor contacts us directly
- Compromised credentials appear on dark web

#### Triage Questions (2-3 min)

1. **How long has the key been compromised?**
   - Last 1 hour? → ~100 fraudulent credentials (small impact)
   - Last 24 hours? → ~1000+ fraudulent credentials (major impact)
   - Last week+? → Systemic fraud (critical)

2. **Is the attestor aware?**
   - Not yet? → Contact immediately (confidential channel)
   - Yes → Coordinate response

3. **Has the compromised key been rotated?**
   - Yes → Impact contained
   - No → Advise immediate rotation

#### Investigation

```bash
# Query suspicious credentials from this issuer
SELECT credential_id, issued_at, signature
FROM credentials
WHERE issuer_id = '<compromised-attestor>'
  AND issued_at > NOW() - INTERVAL '24 hours'
ORDER BY issued_at DESC
LIMIT 100;

# Check for unusual patterns
SELECT issued_at::date, COUNT(*) as count
FROM credentials
WHERE issuer_id = '<compromised-attestor>'
  AND issued_at > NOW() - INTERVAL '7 days'
GROUP BY issued_at::date
ORDER BY issued_at;

# Compare to historical average
SELECT AVG(daily_count) as avg_credentials_per_day
FROM (
  SELECT issued_at::date, COUNT(*) as daily_count
  FROM credentials
  WHERE issuer_id = '<compromised-attestor>'
    AND issued_at > NOW() - INTERVAL '6 months'
  GROUP BY issued_at::date
) subq;
```

#### Response Steps

**Step 1: Confirm Compromise** (0-5 min)
```
☐ Contact attestor's security lead (use emergency contact)
☐ Confirm when key was compromised
☐ Confirm key has been rotated or will be
☐ Document attestor's remediation plan
```

**Step 2: Containment** (5-15 min)
```
☐ Identify all fraudulent credentials issued during compromise window
☐ Flag credentials in database as "unverified_issuer"
☐ Prepare batch revocation list
☐ Plan communication to affected parties
```

**Step 3: Revocation** (15-30 min)
```bash
# Create revocation list
SELECT credential_id
FROM credentials
WHERE issuer_id = '<compromised-attestor>'
  AND issued_at BETWEEN '<compromise-start>' AND '<compromise-end>'
INTO revocation_list;

# Revoke in batch
curl -X POST https://api.quorumproof.io/revoke-batch \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -d '{"credentials": [...], "reason": "Attestor key compromise"}'

# Verify revocations
SELECT COUNT(*) as revoked_count
FROM credentials
WHERE status = 'revoked'
  AND issuer_id = '<compromised-attestor>';
```

**Step 4: Communication** (5-30 min)
```
🚨 SECURITY INCIDENT #S0-2024-003: Attestor Key Compromise

Affected: <Attestor Name>
Compromised Window: <TIME RANGE>
Credentials Revoked: <COUNT>
Impact: Affected credential holders will be notified

Actions Taken:
1. Compromised key revoked
2. ~X fraudulent credentials identified and revoked
3. Affected parties being notified
4. Attestor has rotated to new key

Next Steps:
1. Attestor to provide remediation plan
2. Root cause investigation
3. Re-vetting of attestor controls
4. Public postmortem

Status Updates: [Slack #incident-2024-003]
```

**Step 5: Affected Party Notification** (30-45 min)
```
Email Template:

Subject: Important Security Notice: Your Credential Status

Dear <Holder Name>,

We detected that [Attestor Name]'s signing key was compromised on 
<DATE>. As a precaution, we have revoked any credentials issued by 
them during the compromise window (<TIME RANGE>).

Your credential status: [REVOKED / NOT AFFECTED]

[If revoked]:
Your credential has been revoked and will not be accepted by verifiers. 
Please contact [Attestor Name] to have your credential re-issued once 
they confirm their systems are secure.

Questions: security@quorumproof.io

- The QuorumProof Team
```

#### Escalation

- Page: Incident Lead, Security Team, Operations Team
- Notify: Legal (potential liability), Communications (public disclosure)
- Escalate to: Board if >1000 credentials affected

#### Post-Incident

1. **Attestor Re-vetting**
   - Review their key management practices
   - Require security audit before re-enablement
   - Consider tiered re-onboarding

2. **System Hardening**
   - Implement multi-sig issuance requirement
   - Add rate limiting per issuer
   - Enhance anomaly detection

3. **Documentation**
   - Add incident to runbook as reference
   - Update threat model with findings
   - Publish security advisory

---

### Incident 3: Slice Loss (Credential Holder Loses Private Key)

**Severity**: S2 (Medium)  
**Estimated Resolution Time**: 24-48 hours

#### Detection

**Trigger**:
- User reports: "I lost my private key"
- User reports: "My wallet was compromised"
- User: "I want to revoke my slice"

#### Investigation

```bash
# Query the affected holder's slice
SELECT *
FROM slices
WHERE holder_account = '<user-stellar-account>'
ORDER BY created_at DESC;

# Check recent credential activity
SELECT credential_id, action, timestamp
FROM credential_activity_log
WHERE holder_account = '<user-stellar-account>'
ORDER BY timestamp DESC
LIMIT 20;

# Check if credentials have been accessed/shared
SELECT shared_at, shared_with, credential_id
FROM credential_shares
WHERE credential_id IN (
  SELECT credential_id
  FROM credentials
  WHERE holder_account = '<user-stellar-account>'
)
ORDER BY shared_at DESC;
```

#### Response Steps

**Step 1: Verify Identity** (initial contact)
```
☐ Confirm user identity through secondary channel
  (email confirmation, SMS, security questions)
☐ Document verification method and timestamp
☐ Note: user may not have access to their Stellar account
```

**Step 2: Assess Risk** (first 15 min)
```
Questions to answer:
☐ When did they lose access? (hours? days? weeks?)
☐ Have they checked for unauthorized credential shares?
☐ Do they suspect malicious actor access?
☐ Did they have only one copy of the private key?
```

**Step 3: Revocation Request** (if user compromised)
```bash
# If user's account may be compromised, they can request emergency revocation
# Note: This requires admin action, not blockchain tx (user can't sign)

# Create revocation request
INSERT INTO credential_revocation_requests (
  holder_account,
  reason,
  verified_by,
  requested_at
) VALUES (
  '<user-stellar-account>',
  'Private key compromise',
  '<your-admin-id>',
  NOW()
);

# Revoke all credentials
UPDATE credentials
SET status = 'revoked'
WHERE holder_account = '<user-stellar-account>';

# Log the revocation
INSERT INTO revocation_audit_log (...) VALUES (...);
```

**Step 4: Key Recovery Options** (depends on user's backup)
```
Option A: User has backup of private key
  - User generates new wallet
  - User recovers credentials onto new account
  - User updates all issuers with new account address
  - Time: 1-2 weeks (issuer coordination)

Option B: User lost all backups
  - User must request re-issuance from all attestors
  - All existing credentials revoked
  - New credentials issued to new account
  - Time: 2-4 weeks (attestor processing)

Option C: User suspects account compromise
  - Immediate emergency revocation (our step 3)
  - User investigates the compromise
  - User follows Option B for re-issuance
  - Time: 2-4 weeks
```

**Step 5: Communication with Holders**
```
Email:

Subject: Update Your Slice Due to Key Compromise

Dear <User>,

We've revoked your compromised credentials as requested. 

Next steps to restore your credentials:
1. Contact each issuer (university, employer, etc.)
2. Request new credential issuance to your new account: <NEW_ACCOUNT>
3. Update your slice with new credentials

Resources:
- Credential re-issuance guide: [LINK]
- Issuer contact list: [LINK]
- Support: help@quorumproof.io

We're here to help.
- QuorumProof Support
```

#### Escalation

- User needs help → Support team
- Multiple reports of compromise → Escalate to Security
- Potential breach → Escalate to Incident Lead

---

### Incident 4: Database Performance Degradation

**Severity**: S1 (High)  
**Estimated Resolution Time**: 30 min - 2 hours

#### Detection

- Monitoring alert: "Query latency > 5 seconds"
- Monitoring alert: "Disk I/O >80%"
- User reports: "Dashboard loading slowly"

#### Investigation

```bash
# Check database connections
SELECT pid, usename, application_name, state, query
FROM pg_stat_activity
WHERE state != 'idle'
ORDER BY query_start;

# Check long-running queries
SELECT query, query_start, NOW() - query_start as duration
FROM pg_stat_statements
ORDER BY mean_exec_time DESC
LIMIT 10;

# Check table sizes
SELECT schemaname, tablename, pg_size_pretty(pg_total_relation_size(schemaname||'.'||tablename)) as size
FROM pg_tables
WHERE schemaname NOT IN ('pg_catalog', 'information_schema')
ORDER BY pg_total_relation_size(schemaname||'.'||tablename) DESC;

# Check disk space
df -h /var/lib/postgresql

# Check missing indexes
SELECT schemaname, tablename, attname, n_distinct, correlation
FROM pg_stats
WHERE schemaname NOT IN ('pg_catalog', 'information_schema')
  AND correlation < 0
  AND n_distinct > 100
ORDER BY correlation;
```

#### Quick Fixes

**Option 1: Kill Long-Running Query** (if blocking others)
```bash
# Find blocking queries
SELECT pid, query, query_start
FROM pg_stat_activity
WHERE query NOT ILIKE '%pg_stat%'
  AND NOW() - query_start > INTERVAL '5 minutes'
ORDER BY query_start;

# Kill the query (careful!)
SELECT pg_terminate_backend(pid)
FROM pg_stat_activity
WHERE pid = <PID>;
```

**Option 2: Add Missing Index** (if identified in analysis)
```sql
-- After confirming it's missing and needed
CREATE INDEX CONCURRENTLY idx_credentials_issuer_id
ON credentials(issuer_id)
WHERE status = 'active';

-- Check index creation progress
SELECT schemaname, tablename, indexname, idx_scan, idx_tup_read, idx_tup_fetch
FROM pg_stat_user_indexes
WHERE indexname LIKE 'idx_%'
ORDER BY idx_scan DESC;
```

**Option 3: Clear Connection Pool** (if connections exhausted)
```bash
# Restart pgBouncer to clear connection pool
docker restart pgbouncer

# Verify connections
psql -h localhost -U postgres -d quorumproof -c "SELECT count(*) as active_connections FROM pg_stat_activity;"
```

**Option 4: Scale Vertically** (if resource exhaustion)
```bash
# If database is using 95%+ memory/CPU:
# Option 1: Increase instance size (requires downtime)
# Option 2: Add read replicas (if using PostgreSQL 12+)
# Option 3: Temporary disable slow features (batch processing)
```

#### Verification

```bash
# Query latency normalized
SELECT avg(extract(epoch from query_duration)) as avg_latency_ms
FROM query_log
WHERE timestamp > NOW() - INTERVAL '1 minute';

# Disk I/O normalized
iostat 1 5 | grep sda

# No slow queries running
SELECT count(*) as long_running_queries
FROM pg_stat_activity
WHERE NOW() - query_start > INTERVAL '1 minute';
```

---

## Escalation Matrix

### Who to Contact

```
INCIDENT TYPE                 SEVERITY  PRIMARY     SECONDARY     ESCALATE TO
─────────────────────────────────────────────────────────────────────────────
API Service Down              S0        On-Call Eng Infra Lead    VP Engineering
Database Failure              S0        DBA On-Call Infrastructure VP Eng + CTO
Credential Verification Fail  S0-S1     On-Call Eng API Owner     Head of Product
Attestor Key Compromise       S0        Security    Incident Lead CEO + Board
Network/Infrastructure Down   S0        Infrastructure CTO        VP Infrastructure
Data Corruption               S0        DBA         Security      Legal + Board
Security Breach (external)    S0        Security    CEO           Board + Legal

Issuer Unable to Issue        S1-S2     On-Call Eng Issuer Lead   Ops Manager
Credential Verification Slow  S1        On-Call Eng Database      Engineering Lead
High Latency                  S1        On-Call Eng Perf Team     Engineering Lead

Slice Loss (User)             S2        Support     Ops           Support Manager
Minor Bug / UI Issue          S2-S3     On-Call Eng Product Eng   Product Manager
Documentation Issue           S4        DRI         N/A           N/A
```

### Contact Information

```
📞 On-Call Engineer (24/7)
   Slack: @on-call-eng
   PagerDuty: https://pagerduty.quorumproof.io/
   Phone: [NUMBER]

🔐 Security Team
   Slack: @security-team
   Email: security@quorumproof.io (monitored 24/7)
   PagerDuty: @security-on-call

🗄️ Database Team
   Slack: @database-team
   On-Call: [PAGERDUTY]

🔧 Infrastructure Team
   Slack: @infrastructure
   On-Call: [PAGERDUTY]

📞 Stellar Support (for blockchain issues)
   Slack: [STELLAR_COMMUNITY_SLACK]
   Discord: [STELLAR_DISCORD]
   Email: support@stellar.org
```

---

## Communication Templates

### Status Page Update (Every 5 min during incident)

```
🔴 INVESTIGATING: API Service Degradation

Investigating reports of slow API response times.

Start time: [TIME]
Current status: investigating
Impact: Credential verification latency increased to 10+ seconds

Updates: [Updates]

Next update: [TIME + 5 MIN]
Slack: #incident-S0-2024-001
```

### Incident Notification (To Users)

```
Subject: Service Disruption Notice

We are experiencing [ISSUE] affecting [IMPACT].

Timeline:
- 14:30 UTC: Issue detected
- 14:35 UTC: Investigation started
- [ONGOING]

What we're doing:
- Investigating root cause
- Implementing mitigation
- Monitoring for resolution

We'll update you every 5 minutes. Latest updates in [STATUS_PAGE]
```

### All-Clear Notification (After resolution)

```
Subject: Service Restored ✓

The [ISSUE] has been resolved. All services are operating normally.

Impact summary:
- Duration: XX minutes
- Affected users: X
- Total reverts: X

What happened:
[Root cause in plain English]

What we're doing to prevent this:
1. [Action 1]
2. [Action 2]
3. [Action 3]

We'll publish a detailed postmortem in 48 hours.

- QuorumProof Team
```

### Post-Mortem Summary

```
INCIDENT POSTMORTEM
══════════════════════════════════════

Incident ID: S0-2024-001
Date: YYYY-MM-DD
Duration: XX minutes
Severity: S0

SUMMARY
One sentence summarizing what happened.

TIMELINE
14:30 UTC - Issue detected via alert
14:35 UTC - Investigation started
14:45 UTC - Root cause identified
15:00 UTC - Fix deployed
15:05 UTC - Service restored

ROOT CAUSE
Detailed explanation of what caused the issue.

CONTRIBUTING FACTORS
- Factor 1 (was not caught by monitoring)
- Factor 2 (was assumed not possible)
- Factor 3 (related to recent change X)

IMPACT
- Users affected: ~1000
- Duration: 35 minutes
- Credentials affected: 0
- Data loss: 0

REMEDIATION
1. Immediate fix deployed (15:00 UTC)
2. Monitoring alert improved
3. Configuration change validated

PREVENTION
1. Add better test coverage for scenario X
2. Improve monitoring for latency
3. Document the tradeoff that caused this
4. Review [RELATED_SYSTEM] for similar issues

LESSONS LEARNED
- We need better load testing before peak hours
- The [COMPONENT] needs refactoring
- Better communication during incident would have helped

ACTION ITEMS
[ ] Task 1 - Owner - Due date
[ ] Task 2 - Owner - Due date
[ ] Task 3 - Owner - Due date
```

---

## Post-Incident Procedures

### Immediate (Within 2 hours)

```
☐ Confirm all systems healthy and stable
☐ Close incident in incident management system
☐ Publish all-clear notification
☐ Thank everyone involved (in incident channel)
```

### Short-term (Within 24 hours)

```
☐ Schedule postmortem meeting (include on-call team + relevant stakeholders)
☐ Draft incident summary
☐ Collect data: timeline, logs, metrics
☐ Begin root cause analysis
```

### Medium-term (Within 1 week)

```
☐ Conduct postmortem meeting
☐ Finalize postmortem document
☐ Identify action items
☐ Create tickets for preventive improvements
☐ Publish summary (internal + external if security-related)
```

### Long-term (Ongoing)

```
☐ Track action items to completion
☐ Test fixes in staging environment
☐ Deploy fixes to production
☐ Verify monitoring detects similar issues
☐ Update runbook with learnings
```

### Runbook Update

After every incident, review this runbook:

```markdown
1. Did this runbook help? If not, how should it be improved?
2. Are there new decision trees to add?
3. Should any response times be updated?
4. Were there gaps in our procedures?
5. Should this incident be added as a "Common Incident"?
```

---

## Key Metrics & Thresholds

### Monitoring Thresholds

| Metric | Warning | Critical | Action |
|--------|---------|----------|--------|
| API Response Time | 2s | 5s | Page on-call |
| Database Query Latency | 1s | 3s | Investigate |
| Credential Verification Failure Rate | 1% | 5% | Page on-call |
| Disk Space Available | 20% | 10% | Alert + scale |
| Memory Usage | 80% | 90% | Auto-scale |
| CPU Usage | 70% | 85% | Auto-scale |
| Connection Pool Usage | 75% | 90% | Scale up |

### SLAs

| Metric | Target | Measurement |
|--------|--------|-------------|
| Incident Response Time (S0) | < 5 min | From alert to first engagement |
| Incident Response Time (S1) | < 15 min | From alert to first engagement |
| MTTR (Mean Time to Recover) S0 | < 30 min | From incident start to resolution |
| MTTR (Mean Time to Recover) S1 | < 2 hours | From incident start to resolution |
| Availability | 99.9% | Monthly uptime |
| Credential Verification Success Rate | 99.99% | % of valid credentials verified successfully |

---

## Runbook Maintenance

This runbook should be reviewed and updated:

- **Quarterly**: Review for accuracy and completeness
- **After every incident**: Add lessons learned and new scenarios
- **After major changes**: Update relevant incident procedures

**Last Updated**: July 2026  
**Next Review**: October 2026  
**Owner**: Operations & Reliability Team  
**Version**: 1.0

---

## Emergency Contacts

```
🚨 EMERGENCY (24/7)
On-Call Engineer: [PAGERDUTY]
Security: security@quorumproof.io

📞 BUSINESS HOURS
Operations Manager: [EMAIL]
Engineering Lead: [EMAIL]
Product Manager: [EMAIL]
```

---

**Questions?** Reach out to #operations or #incident-response on Slack.
