# ADR-008: Economic Security Model for Weighted Voting

## Status
Accepted

> **Renumbering note**: This ADR was originally filed as ADR-006 (`adr-006-economic-security-model.md`)
> on 2026-07-21, but that number was simultaneously assigned to
> [ADR-006: Quorum Intersection Verification](./adr-006-quorum-intersection-verification.md).
> It has been renumbered to **ADR-008** to resolve the conflict (see
> [docs/adr/README.md](./README.md) for the full index). The old filename is kept as a
> redirect stub for stable external links.

## Context

ADR-001 establishes that QuorumProof is designed to be "resistant to collusion and fraud" through federated Byzantine agreement (FBA). However, the current weighted voting implementation in `docs/weighted-voting.md` documents but does not enforce the critical risk: "if maximum_weight >= required_weight, one attestor can decide consensus alone."

There is currently no mechanism to:
1. Quantify the economic cost for an adversary to attack a slice
2. Detect concentration risks before they become vulnerabilities
3. Penalize or deter attestors from equivocating
4. Dynamically adjust voting power based on proven trustworthiness

This creates a gap between the stated design goal ("resistance to collusion and fraud") and the actual implementation.

## Problem Statement

How should QuorumProof measure and enforce resistance to collusion and fraud in weighted voting slices when:
1. Slice creators may unknowingly create single points of failure
2. Attestors have no economic consequence for equivocating
3. Adversaries can corrupt attestors at lower cost than defending against attacks
4. Sybil attackers can instantaneously achieve high voting weight
5. There is no way to query whether a slice is under economic attack

## Decision

**Adopt an economic security model with reputation-tied weighting as the primary mitigation.**

### 1. Formal Cost-of-Attack Model

Implement a formal model that quantifies the cost to attack a slice's consensus threshold via two strategies:

**Corrupt-Existing Attack**: An attacker corrupts a subset of existing attestors to reach consensus threshold.
- Cost = Σ(corruption_price_i × weight_i) for the minimum-cost subset
- Algorithm: Greedy weighted set cover (O(n log n))
- Mitigation impact: Reputation penalties increase required set size

**Sybil Attack**: An attacker launches new fake attestors to accumulate voting weight.
- Cost = N_sybils × (bootstrap_reputation_cost + identity_cost)
- Constraint: New attestors face per-address weight ceiling (e.g., 30 weight max)
- Mitigation impact: Sybils cannot immediately vote at full weight; must prove reputation

### 2. Queryable Attack Cost Estimation

Add a public `get_slice_attack_cost_estimate()` function that returns:
- Estimated cost for corrupt-existing strategy
- Estimated cost for Sybil strategy
- Concentration risk score (0-100)
- Single point of failure detection
- Recommended cheapest attack path

This enables:
- Slice creators to monitor their security posture
- Applications to warn users about risky slices
- Early detection of potential attacks

### 3. Reputation-Tied Weighting Mitigation

Implement reputation-tied weighting as an optional, per-slice feature (disabled by default for backwards compatibility).

**Mechanism**: When enabled, effective weight = base_weight × (reputation_score / 100)

**Benefits**:
- Creates continuous economic incentive against equivocation
- Reuses existing reputation infrastructure (no new tokens)
- Low gas cost (single multiplication per attestation)
- Soft enforcement (gradual weight reduction vs. hard suspension)

**Economic Impact**:
- Corrupted attestor: reputation drops 20 → effective weight loses 20%
- Reputation below 20: auto-suspension (0 effective weight)
- Sybil attackers must earn reputation through honest participation
- Proven equivocation (ForkDetected event) triggers slash + reputation penalty

### 4. Integration with Existing Infrastructure

Leverage existing reputation and slashing mechanisms:
- `AttestorReputation` storage key (already exists)
- `AttestorMaliciousCount` tracking (already exists)
- Slashing logic on ForkDetected events (already exists)
- Suspension threshold at 20 reputation (already exists)

No new economic tokens or bonding mechanisms required.

## Rationale

### Why This Model?

1. **Practical**: Reputation mechanism already implemented; no additional complexity
2. **Scalable**: Works for slices of 5-20 attestors; scales O(n log n)
3. **Detectable**: Single point of failure and concentration risk automatically identified
4. **Enforceable**: Reputation penalties are automatic; no manual governance needed
5. **Measurable**: Attack costs are quantifiable and can be monitored over time

