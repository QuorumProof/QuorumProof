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

> Note: ADR-008 was originally filed as ADR-006 (`adr-006-economic-security-model.md`) before the
> duplicate numbering conflict was noticed. It has been renumbered to 008 to resolve the conflict.
> The old filename is kept as a redirect stub for stable external links (see
> [adr-006-economic-security-model.md](./adr-006-economic-security-model.md)).
> The next available ADR number is **010**.

## How to Add a New ADR

1. Copy the template: `cp 0000-adr-template.md NNNN-short-title.md`
2. Fill in every section — especially **Alternatives Considered** and **Consequences**.
3. Set the status to `Proposed` until the team agrees; change to `Accepted` after review.
4. Add a row to the index table above.
5. Submit as part of a pull request.

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
