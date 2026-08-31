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

### 1.4 Migration Interrupted Mid-Run

A chunked contract migration (see [Paginated / Chunked Migration Protocol](./contract-upgrade-strategy.md#paginated--chunked-migration-protocol))
that stops partway through — orchestrator crash, host reboot, RPC outage — is
**not a data-loss event**. Progress lives on-chain in the job's `MigrationJob`
cursor, not in the orchestrator process.

1. Confirm the job's on-chain state: `soroban contract invoke -- get_migration_job --migration-id <id>`.
2. If `status` is `InProgress`, just restart `scripts/migration_orchestrator.py` —
   it re-reads the cursor on startup and resumes from there. No flags, no manual
   range bookkeeping, and no risk of re-processing already-migrated items.
3. If `status` is `Completed`, no action is needed; re-running the orchestrator
   against a completed job is a safe no-op.

### 1.5 Frontend / Dashboard Outage

1. Redeploy from the latest tagged release on the `main` branch via the CI/CD pipeline (`workflow_dispatch` on `deploy.yml`).
2. If the hosting provider is unavailable, deploy to an alternate static host using `npm run build` output from `frontend/` or `dashboard/`.

### 1.6 API Server Compromise

Use this procedure if there is evidence the `api-server` process, its host, or one of its secrets (`HMAC_SIGNING_SECRET`, `SHARE_LINK_HMAC_SECRET`, `BRIDGE_HMAC_SECRET`) has been compromised. The API server never holds credential-issuing authority itself — it only relays requests to the contracts and serves the search index — so compromise here is a confidentiality/availability incident, not a direct threat to on-chain state, but a compromised signing secret can be used to forge request signatures against downstream consumers.

1. **Contain**: take the affected `api-server` instance(s) out of rotation at the load balancer / DNS level immediately. Do not wait for root-cause analysis to pull it offline.
2. **Rotate every secret** the compromised instance had access to, even if you are not sure which one was used:
   - `HMAC_SIGNING_SECRET`, `SHARE_LINK_HMAC_SECRET`, `BRIDGE_HMAC_SECRET` — generate new values, update the secret store / GitHub Actions secrets, redeploy.
   - Any RPC credentials or `TRUSTED_IPS`/`TRUSTED_HEADER_VALUE` bypass values.
   - Note: contract-level secrets (`STELLAR_SECRET_KEY`) are **not** stored on the API server; only rotate those too if the same host or operator also held them (see §1.1).
3. **Invalidate sessions/tokens**: any share links or signed requests issued under the old `HMAC_SIGNING_SECRET`/`SHARE_LINK_HMAC_SECRET` become unverifiable once rotated — this is intentional; treat pre-rotation links as revoked.
4. **Redeploy clean**: rebuild and redeploy `api-server` from a known-good `main` commit rather than restarting the compromised instance, in case of a persisted backdoor.
5. **Audit**: pull request logs (rate limiter / DDoS protection middleware logs, see `api-server/src/middleware/`) for the suspected compromise window to scope what the attacker could have read (the search index is read-only relative to credential data — nothing in it grants issuance/attestation rights) or done (forged signatures on outbound requests).
6. **Post-incident**: log cause and resolution per Step 5 of the [Recovery Runbook](#3-recovery-runbook); if the compromise involved a code-level vulnerability, follow the coordinated disclosure process in [SECURITY.md](../SECURITY.md).

### 1.7 Contract Bug Discovery — Emergency Pause

Use this procedure the moment a contract bug is discovered that could be exploited before a fix ships — do not wait for a full root-cause before pausing.

**All three contracts (quorum_proof, sbt_registry, zk_verifier) support per-contract pause/unpause.**

1. **Pause the affected contract(s) immediately.** Two mechanisms exist:
   - **quorum_proof only** — `soroban contract invoke <QUORUM_PROOF_ID> emergency_pause --admin <ADMIN> --reason "<short description>"` — moves to `CircuitBreakerState::Paused`, blocks all mutating calls, logged as a `CircuitBreaker` event. Lighter option: `emergency_degrade` to rate-limit writes instead. Both auto-recover after `ttl_seconds` if `auto_recover` is enabled — check `get_circuit_breaker_state()`.
   - **All three contracts** — `soroban contract invoke <CONTRACT_ID> pause --admin <ADMIN>` — simpler binary pause flag (`is_paused()` returns true). Does not carry a reason or auto-recover; requires manual `unpause`. Use when you need immediate, unconditional halt across all state-changing operations in a contract.
2. **Confirm pause took effect**: 
   - quorum_proof: `soroban contract invoke <QUORUM_PROOF_ID> get_circuit_breaker_state` or `soroban contract invoke <QUORUM_PROOF_ID> is_paused`
   - sbt_registry: `soroban contract invoke <SBT_REGISTRY_ID> is_paused`
   - zk_verifier: `soroban contract invoke <ZK_VERIFIER_ID> is_paused`
3. **Assess exploitability**: can the bug be triggered by a read-only call, or does it require a mutating call that is now blocked? A read-path bug is not mitigated by pausing writes.
4. **Fix, test, redeploy**: develop the fix against a testnet fork, run the full contract test suite plus a regression test that reproduces the original bug, then follow §1.2 (Contract Redeployment).
5. **Resume** once the fix is live and verified:
   - quorum_proof: `soroban contract invoke <QUORUM_PROOF_ID> resume --admin <ADMIN>` (circuit breaker) or `unpause` (binary flag)
   - sbt_registry: `soroban contract invoke <SBT_REGISTRY_ID> unpause --admin <ADMIN>`
   - zk_verifier: `soroban contract invoke <ZK_VERIFIER_ID> unpause --admin <ADMIN>`
   - Do not resume on a timer; resume only after the fix is confirmed deployed.
6. **Disclose** per [SECURITY.md](../SECURITY.md)'s embargo guidance once affected users have had a chance to act.

#### Emergency Withdrawal Considerations

There is **no separate "emergency withdrawal" function that bypasses the pause** — attestor stake withdrawal (`withdraw_attestor_stake`) itself calls `require_not_paused`, so **pausing the contract also blocks attestors from withdrawing their bonded stake** until it is unpaused or degraded-mode-only writes are re-enabled. This is a deliberate trade-off (a paused contract must not leak funds through any path, including withdrawal, while its integrity is in question) but it means:

- Do not pause and then leave the contract paused indefinitely while attestors have funds locked — resolve the bug and resume as quickly as safely possible.
- If a bug is scoped narrowly enough that stake withdrawal is definitely unaffected, prefer `emergency_degrade` over a full `emergency_pause` so legitimate withdrawals can continue at a rate-limited pace while the issue is investigated.
- Communicate the pause and its expected duration to attestors — locked stake during an active pause is expected operator communication, not a silent freeze.

### 1.8 Credential Database / Search Index Corruption

QuorumProof has no traditional off-chain database of record — the source of truth is always on-chain contract state. "Database corruption" in this system means the **search index** (`api-server/src/searchIndex.ts`) or a **local state snapshot** (§2.1) diverging from on-chain truth, not corruption of a SQL/NoSQL store.

1. **Detect**: `./scripts/verify_snapshot.sh` (§2.2) or a manual comparison of `get_credential_count()` against the search index's indexed count surfaces divergence.
2. **Do not trust the index for verification decisions** while corruption is suspected — `verify_engineer` and other verification paths ultimately check on-chain state via cross-contract calls, but any API-server-side caching or search results should be treated as advisory only until rebuilt.
3. **Rebuild from chain**: the search index is derived data, not authoritative — take the affected `api-server` instance out of rotation, clear its in-memory/cached index, and rebuild it by replaying on-chain credential/slice/attestation state from genesis (or from the last known-good snapshot per §2.1, then catching up from the current ledger).
4. **Verify**: re-run `./scripts/verify_snapshot.sh` and spot-check a sample of credentials via `get_credential` directly against the contract to confirm the rebuilt index matches chain state.
5. **Root-cause** before returning to service if the divergence was caused by an API-server bug (e.g. a missed event) rather than an infrastructure fault — otherwise the rebuilt index will drift again.

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

### 2.3 Recovery Time & Recovery Point Objectives (RTO/RPO)

RTO is the target time to restore service; RPO is the maximum acceptable
data loss, measured in time since the last durable backup/state. Because
credential and attestation data is written directly to the Stellar chain,
on-chain data has an effective RPO of zero — it is never behind a backup
cadence. RPO only applies to off-chain supporting state (snapshots, search
index, frontend deployments) that is not itself blockchain-native.

| Scenario | RTO (target) | RPO (target) | Basis |
|---|---|---|---|
| Lost deployer/admin key (backup key exists) | < 1 hour | 0 (no data loss — on-chain state untouched) | §1.1 |
| Lost deployer/admin key (no backup) | Not recoverable — full redeploy + re-issuance | Full loss of on-chain credential history under the old contract address | §1.1 |
| Contract redeployment (bug fix) | 2–4 hours (build, deploy, restore state) | 0 for chain data; up to 24h for off-chain snapshot freshness | §1.2, §3 |
| RPC / network outage | < 15 minutes (config change only) | 0 | §1.3 |
| Migration interrupted mid-run | < 30 minutes (resume from cursor) | 0 — cursor lives on-chain | §1.4 |
| Frontend / dashboard outage | < 1 hour | 0 (stateless, redeployed from source) | §1.5 |
| API server compromise | < 1 hour to contain + rotate secrets; full redeploy within 4 hours | 0 for chain data; search index rebuild time is separate (see below) | §1.6 |
| Contract bug — emergency pause | < 15 minutes to pause; fix timeline varies by severity | 0 (pause blocks writes, does not lose data) | §1.7 |
| Credential DB / search index corruption | 1–4 hours to rebuild from chain, depending on total credential count | 0 — index is fully derivable from on-chain state | §1.8 |
| State snapshot loss (off-chain backup) | N/A — snapshots are a convenience, not authoritative | Up to 24 hours (daily snapshot cadence, §2) — acceptable because chain data itself is not lost | §2 |

These targets assume the backup key, contract IDs, and off-chain snapshots
required by §2 are actually in place and current — an untested or missing
backup key changes the "lost key" row from < 1 hour to "not recoverable."
Recovery drills (§4) exist specifically to validate these targets are
achievable, not just aspirational.

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

### 4.5 Emergency Pause Drill (quarterly)

1. On testnet, call `emergency_pause` with a test reason and confirm `get_circuit_breaker_state()` returns `Paused`.
2. Confirm a mutating call (e.g. `issue_credential`) is rejected while paused.
3. Confirm `withdraw_attestor_stake` is also rejected while paused (see §1.7, Emergency Withdrawal Considerations) — this is expected behavior, not a bug.
4. Call `resume` and confirm normal operation returns, including that a previously-blocked withdrawal now succeeds.
5. Repeat with `emergency_degrade` and confirm writes are rate-limited rather than fully blocked.

### 4.6 API Secret Rotation Drill (quarterly)

1. On a non-production `api-server` instance, rotate `HMAC_SIGNING_SECRET` per §1.6.
2. Confirm requests signed with the old secret are rejected and requests signed with the new secret succeed.
3. Confirm the rotation process (secret store update → redeploy) completes within the §2.3 RTO target for API server compromise.

### 4.7 Checklist

- [ ] Deployer key backup verified in cold storage
- [ ] Contract IDs recorded and accessible to the team
- [ ] Secondary admin key registered on-chain
- [ ] CI deploy workflow tested via `workflow_dispatch`
- [ ] RPC failover endpoint confirmed reachable
- [ ] Latest snapshot verified and uploaded to off-chain storage
- [ ] Restore drill completed successfully on testnet
- [ ] Emergency pause/resume drill completed, including withdrawal-blocked-while-paused check
- [ ] API secret rotation drill completed within RTO target
- [ ] Recovery drill results logged with date and outcome

---

## 5. Roles & Responsibilities

DR events fail more often from ambiguity about who does what than from a missing technical step. Every recovery event (declared per §3 Step 1) has exactly one Incident Commander; every other role reports status to that person rather than acting independently.

| Role | Responsibilities | Primary | Backup |
|---|---|---|---|
| **Incident Commander (IC)** | Declares the incident, decides which runbook section applies (§1), authorizes pausing/redeploying contracts, calls the "all clear" | On-call lead engineer | Engineering manager |
| **Chain/Contract Lead** | Executes contract-level actions: `emergency_pause`/`emergency_degrade`, admin key rotation (§1.1), redeployment (§1.2), migration resume (§1.4) | Smart contract maintainer | Second contract maintainer |
| **Infra Lead** | Executes infrastructure actions: RPC failover (§1.3), frontend/dashboard redeploy (§1.5), API server containment and secret rotation (§1.6) | DevOps/infra owner | Backend maintainer |
| **Data/Recovery Lead** | Owns snapshot verification and restore (§2, §3 Step 2/4), confirms credential counts post-recovery | Backend maintainer | Chain/Contract Lead |
| **Communications Lead** | Owns all external and internal messaging per §6; ensures status updates go out on schedule regardless of technical progress | Product/support owner | Incident Commander (if no dedicated owner is available) |
| **Scribe** | Logs a timestamped record of every action taken during the incident for the post-incident report (§3 Step 5) | Any available team member assigned by the IC | — |

Role assignment happens at the start of Step 1 (Declare Incident) in the Recovery Runbook (§3) — the IC names the Chain/Contract Lead, Infra Lead, Data/Recovery Lead, and Communications Lead explicitly in the ops channel before work begins, even if one person temporarily covers more than one role. A role with no assigned person is treated as a gap and the IC must fill it before proceeding past Step 1.

On-call rotation for each role is maintained outside this document (team calendar / paging tool); this table defines *what each role does*, not the current roster, so it does not go stale as people rotate on and off call.

### 5.1 Escalation Path

1. On-call engineer detects or is paged for an anomaly and makes the initial call on whether it meets the bar for a declared DR incident (see §1 for the list of recognized scenarios).
2. If yes, the on-call engineer becomes IC by default and immediately names the other roles from §5, or explicitly stays IC and self-covers unfilled roles.
3. If the incident is more severe than the on-call engineer can resolve alone (e.g. suspected key compromise, exploitable contract bug), the IC escalates to the engineering manager, who may reassign the IC role.
4. Any team member can trigger escalation to the engineering manager directly if they believe an incident is under-resourced, regardless of what the current IC has decided.

---

## 6. Communication Plan

Communication runs on a fixed cadence during an active incident — it does not wait for the technical situation to change, because "no update" is itself information (it tells stakeholders the team is still working, not stalled).

### 6.1 Internal Communication

| Audience | Channel | Cadence | Owner |
|---|---|---|---|
| Engineering / on-call | Ops channel (real-time) | Continuous during incident | All responders |
| Leadership | Direct message / incident summary doc | At declaration, then every 30–60 minutes until resolved | Communications Lead |
| Full team | Team-wide channel | At declaration and at resolution | Communications Lead |

### 6.2 External Communication

| Audience | Channel | Trigger | Owner |
|---|---|---|---|
| Attestors / institutional issuers | Email / partner channel | Any event that pauses the contract or blocks stake withdrawal (§1.7) | Communications Lead |
| End users (holders/verifiers) | Status page or in-app banner | Any event affecting availability of verification or issuance | Communications Lead |
| Security researchers (if applicable) | [SECURITY.md](../SECURITY.md) disclosure process | Contract bug incidents only, after user-facing mitigation is in place | Incident Commander |

### 6.3 Message Content Guidelines

Every external update states, at minimum: what is affected, what is not affected (e.g. "on-chain credential data is not at risk"), and when the next update will be sent. Do not speculate on root cause publicly before it is confirmed — state what is being investigated instead.

### 6.4 Post-Incident Communication

Within 5 business days of resolution, the Communications Lead circulates a summary covering: timeline, impact, root cause, and remediation — sourced from the Scribe's log (§5) and the recovery runbook's Step 5 record (§3).

---

## 7. DR Testing Schedule Summary

This table consolidates the individual drills already defined in §4 into a single quarterly-first schedule, so the cadence is auditable at a glance without reading every subsection.

| Drill | Cadence | Reference | Owner |
|---|---|---|---|
| Key Recovery Drill | Quarterly | §4.1 | Chain/Contract Lead |
| Contract Redeployment Drill | Per release | §4.2 | Chain/Contract Lead |
| Snapshot & Restore Drill | Monthly | §4.3 | Data/Recovery Lead |
| RPC Failover Drill | Quarterly | §4.4 | Infra Lead |
| Emergency Pause Drill | Quarterly | §4.5 | Chain/Contract Lead |
| API Secret Rotation Drill | Quarterly | §4.6 | Infra Lead |
| Full DR Tabletop Exercise (all roles, simulated incident end-to-end using §5 role assignments and §6 communication cadence) | Quarterly | New — run alongside the quarterly drills above | Incident Commander |

The Incident Commander is responsible for scheduling the quarterly batch (Key Recovery, RPC Failover, Emergency Pause, API Secret Rotation, and the Tabletop Exercise together) at the start of each calendar quarter and confirming completion against the §4.7 checklist before quarter-end.
