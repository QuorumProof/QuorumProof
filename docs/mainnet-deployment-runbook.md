# Mainnet Deployment Runbook

## Purpose and Scope

[`docs/deployment-guide.md`](./deployment-guide.md) and [`docs/deployment-checklist.md`](./deployment-checklist.md) already document *what* the deployment process involves in prose and checklist form. This runbook is the missing **operator-facing, linear script**: the exact sequence an operator follows during an actual mainnet deployment window, start to finish, with explicit go/no-go gates. Follow this document top to bottom during a real deployment; use the other two as reference material when a step needs more explanation.

Two operators minimum are required for any mainnet deployment: one executes commands, one reads them back before submission. Neither operator holds both the deployer key and the admin key.

---

## 0. Pre-Deployment Checklist (Go/No-Go Gate)

Do not proceed past this section unless every item is checked.

- [ ] All tests pass on the exact commit being deployed: `cargo test` (clean, not from memory of a prior run)
- [ ] `cargo audit` and `cargo deny check` both report zero unresolved advisories (see `deny.toml`)
- [ ] The commit has been through code review and, for contract changes, the review referenced in [`docs/security-audit-checklist.md`](./security-audit-checklist.md) is complete
- [ ] WASM artifacts are reproducibly built (see [`docs/deployment-checklist.md`](./deployment-checklist.md) "Artifact Verification") and the build hash is recorded in the deployment ticket
- [ ] Deployer account and admin account are two **distinct** funded mainnet Stellar accounts (never the same key — see §1)
- [ ] Admin account is a multisig (see [`docs/deployment-guide.md`](./deployment-guide.md) §4.2) with signers reachable and available during the deployment window
- [ ] A rollback owner is named and has read §4 of this runbook before deployment starts
- [ ] Monitoring dashboards (see [`docs/monitoring-guide.md`](./monitoring-guide.md)) are open and confirmed reachable before the first transaction is submitted
- [ ] A maintenance/deployment window has been communicated to any dependent services (API server, dashboard)
- [ ] `.env` mainnet values are staged but contract ID fields are still blank (they get filled during §2)

If any box is unchecked, stop. Do not deploy under time pressure with an incomplete checklist — a rushed mainnet deployment is the single most common cause of the incidents in [`docs/disaster-recovery.md`](./disaster-recovery.md).

---

## 1. Funding

Mainnet has no friendbot. Funding must come from a real XLM source.

1. **Acquire XLM** for both the deployer and admin accounts through a licensed exchange or anchor (e.g. an on/off-ramp your organization already has compliance clearance for). Do not use a testnet faucet workflow — it does not exist on mainnet and any tool claiming otherwise is not talking to the real network.
2. **Fund the deployer account** with enough XLM to cover: 3 contract installs/deploys (~1–2 XLM each), plus a buffer for retries — budget **10 XLM minimum**.
3. **Fund the admin account(s)** — every signer in the admin multisig needs its own account funded with enough XLM to cover the base reserve (currently 1 XLM per account plus 0.5 XLM per additional signer/entry) and transaction fees for initialization and future admin operations. Under-funding the admin multisig is a common cause of stuck initialization — verify each signer independently:
   ```bash
   stellar account show <signer-alias> --network mainnet
   ```
4. **Record every funding transaction hash** in the deployment ticket before proceeding — this is your audit trail if a rollback or dispute happens later.
5. Confirm balances one more time immediately before the deployment window opens (balances can silently drop if a key was reused elsewhere):
   ```bash
   stellar account show deployer --network mainnet
   ```

---

## 2. Deployment Steps

### 2.1 Contract upload (install + deploy)

Follow [`docs/deployment-guide.md`](./deployment-guide.md) §2–3 to build and deploy `quorum_proof`, `sbt_registry`, and `zk_verifier` in that order. Order matters operationally (not technically — the contracts don't yet reference each other's addresses at install time) because `quorum_proof` is the contract every subsequent smoke test depends on, so deploying it first lets you catch build/deploy issues before spending fees on the other two.

After each `stellar contract deploy`, immediately:
1. Paste the returned contract ID into the deployment ticket
2. Update the corresponding `.env` field
3. Confirm the contract exists on-chain before moving to the next one:
   ```bash
   stellar contract info --id $CONTRACT_QUORUM_PROOF --network mainnet
   ```

Do not deploy all three back-to-back without this per-contract confirmation — if `quorum_proof` deployment silently failed (e.g. RPC timeout returning a stale ID), you do not want to discover it after already spending fees on the other two.

### 2.2 Initialization

Follow [`docs/deployment-guide.md`](./deployment-guide.md) §4 to call `initialize(admin)` on each contract. Two operational rules beyond what that section covers:

1. **Initialize in the same order you deployed** (`quorum_proof` → `sbt_registry` → `zk_verifier`). `quorum_proof::initialize` also registers the v1 metadata schema as the active schema as a side effect — verify this schema registration succeeded (§3.2) before initializing the other two contracts, since a failure here is cheaper to fix before other contracts are live.
2. **Use the admin multisig address, not an individual signer's address**, as the `admin` parameter. Passing an individual signer's address by mistake means that signer alone controls the contract going forward — this cannot be undone without a full redeployment (§4.3).

### 2.3 Cross-contract configuration

