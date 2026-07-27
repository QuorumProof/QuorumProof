# ADR-NNNN: <Short Title of Decision>

## Status
Proposed | Accepted | Deprecated | Superseded by ADR-NNNN

## Context
What is the issue that we're seeing that is motivating this decision or change? Describe the forces at play (technical, business, regulatory) in a value-neutral way.

## Problem Statement
A concise statement of the question this ADR answers. Enumerate the constraints the solution must satisfy.

## Alternatives Considered

### 1. <Alternative Name>
- **Description**:
- **Pros**:
- **Cons**:

### 2. <Alternative Name>
- **Description**:
- **Pros**:
- **Cons**:

### N. <Chosen Alternative> ✓ **CHOSEN**
- **Description**:
- **Pros**:
- **Cons**:

## Decision
State the decision in full sentences: "We will …".

## Rationale
Explain why the chosen alternative wins against the others, tied back to the problem statement's constraints.

## Consequences

### Positive
- ...

### Negative
- ...

## Implementation Notes
Concrete details: data structures, module boundaries, contract entry points, migration steps.

## References
- Links to related ADRs, whitepapers, or code (`../path/to/file.rs`).

---
**How to use this template**

1. Copy this file to `NNNN-short-title.md`, where `NNNN` is the next unused, zero-padded sequence number in this directory (check [README.md](./README.md) for the current index — do not reuse a number even if an old ADR was deprecated).
2. Fill in every section. Do not delete a section just because it feels redundant for a small decision — write "N/A" instead so future readers know it was considered.
3. Set `Status` to `Proposed` and open a pull request for review.
4. Once the team agrees, change `Status` to `Accepted` and merge.
5. Add a row to the index table in [README.md](./README.md).
6. If code implements this decision, add a short comment near the implementation pointing back to the ADR (e.g. `// See docs/adr/0007-bbs-plus-selective-disclosure.md for rationale`).
