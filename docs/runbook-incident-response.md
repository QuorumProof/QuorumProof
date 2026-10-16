# Runbook: Incident Response

> Issue #1645. This is what to do from the moment an alert fires or a problem is
> reported until the postmortem is done. It standardizes the roles, severity
> levels and first actions. Detailed per-scenario procedures are linked from
> [§5](#5-scenario-playbooks). Contact lists and on-call rotation are in
> [operational-runbook.md §7](./operational-runbook.md#contact-information).

---

## 1. Severity levels

| Severity | Definition | Examples | Response | Updates |
|---|---|---|---|---|
| **SEV-1** | Credential integrity or security at risk, or full outage | Suspected admin-key compromise; fraudulent issuance/attestation; unexplained contract pause; API down in all regions | Page immediately, 24/7; IC within **15 min** | Every 30 min |
| **SEV-2** | Major feature degraded for many users | Verification failing or badly stale; RPC circuit breaker open > 10 min; region failover active; failed contract upgrade | Page on-call; IC within **30 min** | Every 60 min |
| **SEV-3** | Partial degradation, workaround exists | Elevated latency; WebSocket drops; a backup verification failed | Business hours; ack within **4 h** | Daily |
| **SEV-4** | Cosmetic / no user impact | Dashboard panel broken; noisy alert | Normal ticket | — |

If you can't decide between two levels, pick the **higher** one. You can
downgrade later.

---

## 2. Roles

| Role | Responsibility |
|---|---|
| **Incident Commander (IC)** | Owns the incident. Makes decisions, assigns work and sets the severity. Doesn't debug. |
| **Operations lead** | Runs diagnostics and makes the changes the IC approves. |
| **Communications lead** | Status page, stakeholder and issuer updates. SEV-1 and SEV-2 only. |
| **Scribe** | Keeps the timeline in the incident log (UTC timestamps, every action and decision). |

For SEV-3 and SEV-4, one person can hold every role. For SEV-1, the IC and
the operations lead must be different people.

---

## 3. Response procedure

### 3.1 Detect and declare (first 5 minutes)

1. [ ] Acknowledge the page so the escalation stops.
2. [ ] Check it's real: look at the alert's dashboard and run
       `curl -s https://<api-host>/health | jq`.
3. [ ] Declare the incident in the ops channel:
       `INCIDENT: <one-line symptom> — SEV-<n> — IC: <name>`.
4. [ ] Open the incident log from the
       [template](./operational-runbook.md#34-incident-log-template).

### 3.2 Stabilize (mitigate first, root-cause later)

Choose the smallest action that stops the harm:

| Symptom | First mitigation |
|---|---|
| The problem started with a release or upgrade | Roll back: [runbook-rollback.md](./runbook-rollback.md) |
| Fraudulent writes are in progress, or the admin key is suspected compromised | **Pause the contract** (below) |
| RPC provider unhealthy | Fail over `STELLAR_RPC_URL` to the fallback provider ([troubleshooting D2](./troubleshooting-guide.md#d2-rpc-connectivity)) |
| Primary region down | Regional failover: `./scripts/region_failover.sh` per [multi-region-failover.md](./multi-region-failover.md) |
| Abusive traffic | Tighten rate limits / IP allowlist; see [throttling.md](./throttling.md) |
| Database saturated | Shed load (lower `CONCURRENT_LIMIT_DEFAULT`), kill runaway queries |

**Emergency contract pause.** SEV-1 only. The IC must approve and record it:

```bash
stellar contract invoke --network "$STELLAR_NETWORK" --id "$CONTRACT_QUORUM_PROOF" \
  --source-account "$ADMIN_KEY" -- pause --admin "$ADMIN_ADDRESS"
stellar contract invoke --network "$STELLAR_NETWORK" --id "$CONTRACT_QUORUM_PROOF" -- is_paused
```

A pause blocks every write, including legitimate issuance and attestation.
The communications lead must announce it straight away.

### 3.3 Diagnose

- Follow the [troubleshooting decision tree](./troubleshooting-guide.md#3-decision-tree)
  and the diagnostic procedures (D1–D6).
- Preserve evidence **before** you change anything else. That means logs
  (Loki), contract events for the affected ledger range, and a state snapshot:
  `./scripts/snapshot.sh --network "$STELLAR_NETWORK" --output snapshots/incident-<id>.json`.
- For a suspected security incident, follow [SECURITY.md](../SECURITY.md) too.
  Keep discussion in the private channel only, and don't post details in public
  issues.

### 3.4 Resolve

1. [ ] Apply the fix: roll forward, rollback, key rotation or data restoration.
2. [ ] If you paused the contract, unpause only after the IC signs off **and**
       state has been verified (`./scripts/reconcile_state.sh`, the migration
       verifier, or credential spot checks):
       ```bash
       stellar contract invoke --network "$STELLAR_NETWORK" --id "$CONTRACT_QUORUM_PROOF" \
         --source-account "$ADMIN_KEY" -- unpause --admin "$ADMIN_ADDRESS"
       ```
3. [ ] Watch the dashboards for 30 minutes. The alerts must clear and stay
       clear.
4. [ ] Declare the incident resolved in the channel and on the status page.

### 3.5 Follow up

- [ ] Postmortem within **5 business days** for SEV-1 and SEV-2 (blameless):
      timeline, impact, root cause, what went well or badly, and action items
      with owners.
- [ ] File the action items as issues and link them from the postmortem.
- [ ] Update this runbook, the [troubleshooting guide](./troubleshooting-guide.md)
      or the alert rules if they were wrong or missing.

---

## 4. Communication templates

**Initial (status page / issuers):**

> We are investigating an issue affecting *<feature>* since *<time UTC>*.
> Credential data on-chain is *<not affected / being assessed>*. Next update by
> *<time UTC>*.

**Contract paused:**

> As a precaution, QuorumProof contract writes (issuance, attestation,
> revocation) are temporarily paused while we investigate *<issue>*. Verification
> of existing credentials *<continues / is affected>*. Next update by
> *<time UTC>*.

**Resolved:**

> The issue affecting *<feature>* was resolved at *<time UTC>*. Root cause:
> *<one line>*. A full post-incident report will follow.

---

## 5. Scenario playbooks

| Scenario | Playbook |
|---|---|
| Admin or issuer key compromise | [attestor-key-custody-guide.md](./attestor-key-custody-guide.md), [disaster-recovery.md](./disaster-recovery.md) |
| Fraudulent credentials / attestations | [THREAT_MODEL_CREDENTIAL_FRAUD.md](./THREAT_MODEL_CREDENTIAL_FRAUD.md), [operational-runbook.md §3.2](./operational-runbook.md#32-critical-incident-response) |
| Failed contract upgrade | [runbook-rollback.md §3](./runbook-rollback.md#3-contract-upgrade-rollback) |
| Data loss or corruption | [backup-system.md](./backup-system.md), [disaster-recovery.md](./disaster-recovery.md) |
| Region outage | [multi-region-failover.md](./multi-region-failover.md) |
| WebSocket message drops | [operational-runbook.md — WS Message Drops](./operational-runbook.md#ws-message-drops) |
| Alert fired but you don't know what it means | [critical-event-alerting.md](./critical-event-alerting.md), [monitoring-guide.md](./monitoring-guide.md) |