### Why Reputation-Tied Weighting Over Bonded Stake?

Reputation-tied weighting is preferred as the primary mitigation because:

| Criterion | Reputation-Tied | Bonded Stake |
|-----------|-----------------|--------------|
| Existing Infrastructure | ✓ (reputation exists) | ✗ (needs new tokens) |
| Gas Cost | Low (1 multiply) | High (fund management) |
| Enforcement | Soft (gradual) | Hard (slash-or-nothing) |
| Backwards Compat | ✓ (opt-in per slice) | ✗ (requires funds) |
| User Experience | Simple | Complex (staking UI) |

Bonded stake can be added in a future ADR (ADR-009 or later) for slices requiring maximum security.

### Why Greedy Algorithm?

The greedy algorithm for weighted set cover approximation is used because:
- O(n log n) complexity is acceptable for 5-20 attestors per slice
- Approximation ratio is ln(n) ≈ 2-3x for typical slice sizes
- Provides conservative (overestimate) cost bounds for attacker
- Results are trivial to verify on-chain

Monte Carlo validation confirms the greedy results match hand-calculated costs within 10%.

## Consequences

### Positive
- Slices can now quantify their economic security posture
- Single points of failure are automatically detected
- Reputation mechanism gains enforcement power
- Attack costs increase 2-10x with mitigation enabled
- Backwards compatible (feature disabled by default)
- Aligns with ADR-001 goal: "resistance to collusion and fraud"

### Negative
- Adds new fields to QuorumSlice struct (requires one-time migration)
- Slice creators must actively enable reputation weighting (default is off)
- Attestor reputation now affects consensus (requires education)
- Greedy algorithm is approximation, not optimal (acceptable given O(n log n) performance)

### Neutral
- Cost estimation runs on-chain; adds ~0.1ms per query
- Reputation calculation adds ~5-10% gas cost when weighting enabled

## Implementation Notes

1. **Storage Layout**
   - New field: `QuorumSlice.reputation_weighting_enabled: bool` (false by default)
   - No changes to existing reputation storage (reuse DataKey5::AttestorReputation)

2. **Consensus Logic**
   - In `is_attested()`, check reputation_weighting_enabled flag
   - If enabled: effective_weight = base_weight × (reputation / 100)
   - If disabled: effective_weight = base_weight (legacy behavior)

3. **Query Functions**
   - `get_slice_attack_cost_estimate(slice_id)`: Returns SliceAttackCostEstimate
   - `get_slice_security_profiles(slice_id)`: Returns Vec<AttestorSecurityProfile>
   - `get_effective_weight(slice_id, attestor)`: Returns effective weight considering reputation

4. **Slice Management**
   - `set_reputation_weighting_enabled(creator, slice_id, enabled)`: Enable/disable per slice
   - Creator-only operation; takes effect immediately

5. **Monitoring**
   - Query `get_slice_attack_cost_estimate()` regularly to track security trends
   - Alert slice creators when concentration_risk_score > 80

## Testing Strategy

1. **Unit Tests**: Validate simulation logic and cost calculations
2. **Integration Tests**: Verify consensus behavior with/without weighting
3. **Property Tests**: Cost monotonicity (higher threshold → higher cost)
4. **Measurement Tests**: Before/after cost multipliers (2-10x target)
5. **Migration Tests**: Existing slices continue working with weighting disabled

## Open Questions

1. Should bonded stake be added as an alternative mitigation in a future ADR?
   - Decision: Yes, but not in this ADR. Create ADR-009 if needed.

2. What reputation score should trigger automatic suspension?
   - Decision: Existing default (20) is reasonable; configurable via admin functions if needed later.

3. Should slices created before this ADR automatically enable weighting?
   - Decision: No. Backwards compatibility requires opt-in by creator.

## References

- [ADR-001: Federated Byzantine Agreement (FBA) Trust Model](./adr-001-fba-trust-model.md)
- [ADR-006: Quorum Intersection Verification](./adr-006-quorum-intersection-verification.md)
- [docs/economic-security-model.md](../economic-security-model.md): Formal model, equations, and validation
- [docs/weighted-voting.md](../weighted-voting.md): Consensus algorithm and API
- Stellar Consensus Protocol: Federated consensus foundations
