# Troubleshooting Guide

A guide for diagnosing problems encountered while using QuorumProof —
whether you're an issuer, a verifier, or an end user whose credential
isn't behaving as expected. It's organized as: common errors and fixes, a
decision tree to route you to the right fix quickly, and a guide to
reading the logs you'll be looking at along the way.

For integration-specific failures (SDK/RPC-level issues hit while
*building* against QuorumProof), see
[Integration Patterns Guide §5](integration-patterns-guide.md#5-troubleshooting)
instead — this document is about diagnosing a problem with a specific
credential, transaction, or deployment.

---

## Table of Contents

1. [Common Errors and Solutions](#1-common-errors-and-solutions)
2. [Decision Tree](#2-decision-tree)
3. [Logs Interpretation Guide](#3-logs-interpretation-guide)
4. [Doc Cross-Reference Drift](#4-doc-cross-reference-drift)
5. [Where to Go Next](#5-where-to-go-next)

---

## 1. Common Errors and Solutions

| Error / Symptom | What it means | Solution |
|---|---|---|
| `Error(Contract, #1)` — `CredentialNotFound` | The credential ID doesn't exist on this contract/network | Confirm you're pointed at the right `CONTRACT_QUORUM_PROOF` address and network (testnet vs mainnet); confirm the ID was actually returned by a prior `issue_credential` call |
| `Error(Contract, #3)` — `ContractPaused` | An admin has paused the contract (usually during an incident or upgrade) | Wait for `unpause`; check the project status page or ask the issuer when service will resume |
| `Error(Contract, #4)` — `DuplicateCredential` | A credential already exists for this subject + issuer + type | Not necessarily a bug — look up the existing credential instead of re-issuing; see [Integration Patterns Guide](integration-patterns-guide.md#key-practices) for the idempotency pattern |
| Verification says "not attested" but you were told it was approved | The quorum slice threshold hasn't been met yet, or you're checking against the wrong `slice_id` | Confirm the `slice_id` used at attestation time and check `get_attestation_count` against the slice's threshold |
| Verification says a credential is invalid, but you have proof it was issued | The credential was revoked or suspended after issuance | Call `get_credential` and check the `revoked` / `suspended` fields, then check `RevocationLog` events for the reason |
| Transaction submitted but nothing happens | The transaction may still be in flight, or failed simulation silently | Look up the transaction hash via `getTransaction` on the RPC endpoint; a `PENDING` status just needs more time, `FAILED` needs the error inspected |
| "Insufficient fee" or resource-limit errors | Soroban's resource-based fee model rejected the transaction footprint | Re-simulate the transaction to get an updated resource estimate rather than reusing a stale one |
| Snapshot restore fails with `Error(Contract, #85)` | The `snapshot_id` passed to `restore_from_snapshot` doesn't exist | Call `list_snapshots()` to see valid IDs |
| Snapshot restore fails with `Error(Contract, #86)` | The snapshot's stored data no longer matches its own recorded hash — the snapshot record was corrupted | Use a different snapshot, or fall back to the off-chain backup described in [Backup System](backup-system.md) |
| Metadata (IPFS content) won't resolve | The metadata was never pinned redundantly, or the pinning service expired | Check pin status with your IPFS provider; this is a known partial-mitigation risk, see [Threat Model — Metadata Availability Loss](threat-model.md#7-risk-assessment-summary) |

The full per-code reference, including every error across all three
contracts, is in [Error Code Reference](error-codes.md) — use the table
above to triage quickly, then look up the exact code there for the
authoritative recovery steps.

---

## 2. Decision Tree

Start at the top and follow the first branch that matches your symptom.

```
Something isn't working. What are you seeing?
│
├─ A transaction/call raised "Error(Contract, #N)"
│   │
│   ├─ Is N in the 1-10 range (not-found / duplicate / basic validation)?
│   │     → Look up #N in Error Code Reference — usually a caller-side
│   │       mistake (wrong ID, wrong network, already-done action).
│   │
│   ├─ Is it #3 (ContractPaused)?
│   │     → Not a bug on your end. Check SECURITY.md / status channel
│   │       for an active incident, then retry after unpause.
│   │
│   ├─ Is it #85 or #86 (snapshot-related)?
│   │     → See Backup System — On-Chain State Snapshots.
│   │
│   └─ Is it something else / unrecognized?
│         → Capture the full error string + tx hash, check Error Code
│           Reference for the code's contract of origin, then escalate
│           (see §4) if still unclear.
│
├─ No error was raised, but the result looks wrong
│   │
│   ├─ A credential you expect to be valid reads as invalid
│   │     → Check revoked/suspended flags first (see §1), then check
│   │       attestation status against the *correct* slice_id.
│   │
│   ├─ A count (credential/slice count) looks lower than expected
│   │     → You may be reading from a stale RPC node, or an indexer
│   │       (if you built one) missed events. Re-read from the RPC node
│   │       that processed the write, or reconcile against
│   │       create_state_snapshot / get_snapshot.
│   │
│   └─ Metadata content (off-chain, e.g. IPFS) won't load
│         → The hash on-chain is still valid; this is an availability
│           problem with the metadata host, not a contract issue.
│
└─ Nothing happens at all (no error, no result)
    │
    ├─ Did you call sendTransaction and stop, without polling getTransaction?
    │     → That's expected — sendTransaction returns immediately with a
    │       PENDING-style ack; poll getTransaction until SUCCESS/FAILED.
    │
    └─ Still nothing after polling for a full ledger close cycle (~5-6s+)?
          → Check RPC node health / status; see Logs Interpretation below
            for what to look for in your own service logs.
```

---

## 3. Logs Interpretation Guide

QuorumProof produces two kinds of logs you'll typically be reading:
on-chain contract events (the authoritative record) and your own
application/service logs (network calls, retries, RPC responses).

### On-chain event logs

Every state change emits a Stellar contract event. The canonical field
reference is [Audit Log Format](audit-log-format.md); the fields you'll
use most often when troubleshooting:

- `event_type` — tells you *what happened* (`CredentialIssued`,
  `CredentialRevoked`, `AttestationRecorded`, etc.). Start here to confirm
  the action you expect actually occurred on-chain.
- `timestamp` — ledger close time (Unix seconds); compare against your
  application's local timestamp for the same action to spot clock drift
  or delayed propagation.
- `credential_id` / `slice_id` — the handles you'll cross-reference
  against your own system of record. A mismatch between "the ID my backend
  has" and "the ID that emitted this event" is one of the most common root
  causes of "verification says invalid" reports.
- `reason` (on `CredentialRevoked` and dispute-related events) — the
  human-readable justification supplied by the issuer or disputant; check
  this before assuming a revocation was erroneous.

To fetch events for a specific credential or time range, use the RPC
`getEvents` call filtered by contract ID and ledger range, as shown in
[Integration Patterns Guide §3 (Auditor Pattern)](integration-patterns-guide.md#3-auditor-pattern).

### Application/service logs

If you operate an issuer, verifier, or auditor backend:

- Log the **transaction hash** on every submitted call — it's the only
  reliable way to correlate an application-level failure with what
  actually happened on-chain (or didn't).
- Log the **raw RPC error body**, not just a summarized message —
  `Error(Contract, #N)` is easy to grep for across a fleet of logs, and
  losing the code during summarization is a common cause of "I don't know
  which error this was" support tickets.
- Distinguish **simulation failures** (rejected before submission — e.g.
  bad footprint, insufficient resource fee) from **execution failures**
  (submitted, included in a ledger, but the contract call itself panicked)
  — they need different fixes. Simulation failures are usually
  infrastructure/SDK issues; execution failures are usually the contract
  error codes covered in §1.
- If you run the on-chain snapshot/backup tooling from
  [Backup System](backup-system.md), the scheduled GitHub Actions workflow
  (`.github/workflows/backup.yml`) logs are the first place to check for a
  missed or failed backup — `gh run list --workflow backup.yml`.

---

## 4. Doc Cross-Reference Drift

With 70+ interlinked docs and ADRs, broken internal links and numbering
collisions are an ongoing maintenance hazard. This section covers the known
patterns and how to fix them.

### Broken relative links in docs/

Every PR that touches `docs/` runs the **Docs Link Check** CI workflow
(`.github/workflows/docs-link-check.yml`), which uses
[lychee](https://github.com/lycheeverse/lychee) to check all relative links
inside `docs/`. If the check fails:

1. Download the `lychee-link-report` artifact from the failed workflow run —
   it lists every broken link with the source file and line number.
2. Fix the broken references (rename the link target to match the actual
   filename, or update the link to point at the correct file).
3. Run lychee locally to confirm all links pass before pushing again:
   ```bash
   lychee --offline --no-progress --base docs "docs/**/*.md"
   ```

For a full list of links found broken on the initial run (2026-08-30) and
their recommended resolutions, see
[docs/README.md — Known doc-drift issues](README.md#known-doc-drift-issues).

### ADR-006 number collision

Two files currently share the `adr-006-` prefix:

- `docs/adr/adr-006-economic-security-model.md`
- `docs/adr/adr-006-quorum-intersection-verification.md`

If you encounter a link to `adr-006` that resolves to the wrong document,
this is the cause. The fix is to renumber one of them (the quorum-intersection
file, which was added later) to `adr-008`. Until that rename lands, be
explicit when linking — use the full filename rather than just the number.

The renaming work is tracked in
[docs/README.md — Known doc-drift issues](README.md#adr-number-collision).

---

## 5. Where to Go Next

- [Error Code Reference](error-codes.md) — authoritative per-code recovery
- [Integration Patterns Guide](integration-patterns-guide.md) — patterns and retry logic for developers
- [Audit Log Format](audit-log-format.md) — full event schema
- [Threat Model](threat-model.md) — why a given risk is rated the way it is
- [Backup System](backup-system.md) — recovering from data loss or corruption
- [Monitoring Guide](monitoring-guide.md) — dashboards and alerts for ongoing operations
- [Docs README](README.md) — contributor checklist and link checker instructions

If your issue isn't covered above and you believe it's a security
vulnerability rather than an operational problem, follow the reporting
process in [SECURITY.md](../SECURITY.md) instead of filing a public issue.
