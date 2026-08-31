# QuorumProof Documentation

This directory holds the project's long-form documentation — deployment and
operations, security and compliance, ZK verification, testing, contracts, and
API guides. This page is the index. **If you are adding a new doc, you must
also add it to the relevant section below** (CI enforces this — see
[Adding a new doc](#adding-a-new-doc)).

For Architecture Decision Records, see the dedicated sub-index at
[`adr/README.md`](./adr/README.md).

---

## Start here

New to the codebase? Read these two first:

| Doc | What it covers |
|---|---|
| [architecture.md](./architecture.md) | System overview: FBA trust slices, SBTs, the contract set, how the pieces fit together. |
| [deployment-guide.md](./deployment-guide.md) | End-to-end walkthrough: build the contracts, deploy them, initialize and wire them, verify. |

Then see [`../README.md`](../README.md) for the contribution workflow and
[`../SECURITY.md`](../SECURITY.md) for the vulnerability-reporting policy.

---

## Architecture & core concepts

| Doc | What it covers |
|---|---|
| [architecture.md](./architecture.md) | High-level system architecture and component responsibilities. |
| [economic-security-model.md](./economic-security-model.md) | Economic assumptions, incentives, and attack cost analysis (see also [ADR-006](./adr/adr-006-economic-security-model.md)). |
| [weighted-voting.md](./weighted-voting.md) | Weighted quorum voting: per-attestor trust weights (1–100) and threshold semantics. |
| [claim-types.md](./claim-types.md) | Claim type registry — the claims a credential holder can prove. |
| [credential-types.md](./credential-types.md) | Credential type registry — the credential kinds the system issues. |
| [crypto-shredding-architecture.md](./crypto-shredding-architecture.md) | Crypto-shredding design for GDPR-style erasure of off-chain personal data. |
| [METADATA_SCHEMA_VERSIONING_PLAN.md](./METADATA_SCHEMA_VERSIONING_PLAN.md) | Plan for versioning the credential metadata schema and migrating between versions. |
| [IMPLEMENTATION_NOTES_910_913_915.md](./IMPLEMENTATION_NOTES_910_913_915.md) | Implementation notes for attestation veto and related features (issues #910/#913/#915). |
| [infrastructure-improvements.md](./infrastructure-improvements.md) | Security, versioning, and state-validation infrastructure work (issues #574–577). |

---

## Deployment & Operations

| Doc | What it covers |
|---|---|
| [deployment-guide.md](./deployment-guide.md) | Primary build-and-deploy walkthrough. |
| [deployment-checklist.md](./deployment-checklist.md) | Pre-flight checklist to run before any deployment. |
| [mainnet-deployment-runbook.md](./mainnet-deployment-runbook.md) | Step-by-step mainnet deployment procedure with per-contract confirmation gates. |
| [ci-testnet-deployment.md](./ci-testnet-deployment.md) | How the automated testnet deployment pipeline works. |
| [cicd-pipeline.md](./cicd-pipeline.md) | Overview of the CI/CD pipeline stages and gates. |
| [multi-region-deployment.md](./multi-region-deployment.md) | Running the API server across multiple regions. |
| [capacity-planning.md](./capacity-planning.md) | Sizing guidance for throughput, storage, and RPC load. |
| [cost-optimization-guide.md](./cost-optimization-guide.md) | Reducing on-chain fees and infrastructure cost. |
| [database-migrations.md](./database-migrations.md) | Running and authoring API-server database migrations. |
| [backup-system.md](./backup-system.md) | Backup architecture, schedule, and restore procedure. |
| [disaster-recovery.md](./disaster-recovery.md) | Emergency pause/redeploy and credential-restoration procedures. |
| [DR_PLAN_IMPLEMENTATION.md](./DR_PLAN_IMPLEMENTATION.md) | Implementation notes for the disaster-recovery plan. |
| [resilience.md](./resilience.md) | Resilience requirements and chaos-testing approach (issue #1003). |
| [operational-runbook.md](./operational-runbook.md) | Day-to-day operational procedures. |
| [OPERATOR_RUNBOOK.md](./OPERATOR_RUNBOOK.md) | Operator-facing runbook for common incidents and tasks. |
| [troubleshooting-guide.md](./troubleshooting-guide.md) | Diagnosing common failures across contracts, API, and infra. |

---

## Monitoring & Observability

| Doc | What it covers |
|---|---|
| [monitoring-guide.md](./monitoring-guide.md) | What to monitor and how the monitoring stack is set up. |
| [observability-setup-guide.md](./observability-setup-guide.md) | Setting up metrics, logs, and traces end to end. |
| [contract-monitoring.md](./contract-monitoring.md) | Monitoring on-chain contract activity and health. |
| [critical-event-alerting.md](./critical-event-alerting.md) | Critical-event metrics and the Prometheus alert rules that fire on them. |
| [operator-health-metrics.md](./operator-health-metrics.md) | Health metrics exposed for operators and their meaning. |
| [perf-regression.md](./perf-regression.md) | Performance-regression benchmarking and thresholds. |

---

## Security & Compliance

| Doc | What it covers |
|---|---|
| [threat-model.md](./threat-model.md) | Assets, threat actors, attack vectors, and mitigations already considered. |
| [THREAT_MODEL_CREDENTIAL_FRAUD.md](./THREAT_MODEL_CREDENTIAL_FRAUD.md) | Focused threat model for credential-fraud detection (issue #1252). |
| [security-best-practices.md](./security-best-practices.md) | Security guidance for contributors and integrators. |
| [security-audit-checklist.md](./security-audit-checklist.md) | Internal review checklist used before releases. |
| [issuer-security-checklist.md](./issuer-security-checklist.md) | Security checklist for institutions issuing credentials. |
| [gdpr-compliance.md](./gdpr-compliance.md) | GDPR obligations and how the system meets them. |
| [audit-log-format.md](./audit-log-format.md) | Structure and semantics of the audit log. |
| [formal-verification.md](./formal-verification.md) | Formal verification of critical functions (issue #1317). |

---

## ZK Verification & Privacy

| Doc | What it covers |
|---|---|
| [zk-verification-developer-guide.md](./zk-verification-developer-guide.md) | Developer guide to the ZK verification flow. |
| [zk-verification-implementation.md](./zk-verification-implementation.md) | Implementation details of the ZK verifier contract. |
| [zk-api-reference.md](./zk-api-reference.md) | API reference for proof generation and verification. |
| [zk-proof-scheme-specification.md](./zk-proof-scheme-specification.md) | Specification of the proof scheme, including known limitations. |
| [plonk-verification.md](./plonk-verification.md) | PLONK verification path. |
| [groth16-migration.md](./groth16-migration.md) | Plan for migrating verification to Groth16. |
| [verification-cache-invalidation.md](./verification-cache-invalidation.md) | Correctness guarantees for the verification result cache. |
| [privacy-guide.md](./privacy-guide.md) | Credential-holder privacy guide: anonymity modes and best practices. |
| [sbt-possession-privacy.md](./sbt-possession-privacy.md) | Privacy guarantees of SBT possession commitments. |
| [bbs-plus-tutorial.md](./bbs-plus-tutorial.md) | BBS+ selective-disclosure tutorial (see also [ADR-007](./adr/adr-007-bbs-plus-selective-disclosure.md)). |

---

## Contracts, Upgrades & Migrations

| Doc | What it covers |
|---|---|
| [sdk-methods-reference.md](./sdk-methods-reference.md) | Complete reference for every contract method: signatures, params, errors. |
| [error-codes.md](./error-codes.md) | Every contract error code and what triggers it. |
| [contract-upgrade-guide.md](./contract-upgrade-guide.md) | How to perform a contract upgrade. |
| [contract-upgrade-checklist.md](./contract-upgrade-checklist.md) | Checklist to run through before and during an upgrade. |
| [contract-upgrade-strategy.md](./contract-upgrade-strategy.md) | The upgrade strategy and its rationale. |
| [scheduled-upgrades.md](./scheduled-upgrades.md) | Scheduling an upgrade to execute at a future time. |
| [migration-invariants.md](./migration-invariants.md) | Formal invariant set the migration verifier checks (enforced in CI). |
| [SLICE_MIGRATION_GUIDE.md](./SLICE_MIGRATION_GUIDE.md) | Migrating existing quorum slices (issue #1253). |

---

## API & Integrations

| Doc | What it covers |
|---|---|
| [api-client-guide.md](./api-client-guide.md) | Using the API client to talk to the API server. |
| [api-endpoint-examples.md](./api-endpoint-examples.md) | Worked request/response examples for the REST endpoints. |
| [integration-patterns-guide.md](./integration-patterns-guide.md) | Common integration patterns for verifiers and issuers. |
| [interoperability-guide.md](./interoperability-guide.md) | Interoperating with external credential systems. |
| [government-licensing-integration.md](./government-licensing-integration.md) | Protocol for licensing bodies to integrate as verified issuers. |
| [websocket-scaling.md](./websocket-scaling.md) | Scaling WebSocket delivery across multiple API-server replicas. |

See also [`../api-server/docs/API_DOCUMENTATION.md`](../api-server/docs/API_DOCUMENTATION.md)
for the auto-generated OpenAPI / Swagger reference.

---

## Testing & QA

| Doc | What it covers |
|---|---|
| [TESTING_COMPREHENSIVE_GUIDE.md](./TESTING_COMPREHENSIVE_GUIDE.md) | The overall testing strategy and how the layers fit together. |
| [API_CONTRACT_TESTING.md](./API_CONTRACT_TESTING.md) | Contract tests between the API server and its consumers. |
| [E2E_TESTING.md](./E2E_TESTING.md) | End-to-end test suite against testnet. |
| [SNAPSHOT_TESTING.md](./SNAPSHOT_TESTING.md) | Snapshot testing approach and how to update snapshots. |
| [FUZZING.md](./FUZZING.md) | Fuzz targets (including BBS+ operations) and how to run them. |
| [fuzz-testing-guide.md](./fuzz-testing-guide.md) | Guide to writing and running fuzz tests. |
| [code-coverage.md](./code-coverage.md) | How coverage is measured and reported. |
| [coverage-configuration.md](./coverage-configuration.md) | Coverage tooling configuration reference. |

---

## Architecture Decision Records

ADRs live in [`adr/`](./adr/) and have their own navigable index:
**[adr/README.md](./adr/README.md)**. Start there rather than reading the
files directly — it lists every ADR with status and date, and explains how to
add a new one.

---

## Adding a new doc

When you add a Markdown file to `docs/`, add a link to it in the appropriate
section above (a one-line description in the table). This keeps the directory
discoverable and stops the same doc being written twice.

This is enforced by `scripts/check_docs_index.sh`, which runs in CI (the
`docs-index` job in [`.github/workflows/ci.yml`](../.github/workflows/ci.yml)).
The check fails if any `docs/*.md` file is not linked from this index. Run it
locally with:

```bash
./scripts/check_docs_index.sh
```

`docs/README.md` itself and files under `docs/adr/` (indexed by
`adr/README.md`) are exempt.
