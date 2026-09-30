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

Stuck on a term or a common question? See the [glossary](./glossary.md) and
the [FAQ](./faq.md). Upgrading? Start with the [migration guides](./migration-guides.md).

Prefer learning by watching or doing? See the [video tutorials](./video-tutorials.md)
and the [interactive documentation](./interactive-documentation.md) (search, API
playground, quorum slice simulator).

Then see [`../README.md`](../README.md) for the contribution workflow and
[`../SECURITY.md`](../SECURITY.md) for the vulnerability-reporting policy.

---

## Tutorials & interactive docs

| Doc | What it covers |
|---|---|
| [video-tutorials.md](./video-tutorials.md) | Index of video tutorials for common tasks, with scripts, captions, and the recording guide (issue #1634). |
| [interactive-documentation.md](./interactive-documentation.md) | Interactive docs: full-text search, API playground, slice/hash playgrounds, and the feedback loop (issue #1635). |
| [bbs-plus-tutorial.md](./bbs-plus-tutorial.md) | BBS+ selective-disclosure tutorial. |
| [code-examples.md](./code-examples.md) | REST examples in Python, JavaScript, Rust and Go, with example templates, testing and maintenance rules (issue #1638). |
| [faq.md](./faq.md) | Frequently asked questions with short answers linking to the full docs (issue #1639). |
| [glossary.md](./glossary.md) | Alphabetical glossary of project-specific and domain terms (issue #1640). |

---

## Architecture & core concepts

| Doc | What it covers |
|---|---|
| [architecture.md](./architecture.md) | High-level system architecture and component responsibilities. |
| [architecture-diagrams.md](./architecture-diagrams.md) | Mermaid diagrams: system architecture, contract interactions, data flow, and deployment topology (issue #1644). |
| [economic-security-model.md](./economic-security-model.md) | Economic assumptions, incentives, and attack cost analysis (see also [ADR-006](./adr/adr-006-economic-security-model.md)). |
| [weighted-voting.md](./weighted-voting.md) | Weighted quorum voting: per-attestor trust weights (1–100) and threshold semantics. |
| [claim-types.md](./claim-types.md) | Claim type registry — the claims a credential holder can prove. |
| [credential-types.md](./credential-types.md) | Credential type registry — the credential kinds the system issues. |
| [crypto-shredding-architecture.md](./crypto-shredding-architecture.md) | Crypto-shredding design for GDPR-style erasure of off-chain personal data. |
| [METADATA_SCHEMA_VERSIONING_PLAN.md](./METADATA_SCHEMA_VERSIONING_PLAN.md) | Plan for versioning the credential metadata schema and migrating between versions. |
| [IMPLEMENTATION_NOTES_910_913_915.md](./IMPLEMENTATION_NOTES_910_913_915.md) | Implementation notes for attestation veto and related features (issues #910/#913/#915). |
| [infrastructure-improvements.md](./infrastructure-improvements.md) | Security, versioning, and state-validation infrastructure work (issues #574–577). |

---

## Developer Tooling & Environment

| Doc | What it covers |
|---|---|
| [local-dev-setup.md](./local-dev-setup.md) | Setting up a local development environment: prerequisites, setup script, Docker Compose, standalone network, and troubleshooting (issue #1663). |
| [ide-setup.md](./ide-setup.md) | VS Code extension recommendations, workspace settings, debug configurations, and tasks for contract and API development (issue #1664). |
| [code-snippets.md](./code-snippets.md) | Code snippets library for common Soroban smart contract and client SDK patterns (issue #1670). |
| [environment-parity.md](./environment-parity.md) | Detecting and remediating env/config drift between environments using check_env_parity.sh and compare_environments.sh (issue #1662). |

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
| [multi-region-failover.md](./multi-region-failover.md) | AWS active/passive multi-region failover: detection, data replication, procedures and drills (#1650). |
| [infrastructure-as-code.md](./infrastructure-as-code.md) | Terraform layout, state, CI plan/apply, drift detection and infrastructure testing (#1652). |
| [blue-green-deployment.md](./blue-green-deployment.md) | Zero-downtime api-server releases: blue/green slots, health-check validation, traffic switching, rollback. |
| [capacity-planning.md](./capacity-planning.md) | Sizing guidance for throughput, storage, and RPC load. |
| [canary-deployments.md](./canary-deployments.md) | Canary deployment strategy, traffic routing, health checks, and rollback triggers (issue #1654). |
| [cost-optimization-analysis.md](./cost-optimization-analysis.md) | Cloud and blockchain operational cost breakdown and optimization analysis (issue #1657). |
| [cost-optimization-guide.md](./cost-optimization-guide.md) | Reducing on-chain fees and infrastructure cost. |
| [database-migrations.md](./database-migrations.md) | Running and authoring API-server database migrations. |
| [backup-system.md](./backup-system.md) | Backup architecture, schedule, and restore procedure. |
| [log-retention-policy.md](./log-retention-policy.md) | Log retention periods, cold-storage archival, retrieval and compliance mapping (#1653). |
| [backup-verification.md](./backup-verification.md) | Automated backup verification, integrity checks, and restoring from a verified backup. |
| [disaster-recovery.md](./disaster-recovery.md) | Emergency pause/redeploy and credential-restoration procedures. |
| [DR_PLAN_IMPLEMENTATION.md](./DR_PLAN_IMPLEMENTATION.md) | Implementation notes for the disaster-recovery plan. |
| [dr-runbook.md](./dr-runbook.md) | DR runbook: quick-reference decision tree and step-by-step recovery procedures for all scenarios (issue #1659). |
| [resilience.md](./resilience.md) | Resilience requirements and chaos-testing approach (issue #1003). |
| [operational-runbook.md](./operational-runbook.md) | Day-to-day operational procedures. |
| [OPERATOR_RUNBOOK.md](./OPERATOR_RUNBOOK.md) | Operator-facing runbook for common incidents and tasks. |
| [troubleshooting-guide.md](./troubleshooting-guide.md) | Common issues, diagnostic procedures (D1–D6), and triage decision trees across contracts, API, and infra (issue #1643). |
| [autoscaling-guide.md](./autoscaling-guide.md) | HPA policy, metrics pipeline, threshold tuning, and load testing for automated scaling (issue #1658). |

---

## Runbooks

Step-by-step, copy-pasteable procedures for standard operations (issue #1645).

| Doc | What it covers |
|---|---|
| [runbook-deployment.md](./runbook-deployment.md) | Production release: migrations, contract upgrades, blue/green API rollout, post-deploy verification. |
| [runbook-incident-response.md](./runbook-incident-response.md) | Severity levels, roles, detect → stabilize → diagnose → resolve → postmortem, emergency pause, comms templates. |
| [runbook-rollback.md](./runbook-rollback.md) | Rolling back the API server, contract upgrades, database migrations, and testnet deploys. |
| [runbook-maintenance.md](./runbook-maintenance.md) | Maintenance windows, change freeze, and the recurring maintenance task schedule. |

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
| [performance-tuning-guide.md](./performance-tuning-guide.md) | Bottlenecks, tuning parameters, benchmark methodology, and performance monitoring. |
| [service-mesh-operations.md](./service-mesh-operations.md) | Istio service mesh: installation, mTLS enforcement, traffic visualisation, distributed tracing (issue #1660). |
| [cost-alert-thresholds.md](./cost-alert-thresholds.md) | Cost monitoring, alert thresholds (warning/critical), alert routing, and threshold tuning (issue #1661). |

---

## Security & Compliance

| Doc | What it covers |
|---|---|
| [threat-model.md](./threat-model.md) | Assets, threat actors, attack vectors, and mitigations already considered. |
| [THREAT_MODEL_CREDENTIAL_FRAUD.md](./THREAT_MODEL_CREDENTIAL_FRAUD.md) | Focused threat model for credential-fraud detection (issue #1252). |
| [security-best-practices.md](./security-best-practices.md) | Security guidance for contributors and integrators. |
| [security-best-practices.md](./security-best-practices.md#security-requirements-checklist-threat-modeling-and-tooling) | Security requirements (SR-* IDs), PR/release checklists, threat-modeling guide, and security tooling (issue #1637). |
| [security-audit-checklist.md](./security-audit-checklist.md) | Internal review checklist used before releases. |
| [issuer-security-checklist.md](./issuer-security-checklist.md) | Security checklist for institutions issuing credentials. |
| [network-policy.md](./network-policy.md) | Kubernetes network policies for service isolation and zero-trust ingress/egress (issue #1655). |
| [secrets-management.md](./secrets-management.md) | Secrets management architecture, Vault/AWS Secrets Manager integration, and rotation policies (issue #1656). |
| [attestor-key-custody-guide.md](./attestor-key-custody-guide.md) | Key custody practices and HSM recommendations for attestor institutions. |
| [container-image-scanning.md](./container-image-scanning.md) | Container image vulnerability scanning with Trivy: CI pipeline and suppression policy. |
| [gdpr-compliance.md](./gdpr-compliance.md) | GDPR obligations and how the system meets them. |
| [audit-log-format.md](./audit-log-format.md) | Structure and semantics of the audit log. |
| [formal-verification.md](./formal-verification.md) | Formal verification of critical functions (issue #1317). |
| [continuous-security-testing.md](./continuous-security-testing.md) | CI security pipeline: SAST, dependency and container scanning, aggregated report (issue #1631). |

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
| [upgrade-testing.md](./upgrade-testing.md) | Upgrade simulation tests and the static state-compatibility check (issue #1630). |
| [migration-invariants.md](./migration-invariants.md) | Formal invariant set the migration verifier checks (enforced in CI). |
| [SLICE_MIGRATION_GUIDE.md](./SLICE_MIGRATION_GUIDE.md) | Migrating existing quorum slices (issue #1253). |
| [migration-guides.md](./migration-guides.md) | Breaking changes per version and step-by-step migration and rollback guides for the API, contract state/schema, WASM and database (issue #1641). |
| [migration-testing-guide.md](./migration-testing-guide.md) | Testing a migration and its rollback before production: static checks, tests, testnet rehearsal, go/no-go (issue #1641). |
| [user-credentials-migration.md](./user-credentials-migration.md) | Migrating user credential records between schema versions. |
| [sbt-lifecycle.md](./sbt-lifecycle.md) | Full lifecycle of a Soulbound Token: issuance, attestation, revocation, and expiry. |
| [saga-rollback-specification.md](./saga-rollback-specification.md) | Saga pattern specification for multi-step contract operations and compensating rollbacks. |
| [batch-issuance-limits.md](./batch-issuance-limits.md) | Limits and recommendations for batch credential issuance operations. |
| [circuit-breaker-write-coverage.md](./circuit-breaker-write-coverage.md) | Admin circuit-breaker write coverage tracking and enforcement. |
| [quorum-slice-guide.md](./quorum-slice-guide.md) | End-to-end guide: creating, managing, and querying quorum slices. |
| [unwrap-audit.md](./unwrap-audit.md) | Audit log of unwrap/expect usage in contract source and remediation status (issue #1391). |

---

## API & Integrations

| Doc | What it covers |
|---|---|
| [api-client-guide.md](./api-client-guide.md) | Using the API client to talk to the API server. |
| [api-endpoint-examples.md](./api-endpoint-examples.md) | Worked request/response examples for the REST endpoints. |
| [api-response-examples.md](./api-response-examples.md) | Success and error response examples for every endpoint group, response schemas, and v1/v2 example versioning (issue #1636). |
| [integration-patterns-guide.md](./integration-patterns-guide.md) | Common integration patterns for verifiers and issuers. |
| [interoperability-guide.md](./interoperability-guide.md) | Interoperating with external credential systems. |
| [government-licensing-integration.md](./government-licensing-integration.md) | Protocol for licensing bodies to integrate as verified issuers. |
| [websocket-scaling.md](./websocket-scaling.md) | Scaling WebSocket delivery across multiple API-server replicas. |
| [plugin-development-guide.md](./plugin-development-guide.md) | Writing, testing, and distributing API-server plugins. |
| [throttling.md](./throttling.md) | Request throttling and backpressure configuration for the API server. |
| [api-quality-guards.md](./api-quality-guards.md) | API quality gates: contract tests, lint rules, and CI enforcement. |

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
| [longevity-testing.md](./longevity-testing.md) | Long-running API server soak tests: memory monitoring, leak and exhaustion detection (issue #1632). |

---

## Documentation versions

| Doc | What it covers |
|---|---|
| [documentation-versioning.md](./documentation-versioning.md) | How docs are versioned (git refs listed in [`versions.json`](./versions.json)), switching versions, backport rules, and the deprecation policy (issue #1642). |

You are reading the **latest** docs (`main`). To read the docs for an older
release, pick it in the interactive docs version switcher or open the
`docs/vMAJOR.MINOR` branch.

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
