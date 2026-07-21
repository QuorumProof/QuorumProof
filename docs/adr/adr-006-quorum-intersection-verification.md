# ADR-006: Quorum Intersection Verification for Nested Federated Byzantine Agreement

## Status
Accepted

## Context

ADR-001 established that QuorumProof uses Federated Byzantine Agreement (FBA) as its trust model, committing to individual quorum slices where each engineer defines their own network of trusted attestors. However, the initial implementation (documented in weighted-voting.md) supports only flat, single-level weighted-threshold voting with no notion of nested quorum slices or quorum-intersection safety checks.

Real FBA systems—most notably Stellar Consensus Protocol (SCP)—rely on nested quorum slices and intersection verification to prevent Byzantine partition: a dangerous scenario where two mutually-untrusting sub-networks each independently attest conflicting claims, each meeting its own flat-slice threshold, with no shared trust anchor.

## Problem Statement

1. **Flat slices allow partition**: Two engineers with disjoint quorum slices can each independently attest conflicting claims on the same credential. If Engineer A trusts [Univ1, Employer1] and Engineer B trusts [Univ2, Employer2], each slice is independent and both can simultaneously claim consensus on mutually-exclusive facts.

2. **No quorum intersection enforcement**: The current system has no mechanism to detect or prevent scenarios where multiple slices lack a common quorum—a violation of SCP's safety guarantee that at least one quorum will continue to operate and agree on state.

3. **Equivocation not cascaded**: When an attestor is caught equivocating (giving conflicting votes), they are suspended only within that one slice, not transitively excluded from parent slices in a nested trust hierarchy.

4. **Soroban execution budget**: Computing quorum intersection naively (enumerating all subsets to verify safety) is O(2^n), which quickly exhausts Soroban's ~20M-instruction CPU budget for practical network sizes.

## Alternatives Considered

### 1. Full Stellar SCP (Ballots, Nomination, State Machines)
- **Description**: Implement the complete Stellar Consensus Protocol with ballot nomination, cascade, and full Byzantine fault tolerance state machines.
- **Pros**:
  - Theoretically proven safe and live guarantees
  - Handles all Byzantine scenarios
  - Aligns exactly with Stellar's model
- **Cons**:
  - Extremely complex: ~3000 lines of protocol state machine logic
  - Exceeds Soroban contract size limits and CPU budget for real-world use
  - Overkill for credential verification (simpler safety model suffices)
  - Client SDK burden: requires clients to implement full SCP
- **Verdict**: Rejected — scope creep and budget infeasibility

### 2. Centralized Coordinator with Approval Authority
- **Description**: Add a trusted coordinator node that must approve all consensus decisions, validating quorum intersection centrally.
- **Pros**:
  - Simple to implement
  - Can use any consensus algorithm (e.g., Raft)
  - Efficient execution
- **Cons**:
  - Single point of failure and trust
  - Directly contradicts FBA's decentralized philosophy
  - Reintroduces the centralized registry problem ADR-001 rejected
- **Verdict**: Rejected — incompatible with FBA design principles

### 3. ✓ **CHOSEN: Nested Slices + Off-Chain Certificate Pattern**
- **Description**: Introduce nested quorum slice references (QuorumSliceNode) and an off-chain certificate pattern: clients pre-compute quorum intersection proofs; the contract verifies them efficiently via is_quorum checks.
- **Pros**:
  - Lightweight: contract only verifies, doesn't compute from scratch
  - O(k × d × n) verification (k slices, d depth, n nodes per slice) = ~30k ops for 50 slices, depth 3 — well within budget
  - Additive: depth-1 (flat) slices remain unchanged and fast
  - Maintains decentralization: client owns intersection proof, not a trusted coordinator
  - Bridges to SCP: enables future adoption of full SCP if needed
- **Cons**:
  - Requires client-side certificate generation (SDK responsibility, not contract)
  - Partition detection is post-hoc (detected when intersection check fails) rather than prevented
  - Adds ~5-10% overhead per nested quorum query
- **Verdict**: Adopted — balances safety, efficiency, and FBA principles

## Decision

Implement nested Federated Byzantine Agreement quorum slices with quorum intersection verification via the off-chain certificate pattern:

1. **QuorumSliceNode type**: Replace flat QuorumSlice with a recursive node structure supporting either direct attestors (flat, depth=1) or child slice references (nested, depth>1), with cycle detection at write time.

2. **is_quorum(env, slice_id, candidates) → bool**: Recursive SCP-based quorum function:
   - Flat case: candidates' total weight ≥ threshold (existing logic)
   - Nested case: candidates must form quorum in ALL child slices (strict intersection)
   - Termination: depth ≤ MAX_SLICE_DEPTH (4), cycle detection at write prevents infinite recursion

3. **check_quorum_intersection(env, slice_ids, certificate) → IntersectionReport**: Off-chain certificate verifier:
   - Client computes candidate node set offline
   - Contract verifies in O(k × d × n) time by calling is_quorum for each slice
   - Panics if certificate is invalid or intersection fails (no safe set exists)
   - Caches result 1 hour to amortize cost

4. **Equivocation handling**: Transitive suspension
   - When fork detected in slice, suspend equivocator in all parent slices via `suspend_attestor_recursive`
   - Prevents equivocation in child from corrupting parent-level consensus

