# ADR-012: Weighted-Threshold Quorum Slices

## Status

Accepted

## Date

2026-09-26

## Context

[ADR-001](./adr-001-fba-trust-model.md) adopted the FBA model: each credential
holder defines a quorum slice of attestors, and a credential counts as attested
when that slice agrees. It did not say how agreement is measured.

In practice attestors are not equally authoritative. A national licensing body
confirming a PE licence carries more weight than a former employer confirming
the same person worked there.

## Problem Statement

How should a slice decide that "enough" attestors have agreed?

## Alternatives Considered

### Option 1: Unanimity

**Pros**: Simple and maximally strict.

**Cons**: One unresponsive or defunct institution blocks the credential forever.

### Option 2: Count threshold (k-of-n)

**Pros**: Simple, and tolerates unavailable attestors.

**Cons**: Every attestor is equal. Three employers could outvote the licensing
body that actually issues the licence.

### Option 3: Weighted threshold (chosen)

Each attestor has a `u32` weight. The slice has a `threshold` in weight units.
A credential is attested when the summed weight of positive attestations is at
least the threshold.

**Pros**: Expresses real-world authority. k-of-n is a special case (all weights 1).
Can require a specific attestor by giving it a weight that no combination of
the others reaches.

**Cons**: Weights are a new thing for slice creators to choose, and a badly
chosen weight is easy to miss.

## Decision

`QuorumSlice` stores parallel `attestors: Vec<Address>` and `weights: Vec<u32>`
vectors plus a `threshold: u32`. `create_slice` delegates to
`create_weighted_slice`, which validates:

- `attestors` is non-empty and within the admin-configurable
  `get_max_attestors_per_slice` limit;
- every attestor address is valid and there are no duplicate attestors;
- `weights.len() == attestors.len()` and every weight is in `1..=100`;
- for `ThresholdType::Absolute`: `0 < threshold <= sum(weights)`;
- for `ThresholdType::Percentage`: `threshold` is in `1..=100`, as a percentage
  of the total weight.

`is_attested` sums the weights of attestors whose attestation is positive,
unexpired and not suspended, and compares the sum to `threshold`. Results are
cached per `(credential, slice)` in `AttestVerifyCache` and invalidated on
state changes.

## Rationale

Weighted thresholds keep FBA's "individual trust decisions" while matching how
credentials actually get their authority. The attestor cap bounds the cost
of `is_attested` so verification stays well within Soroban's per-transaction
CPU budget.

## Consequences

### Positive

- Supports "licensing body plus any one employer" style policies.
- Verification cost is bounded and predictable.

### Negative

- Creators can build slices that can never be satisfied in practice (for
  example, the threshold depends on an attestor that no longer exists).
  The recovery and dispute flows exist partly for this reason.
- Existing slices can't have their weights changed, so a policy change means a new slice.
- Weights are limited to `1..=100`, so extreme authority differences must be
  expressed through the threshold, not the weights.

### Risks and Mitigations

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Weight-sum overflow | Low | High | Weights capped at 100, attestor count capped, saturating sum in `total_slice_weight` |
| Stale cached verification result | Med | High | Cache invalidated on attest / revoke / suspend |
| One high-weight attestor is a single point of trust | Med | Med | Disputes, challenges and slashing flows |

## Related Code

- `contracts/quorum_proof/src/lib.rs`: `QuorumSlice`, `create_slice`, `create_weighted_slice`, `validate_weight`, `attest`, `is_attested`
- `contracts/quorum_proof/src/proptest_slices.rs`: property tests for slice invariants

## References

- [ADR-001: FBA trust model](./adr-001-fba-trust-model.md)
- [ADR-006: Quorum intersection verification](./adr-006-quorum-intersection-verification.md)
- [ADR-009: Attestor independence](./adr-009-attestor-independence.md)
- Mazières, *The Stellar Consensus Protocol* (2015)