If this deployment wires `sbt_registry` or `zk_verifier` to trust `quorum_proof` (e.g. authorizing `quorum_proof` as the only caller allowed to mint SBTs, or registering the verifying key `zk_verifier` will check credential proofs against), perform that wiring now, immediately after all three contracts are initialized and before any real traffic is routed to them. Record every configuration call's transaction hash in the deployment ticket — these are exactly the calls a rollback needs to identify and potentially reverse.

---

## 3. Post-Deployment Verification

Do not announce the deployment as complete until all of these pass.

### 3.1 Basic liveness

```bash
stellar contract invoke --id $CONTRACT_QUORUM_PROOF --network mainnet -- get_admin
stellar contract invoke --id $CONTRACT_SBT_REGISTRY --network mainnet -- get_admin
stellar contract invoke --id $CONTRACT_ZK_VERIFIER --network mainnet -- get_admin
```
Confirm each returns the admin multisig address recorded in the deployment ticket — not an individual signer's address (see §2.2).

### 3.2 Schema/state sanity

```bash
stellar contract invoke --id $CONTRACT_QUORUM_PROOF --network mainnet -- get_active_schema_version
```
Confirm this returns `1` (the v1 schema registered during `initialize`).

### 3.3 End-to-end smoke test

Using a disposable, low-value test credential (not a real credential holder's data):
1. Issue a test credential through `quorum_proof`
2. Attest it from a test attestor account
3. Confirm the credential's attestation state reflects the attestation
4. If `sbt_registry` is wired to `quorum_proof`, confirm the corresponding SBT was minted and that a `transfer()` call on it is rejected with `SoulboundNonTransferable` (see [ADR-002](./adr/adr-002-sbt-non-transferability.md)) — this is a cheap, high-signal check that the non-transferability invariant survived deployment
5. Revoke the test credential and confirm it is reflected as revoked

Full command sequences for each of these are in [`docs/deployment-guide.md`](./deployment-guide.md) §8.

### 3.4 Monitoring confirmation

Confirm the dashboards from [`docs/monitoring-guide.md`](./monitoring-guide.md) are receiving events from the new contract IDs, not stale data from a previous deployment. Confirm alerting is wired to the new contract IDs specifically — a monitoring config left pointed at old testnet or previous mainnet contract IDs will silently fail to alert on real incidents.

### 3.5 Sign-off

Both operators (executor and reader, from the top of this document) record explicit sign-off in the deployment ticket with timestamp, before the deployment window is considered closed.

---

## 4. Rollback Procedures

Decide which rollback path applies based on severity, then execute it. Full command sequences for each path are in [`docs/deployment-guide.md`](./deployment-guide.md) §6 and [`docs/disaster-recovery.md`](./disaster-recovery.md) — this section is the decision tree, not a duplicate of those commands.

### 4.1 Decide the severity

| Situation | Path |
|---|---|
| A non-critical bug found post-deployment, contract state is otherwise healthy | §4.2 Contract upgrade rollback |
| An active exploit or critical vulnerability is being exploited right now | §4.3 Emergency pause (immediately), then evaluate upgrade vs. redeploy |
| Admin key compromise, or initialization was performed with the wrong admin address | §4.4 Full redeployment |

### 4.2 Contract upgrade rollback (non-critical regression)

Use when the previous WASM is known-good and on-chain state does not need to change. Follow [`docs/deployment-guide.md`](./deployment-guide.md) §6.1 and [`docs/contract-upgrade-strategy.md`](./contract-upgrade-strategy.md). Requires the admin multisig to approve the upgrade call — budget time for signer coordination; this is not an instant action.

### 4.3 Emergency pause (active exploit)

This is the only rollback action that should happen without waiting for full multisig coordination time if signers are reachable quickly — the goal is to stop damage first, investigate second. Follow [`docs/deployment-guide.md`](./deployment-guide.md) §6.2. After pausing:
1. Confirm read-only functions still work and write functions are blocked
2. Investigate root cause before unpausing
3. Do not unpause until a patched, reviewed, tested contract is ready to deploy — unpausing the vulnerable contract "temporarily" re-exposes the same exploit

### 4.4 Full redeployment (key compromise or bad initialization)

The most expensive path — on-chain state from the compromised contracts is not automatically migrated. Follow [`docs/deployment-guide.md`](./deployment-guide.md) §6.3 and [`docs/disaster-recovery.md`](./disaster-recovery.md) in full. Before starting, notify all issuers and credential holders that re-issuance will be required — this is a coordination-heavy process, not a pure technical one, and the coordination should start in parallel with the technical redeployment, not after it.

### 4.5 Post-rollback verification

Whichever path was taken, re-run §3 (Post-Deployment Verification) in full against the post-rollback state before declaring the incident resolved.

---

## References
- [`docs/deployment-guide.md`](./deployment-guide.md) — full command reference this runbook sequences
- [`docs/deployment-checklist.md`](./deployment-checklist.md) — exhaustive pre/post checklist detail
- [`docs/contract-upgrade-strategy.md`](./contract-upgrade-strategy.md)
- [`docs/disaster-recovery.md`](./disaster-recovery.md)
- [`docs/monitoring-guide.md`](./monitoring-guide.md)
- [`docs/security-audit-checklist.md`](./security-audit-checklist.md)
- [ADR-001: FBA Trust Model](./adr/adr-001-fba-trust-model.md), [ADR-002: SBT Non-Transferability](./adr/adr-002-sbt-non-transferability.md)
