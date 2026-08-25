# Verification Cache Invalidation Guarantees

## Overview

QuorumProof uses on-chain caching for two verification results to reduce gas costs on repeated queries:

1. **AttestationVerificationCache** — Stores whether a credential meets the threshold for a slice (`is_attested`)
2. **ThresholdVerificationCache** — Stores whether an aggregated BLS signature meets the quorum threshold (`verify_threshold_attestation`)

Both caches are **invalidated (removed) immediately** whenever changes occur that could affect their correctness. This document specifies the invalidation guarantees.

## Cache Invalidation Triggers

### AttestationVerificationCache Invalidation

The `AttestationVerificationCache` entry for `(credential_id, slice_id)` is **removed** (invalidated) when:

1. **Credential Revocation** (`revoke_credential`, `revoke_consent`, `approve_revocation`)
   - The credential no longer exists as a valid candidate for attestation
   - All cache entries for that credential are removed

2. **Credential Amendment** (`amend_credential_metadata`)
   - The credential's metadata may affect compliance checks or verification state
   - All cache entries for the amended credential are removed

3. **Attestation Removal** (dispute resolution, challenge upheld)
   - When a challenge is upheld, the accused attestor's signature is removed from the credential
   - The threshold recalculation may now fail, invalidating any cached result claiming success
   - All cache entries for that credential are removed

4. **Slice Changes** (attestor removal, weight update, threshold change)
   - Adding/removing attestors, changing weights, or changing thresholds changes which signatures are required
   - All cache entries for all credentials attested in that slice are removed

### ThresholdVerificationCache Invalidation

The `ThresholdVerificationCache` entry for `(credential_id, slice_id)` is **removed** (invalidated) when:

1. **Credential Revocation** (`revoke_credential`, `revoke_consent`, `approve_revocation`)
   - A revoked credential cannot have valid threshold verification
   - All cache entries for that credential are removed

2. **Credential Amendment** (`amend_credential_metadata`)
   - Amendment may affect signature requirements or validation state
   - All cache entries for the amended credential are removed

3. **Attestation Removal** (dispute resolution, challenge upheld)
   - When a challenge is upheld, the accused attestor's signature is removed
   - The cached signatories list no longer reflects reality
   - All cache entries for that credential are removed

4. **Slice Delegation Revocation** (`revoke_slice_delegation`)
   - A delegation revocation may change the effective signatories for threshold calculation
   - All cache entries for all credentials in that slice are removed

## Cache Consistency Model

### Invariant: Cache-Results Coherence

For any credential/slice pair, if `get_threshold_verification(credential_id, slice_id)` returns `Some(result)`, then:

- `result.is_valid` accurately reflects whether the credential meets the quorum threshold **as of the time the result was cached**
- `result.signatories` accurately reflects the attestor bitmap that contributed to threshold verification
- The result is **stale** if any subsequent operation (listed above) has modified the credential, attestations, or slice

### Transaction Atomicity

Cache invalidation occurs **in the same transaction** that triggers it. Subsequent queries in later transactions will:

- Return `None` if the cache entry was removed (no stale data)
- Recompute and re-cache the result if needed

## Implementation Details

### Full Removal vs. Staleness Marker

Both caches use **full removal** (not explicit staleness markers). When an invalidation trigger occurs:

1. The cache entry is **removed** from contract storage via `env.storage().instance().remove(...)`
2. Subsequent calls to `get_threshold_verification(credential_id, slice_id)` return `None`
3. Callers must recompute by calling `verify_threshold_attestation(...)` if they need a fresh result

This approach is simpler and aligns with the existing `AttestationVerificationCache` convention.

### Cache Keys

Both caches are indexed by `(credential_id, slice_id)` pairs:

```
AttestationVerificationCache(credential_id, slice_id) -> is_attested: bool
ThresholdVerificationCache(credential_id, slice_id) -> ThresholdVerificationResult
```

Invalidation strategies:

- **Per-credential invalidation**: `invalidate_*_caches_for_credential(credential_id)` removes all cache entries for all slices
- **Per-slice invalidation**: `invalidate_*_caches_for_slice(slice_id)` removes all cache entries for all credentials

## Caller Patterns

### Safe Pattern: Query → Verify → Use

If your contract or off-chain client needs a verification result:

```rust
// Attempt to retrieve cached result
if let Some(result) = client.get_threshold_verification(&credential_id, &slice_id) {
    // Use the cached result
    if result.is_valid {
        grant_credential_benefit(&credential_id);
    }
} else {
    // Cache miss or invalidated; recompute
    let agg_sig = AggregatedSignature { /* ... */ };
    let is_valid = client.verify_threshold_attestation(&credential_id, &slice_id, &agg_sig);
    if is_valid {
        grant_credential_benefit(&credential_id);
    }
}
```

### Unsafe Pattern: Cache-Only (Do Not Use)

Do not assume a cached result persists across multiple transactions:

```rust
// ❌ WRONG: Cache may be invalidated between transactions
let result = client.get_threshold_verification(&credential_id, &slice_id);
// ... time passes ...
// ... credential or slice modified ...
// result is now stale but still appears valid
```

## Revocation vs. Amendment Behavior

### Credential Revocation

When a credential is revoked, all its cache entries are removed. This is correct because:
- A revoked credential cannot be re-attested or re-verified through normal flows
- Any cached result claiming success is now misleading

### Credential Amendment

When credential metadata is amended (e.g., specialization or degree), all cache entries are removed. This is conservative because:
- Metadata changes might affect compliance checks or policy-driven verification
- Invalidation ensures no stale metadata is reflected in cached results

## Performance Implications

Cache invalidation has performance costs:

1. **Revocation**: Iterates over all slices (`O(n)` slices) and removes each cache entry
2. **Slice changes**: Iterates over all credentials (`O(m)` credentials) and removes each cache entry

For large numbers of slices/credentials, this cost is amortized across many cache hits during normal operation. If invalidation frequency is high relative to cache hits, consider:

- Batching invalidations with multi-credential revocation flows
- Monitoring cache hit rates via metrics to detect inefficient cache-to-invalidation ratios

## See Also

- `docs/weighted-voting.md` — Consensus algorithm and slice management
- `docs/architecture.md` — Contract structure and cross-contract calls
- `docs/formal-verification.md` — Invariant proofs including cache consistency
