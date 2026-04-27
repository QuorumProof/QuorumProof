# Architecture Decision Records (ADRs)

This directory contains Architecture Decision Records (ADRs) for QuorumProof. ADRs document major design decisions, the context in which they were made, the alternatives considered, and the rationale for the chosen approach.

## What is an ADR?

An ADR is a lightweight document that captures a significant architectural decision made during the development of a system. Each ADR should:

1. **Describe the problem** — What issue or requirement prompted the decision?
2. **List alternatives** — What other approaches were considered?
3. **Explain the decision** — Which approach was chosen and why?
4. **Document tradeoffs** — What are the pros and cons of this decision?
5. **Note consequences** — What are the long-term implications?

## ADR Format

Each ADR follows this template:

```markdown
# ADR-NNN: [Title]

## Status
[Proposed | Accepted | Deprecated | Superseded by ADR-XXX]

## Context
[Describe the issue or requirement that prompted this decision]

## Problem Statement
[What specific problem are we trying to solve?]

## Alternatives Considered
1. [Alternative 1]
   - Pros: ...
   - Cons: ...

2. [Alternative 2]
   - Pros: ...
   - Cons: ...

## Decision
[Which alternative was chosen and why?]

## Rationale
[Explain the reasoning behind this decision]

## Consequences
### Positive
- [Benefit 1]
- [Benefit 2]

### Negative
- [Drawback 1]
- [Drawback 2]

## Implementation Notes
[Any specific implementation details or gotchas]

## References
- [Related documentation or external links]
```

## Index of ADRs

- [ADR-001: Federated Byzantine Agreement (FBA) Trust Model](./adr-001-fba-trust-model.md)
- [ADR-002: Soulbound Token (SBT) Non-Transferability](./adr-002-sbt-non-transferability.md)
- [ADR-003: Zero-Knowledge Verification Approach](./adr-003-zk-verification.md)

## How to Add a New ADR

1. Create a new file: `adr-NNN-title.md` (use the next sequential number)
2. Use the ADR template above
3. Fill in all sections with clear, concise language
4. Add a link to this index
5. Submit as part of a pull request with a clear description

## Decision Log

| ADR | Title | Status | Date |
|-----|-------|--------|------|
| 001 | Federated Byzantine Agreement (FBA) Trust Model | Accepted | 2024-01-15 |
| 002 | Soulbound Token (SBT) Non-Transferability | Accepted | 2024-01-20 |
| 003 | Zero-Knowledge Verification Approach | Accepted | 2024-02-01 |

## References

- [Documenting Architecture Decisions - Michael Nygard](https://cognitect.com/blog/2011/11/15/documenting-architecture-decisions)
- [ADR GitHub Organization](https://adr.github.io/)
