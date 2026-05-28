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