5. **Backwards compatibility**: Depth-1 (flat) slices remain unchanged; all existing tests pass unmodified

## Consequences

### Positive
- **Partition detection**: Contract can now detect unsafe network partitions and reject consensus if quorum intersection is absent.
- **Byzantine safety**: Equivocating attestors are excluded transitively, preventing their votes from contributing at multiple levels.
- **Budget compliance**: Off-chain certificate pattern keeps verification cost within Soroban limits even for 100+ node networks.
- **Decentralization**: No trusted coordinator; clients compute and provide proofs.
- **Future-proof**: Incremental step toward full SCP if needed; nested architecture is compatible.
- **Backwards compatible**: Flat slices work unchanged; nested slices are opt-in.

### Negative
- **Client complexity**: SDK must implement certificate generation (hash, signature if needed, serialization).
- **Partition detection is reactive**: Unsafe partition is detected when verification fails, not prevented proactively. (Acceptable: credential consensus requires quorum intersection, so partition automatically means no consensus until it's resolved.)
- **~5-10% performance overhead**: Recursive is_quorum checks cost more than flat sum, especially for deep trees.
- **Documentation burden**: Non-obvious contract API; requires clear SDK and developer docs.

## Implementation

### New Types (lib.rs)
- **QuorumSliceNode**: Contracttype with fields: id, creator, attestors[], weights[], threshold, is_nested, child_slice_ids[], depth
- **IntersectionReport**: is_safe (bool), common_nodes (Vec<Address>), partition_count (u32), proof_hash (Bytes), certificate_version (u32)
- **QuorumIntersectionCertificate**: slice_ids, safe_nodes, proof_hash, signature (optional)

### New Storage Keys (DataKey10)
- NestedSliceNode(u64) → QuorumSliceNode
- ChildSliceIds(u64) → Vec<u64>
- SliceDepth(u64) → u32
- QuorumIntersectionCache(Bytes) → IntersectionReport (TTL: 1 hour)
- ParentSliceIds(u64) → Vec<u64> (reverse index for transitive operations)

### New Error Codes (starting at 82)
- MaxDepthExceeded (82)
- CycleDetected (83)
- QuorumIntersectionFailed (84)

### New Functions (lib.rs)
- **is_quorum_impl(env, slice_id, candidates) → bool**: Core recursive function (private)
- **is_quorum(env, slice_id, candidates) → bool**: Public interface
- **check_quorum_intersection(env, slice_ids, certificate) → IntersectionReport**: Certificate verifier
- **detect_cycle_dfs(...)**: Cycle detection helper (called at write time)
- **suspend_attestor_recursive(env, slice_id, attestor)**: Transitive suspension
- **find_parent_slices(env, child_id) → Vec<u64>**: Reverse index lookup
- **required_weight_nested(env, slice_id) → u32**: Handle both absolute and percentage thresholds for nested nodes

### Constants
- MAX_SLICE_DEPTH: 4 (balanced tree supports ~100 slices)
- QUORUM_INTERSECTION_CACHE_TTL: 3600 seconds (1 hour)
- MAX_SLICES_PER_INTERSECTION_CHECK: 100

### Integration with Existing Code
- **attest()**: Wire fork detection to call `suspend_attestor_recursive` for all conflicting attestors, ensuring transitive suspension
- **is_attested()**: Unchanged; uses is_attestor_suspended which already exists
- **Backwards compatibility**: Fallback to flat QuorumSlice for slices without NestedSliceNode entry

### Testing Strategy
1. **Proptest**: is_quorum vs brute-force oracle for depth 1-3 trees; cycle detection; depth overflow
2. **Integration tests**: Nested quorum formation, fork propagation, intersection safety, flat-slice regression
3. **Benchmarks**: is_quorum + intersection_check at 10/25/50/100 node graph sizes; confirm < 15M CPU, < 15M memory
4. **Backwards compatibility**: All existing flat-slice tests pass unmodified

## Non-Goals

- **Full Stellar SCP implementation**: Ballots, nomination, cascade protocol. Use simplified FBA quorum math.
- **Client SDK certificate generation**: That is SDK responsibility. Contract only verifies.
- **Per-issuer credential revocation**: Already handled by existing revocation API.
- **Real-time consensus safety proofs**: Not within contract scope; partition detection is reactive.
- **Optimized merkle/zk proofs for large networks**: Start with simple hash-based certificates; optimize if 100+ node use cases emerge.

## References
- ADR-001: Federated Byzantine Agreement Trust Model
- ADR-005: Registry Attestation Proof
- [Stellar Consensus Protocol Whitepaper](https://www.stellar.org/papers/stellar-consensus-protocol.pdf)
- [Stellar SCP GitHub Documentation](https://github.com/stellar/stellar-core/blob/master/src/scp/SCP.md)
- Soroban Contract Runtime: CPU and memory budgets (~20M CPU, ~15M memory per contract call)

## Implementation Files
- **Modified**: `contracts/quorum_proof/src/lib.rs` (~400 lines additions)
- **Modified**: `contracts/quorum_proof/src/proptest_slices.rs` (~50 lines additions)
- **New**: `contracts/quorum_proof/src/integration_nested_slices.rs` (~200 lines)
- **New**: `benches/tests/intersection_benchmarks.rs` (~150 lines)
- **New**: This ADR (docs/adr/adr-006-quorum-intersection-verification.md)
