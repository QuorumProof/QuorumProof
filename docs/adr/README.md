# Architecture Decision Records (ADRs)

This directory contains Architecture Decision Records for QuorumProof. Each ADR documents a significant design decision: the context that prompted it, the alternatives considered, and the rationale for the chosen approach.

## What is an ADR?

An ADR is a short document that captures *why* a decision was made, not just *what* was decided. Future maintainers can read ADRs to understand the reasoning behind the architecture without having to reverse-engineer it from the code.

## Index

| # | Title | Status | Date |
|---|-------|--------|------|
| [001](./adr-001-fba-trust-model.md) | Federated Byzantine Agreement (FBA) Trust Model | Accepted | 2024-01-15 |
| [002](./adr-002-sbt-non-transferability.md) | Soulbound Token (SBT) Non-Transferability | Accepted | 2024-01-20 |
| [003](./adr-003-zk-verification.md) | Zero-Knowledge Verification Approach | Accepted | 2024-02-01 |
| [004](./adr-004-soroban-platform.md) | Soroban Platform Choice | Accepted | 2026-06-26 |
| [005](./adr-005-registry-attestation-proof.md) | Registry Attestation Proof for Licensing Body Integrations | Accepted | 2026-07-20 |
| [006](./adr-006-quorum-intersection-verification.md) | Quorum Intersection Verification | Accepted | 2026-07-21 |
| [007](./adr-007-bbs-plus-selective-disclosure.md) | BBS+ Signatures for Selective Disclosure | Accepted | 2026-07-26 |
| [008](./adr-008-economic-security-model.md) | Economic Security Model | Accepted | 2026-07-21 |
| [009](./adr-009-attestor-independence.md) | Quorum Slice Attestor Independence | Accepted | 2026-09-03 |
| [010](./adr-010-three-contract-architecture.md) | Split the System into Three Soroban Contracts | Accepted | 2026-09-26 |
| [011](./adr-011-state-versioning-and-upgrades.md) | State Versioning and In-Place Contract Upgrades | Accepted | 2026-09-26 |
| [012](./adr-012-weighted-threshold-quorum-slices.md) | Weighted-Threshold Quorum Slices | Accepted | 2026-09-26 |
| [013](./adr-013-instance-storage-and-ttl.md) | Instance Storage and TTL Strategy | Accepted | 2026-09-26 |
| [014](./adr-014-admin-circuit-breaker-and-rate-limiting.md) | Admin Circuit Breaker (Pause) and Per-Address Rate Limiting | Accepted | 2026-09-26 |
| [015](./adr-015-read-only-api-server-via-simulation.md) | Keyless API Server — Chain Reads via Transaction Simulation | Accepted | 2026-09-26 |
<!-- adr-index-end -->

> Note: ADR-008 was originally filed as ADR-006 (`adr-006-economic-security-model.md`) before the
> duplicate numbering conflict was noticed. It has been renumbered to 008 to resolve the conflict.
> The old filename is kept as a redirect stub for stable external links (see
> [adr-006-economic-security-model.md](./adr-006-economic-security-model.md)).
> The next available ADR number is **016**.

## How to Add a New ADR

1. Run `scripts/adr/new-adr.sh "Short decision title"`. It copies the
   template to `adr-NNN-short-decision-title.md` with the next free number,
   fills in the title, adds a `Proposed` row to the index above and bumps the
   "next available number" note.
   (Manual alternative: `cp 0000-adr-template.md adr-NNN-short-title.md` and add the row yourself.)
2. Fill in every section, especially **Alternatives Considered** and **Consequences**.
3. Link the ADR from the code it governs with a comment such as
   `// Design rationale: docs/adr/adr-NNN-short-title.md`.
4. Keep the status at `Proposed` until the team agrees, then change it to `Accepted` after review.
5. Submit it as part of a pull request.

## ADRs by area

| Area | ADRs |
|---|---|
| Platform and contract architecture | [004](./adr-004-soroban-platform.md), [010](./adr-010-three-contract-architecture.md) |
| Trust model and slices | [001](./adr-001-fba-trust-model.md), [006](./adr-006-quorum-intersection-verification.md), [009](./adr-009-attestor-independence.md), [012](./adr-012-weighted-threshold-quorum-slices.md) |
| Tokens and disclosure | [002](./adr-002-sbt-non-transferability.md), [003](./adr-003-zk-verification.md), [007](./adr-007-bbs-plus-selective-disclosure.md) |
| Storage, state and upgrades | [008 (delegation storage)](./adr-008-delegation-persistent-storage-migration.md), [011](./adr-011-state-versioning-and-upgrades.md), [013](./adr-013-instance-storage-and-ttl.md) |
| Security and operations | [005](./adr-005-registry-attestation-proof.md), [008 (economic security)](./adr-008-economic-security-model.md), [014](./adr-014-admin-circuit-breaker-and-rate-limiting.md) |
| Off-chain services | [015](./adr-015-read-only-api-server-via-simulation.md) |

## ADRs referenced from code

Code that implements an ADR carries a back-link comment:

```rust
/// Design rationale: docs/adr/adr-011-state-versioning-and-upgrades.md
pub fn migrate_state(...)
```

Find all of them with `grep -rn "docs/adr/" contracts api-server`.

## ADR Lifecycle

```
Proposed → Accepted → (Deprecated | Superseded by ADR-NNNN)
```

A deprecated or superseded ADR is kept for historical context; do not delete it.

## Template

See [0000-adr-template.md](./0000-adr-template.md).

## References

- [Documenting Architecture Decisions — Michael Nygard](https://cognitect.com/blog/2011/11/15/documenting-architecture-decisions)
- [ADR GitHub Organisation](https://adr.github.io/)
