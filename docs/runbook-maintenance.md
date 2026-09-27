# Runbook: Maintenance

> Issue #1645. Routine and planned maintenance: the recurring tasks that keep
> QuorumProof healthy, and the procedure for running a maintenance window.
> Daily health checks and the on-call shift checklist are in
> [operational-runbook.md §1](./operational-runbook.md#daily-operations).

---

## 1. Maintenance windows

| Window | When (UTC) | Used for |
|---|---|---|
| Standard | Tuesdays & Thursdays 02:00–04:00 | API releases, DB migrations, infrastructure changes |
| Contract | First Wednesday of the month 02:00–05:00 | Contract upgrades, key rotations |
| Emergency | Any time, IC approval | Security patches, incident fixes |

- **Change freeze:** 14 Dec – 3 Jan, and the 48 hours before any announced
  partner launch. Only emergency changes are allowed.
- Announce standard windows **48 hours** ahead and contract windows **7 days**
  ahead, on the status page and to registered issuers.

---

## 2. Running a maintenance window

### 2.1 Before (T-48h to T-0)

- [ ] Create a change ticket with the scope, steps, expected impact, rollback
      plan and owner.
- [ ] Post the announcement. Include "writes will be paused" if you'll pause
      the contract.
- [ ] Check that the last backup is fresh and verified:
      `gh run list --workflow backup.yml --limit 1`, then
      `./scripts/verify_backup.sh <latest>`.
- [ ] Silence the alerts you expect to fire, in Alertmanager, **for the window
      only**, with the ticket ID as the comment.

### 2.2 During

- [ ] Post "maintenance started" in the ops channel.
- [ ] Do the work, following the relevant runbook
      ([deployment](./runbook-deployment.md), key rotation, etc.).
- [ ] If anything goes off-plan, roll back
      ([runbook-rollback.md](./runbook-rollback.md)). Don't improvise past the
      end of the window.

### 2.3 After

- [ ] Run the post-deployment checks from
      [runbook-deployment.md §5](./runbook-deployment.md#5-post-deployment-verification-30-minutes).
- [ ] Remove the silences **explicitly**. Don't wait for them to expire.
- [ ] Post "maintenance complete" on the status page and in the ops channel,
      then close the ticket.

---

## 3. Recurring maintenance tasks

| Task | Frequency | Procedure | Owner |
|---|---|---|---|
| Review dashboards & alert noise | Daily | [operational-runbook.md §1](./operational-runbook.md#daily-operations) | On-call |
| Verify last backup | Daily (automated) + weekly manual spot check | §3.1 | On-call |
| Dependency & image vulnerability triage | Weekly | §3.2 | Security rotation |
| Contract state reconciliation | Weekly | §3.3 | On-call |
| Storage / TTL extension review | Weekly | §3.4 | Contracts team |
| Restore drill | Monthly | §3.1 | SRE |
| Capacity review | Monthly | [capacity-planning.md](./capacity-planning.md) | SRE |
| Terraform drift check | Weekly (CI) | [infrastructure-as-code.md](./infrastructure-as-code.md) | SRE |
| Key rotation | Per [operational-runbook.md §1.5](./operational-runbook.md#15-key-rotation-schedule) | [attestor-key-custody-guide.md](./attestor-key-custody-guide.md) | Security |
| Region failover drill | Quarterly | [multi-region-failover.md](./multi-region-failover.md) | SRE |
| DR test | Semi-annually | [operational-runbook.md §6.3](./operational-runbook.md#63-disaster-recovery-testing) | SRE |
| Docs version review | Each minor release | [documentation-versioning.md §5](./documentation-versioning.md#5-deprecation-policy) | Maintainers |
| Runbook review | Quarterly, and after every SEV-1/2 | §4 | IC rotation |

### 3.1 Backups

```bash
gh run list --workflow backup.yml --limit 7          # daily runs succeeded?
./scripts/verify_backup.sh <backup>                   # integrity + decryptability
./scripts/check_backup_integrity.sh                   # hash chain
```

Once a month, restore the latest backup to a **scratch testnet contract** with
`./scripts/restore_from_backup.sh --network testnet --contract <scratch_id>`
and spot-check credentials. Never restore to production outside an incident.
See [backup-verification.md](./backup-verification.md).

### 3.2 Dependencies and images

```bash
./scripts/check_deps.sh        # cargo-deny / npm audit summary
./scripts/scan_images.sh       # container CVEs (trivy)
./scripts/scan_contracts.sh    # contract static analysis
```

Critical and high findings go in issues labelled `security`, with fix
deadlines taken from [continuous-security-testing.md](./continuous-security-testing.md).

### 3.3 State reconciliation

```bash
./scripts/reconcile_state.sh <contract_id_primary> <contract_id_replica>
```

Any "inconsistent" or "unverifiable" result needs a ticket. Recovery is
manual. See the header of `scripts/reconcile_state.sh`.

### 3.4 Storage TTL

Soroban persistent entries expire unless their TTL is extended. Check the TTL
of hot entries (`Admin`, counters, active slices) and extend any that fall
under the threshold in
[ADR-013](./adr/adr-013-instance-storage-and-ttl.md). A lapsed entry is an
outage.

### 3.5 Log retention

Archival runs automatically (`scripts/log_archive.sh`). Once a month, confirm
that the archive bucket's lifecycle rules match
[log-retention-policy.md](./log-retention-policy.md), and do a test retrieval
with `scripts/log_retrieve.sh`.

---

## 4. Keeping runbooks current

- Every runbook step has to be something you can run as written. When a script
  or flag changes, update the runbook in the same PR.
- After every SEV-1 or SEV-2, the postmortem reviews the runbooks that were
  used and records the changes as action items.
- The quarterly review walks through each runbook on testnet and fixes
  anything stale.

The runbooks are:

- [runbook-deployment.md](./runbook-deployment.md)
- [runbook-incident-response.md](./runbook-incident-response.md)
- [runbook-rollback.md](./runbook-rollback.md)
- [runbook-maintenance.md](./runbook-maintenance.md) (this page)
