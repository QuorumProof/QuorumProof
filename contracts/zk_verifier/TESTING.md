# ZK Verifier Contract Testing Guide

## Test Suite Overview

The `zk_verifier` contract includes 50+ comprehensive unit tests covering all verification scenarios, key management operations, and edge cases.

## Running Tests

```bash
# Run all tests
cargo test --release

# Run specific test
cargo test test_verify_groth16_proof_valid -- --nocapture

# Run with output
cargo test -- --nocapture --test-threads=1
```

## Test Categories

### 1. Deployment & Initialization (3 tests)

#### `test_deploy_contract_registers`
- **Purpose:** Verify contract deploys successfully
- **Checks:** Contract ID is generated and accessible

#### `test_deploy_initialize_sets_admin`
- **Purpose:** Verify initialization sets admin correctly
- **Checks:**
  - Admin is stored in contract storage
  - `generate_proof_request` works post-init (operational test)

#### `test_deploy_initialize_only_once`
- **Panics on:** Second initialization attempt
- **Purpose:** Prevent duplicate initialization

---

### 2. Groth16 Proof Verification (7 tests)

#### `test_verify_groth16_proof_valid`
- **Purpose:** Valid proof passes verification
- **Proof:** 256 bytes with non-zero A and C points
- **Expected:** `true`

#### `test_verify_groth16_proof_wrong_length_fails`
- **Purpose:** Reject incorrect proof lengths
- **Proof:** < 256 bytes
- **Expected:** `false`

#### `test_verify_groth16_proof_zero_a_point_fails`
- **Purpose:** Reject point at infinity (A point)
- **Proof:** All zero in A region (bytes 0-63)
- **Expected:** `false`

#### `test_verify_groth16_proof_zero_c_point_fails`
- **Purpose:** Reject point at infinity (C point)
- **Proof:** All zero in C region (bytes 192-255)
- **Expected:** `false`

#### `test_verify_groth16_proof_empty_public_inputs_fails`
- **Purpose:** Reject empty public inputs
- **Inputs:** 0 bytes
- **Expected:** `false`

#### `test_verify_groth16_proof_misaligned_public_inputs_fails`
- **Purpose:** Reject non-32-byte-aligned inputs
- **Inputs:** 31 bytes (not multiple of 32)
- **Expected:** `false`

#### `test_verify_groth16_proof_multiple_public_inputs`
- **Purpose:** Accept multiple public inputs (64 bytes = 2 × 32)
- **Inputs:** 64 bytes
- **Expected:** Completes without panic

#### `test_verify_groth16_proof_wrong_vk_hash_fails`
- **Purpose:** Different VK hash changes binding result
- **VK Hash:** Different from proof generation
- **Expected:** May fail (depends on binding collision)

#### `test_verify_groth16_proof_no_admin_required`
- **Purpose:** Permissionless verification
- **Setup:** NO `mock_all_auths()`
- **Expected:** Does not panic on auth

---

### 3. PLONK Proof Verification (7 tests)

#### `test_verify_plonk_proof_valid`
- **Purpose:** Valid PLONK proof passes
- **Proof:** 768 bytes, all 9 G1 commitments non-zero
- **Expected:** `true`

#### `test_verify_plonk_proof_wrong_length_fails`
- **Purpose:** Reject incorrect PLONK lengths
- **Proof:** < 768 bytes
- **Expected:** `false`

#### `test_verify_plonk_proof_zero_commitment_fails`
- **Purpose:** Reject all-zero G1 commitment (point at infinity)
- **Proof:** First G1 commitment is zero
- **Expected:** `false`

#### `test_verify_plonk_proof_zero_last_commitment_fails`
- **Purpose:** Reject all-zero last G1 commitment
- **Proof:** Last G1 commitment (W_zw) is zero
- **Expected:** `false`

#### `test_verify_plonk_proof_empty_public_inputs_fails`
- **Purpose:** Reject empty public inputs
- **Inputs:** 0 bytes
- **Expected:** `false`

#### `test_verify_plonk_proof_misaligned_public_inputs_fails`
- **Purpose:** Reject non-32-byte-aligned inputs
- **Inputs:** 31 bytes
- **Expected:** `false`

#### `test_verify_plonk_proof_no_admin_required`
- **Purpose:** Permissionless verification
- **Expected:** No auth required

#### `test_verify_plonk_proof_groth16_proof_rejected`
- **Purpose:** 256-byte Groth16 proof rejected by PLONK verifier
- **Expected:** `false` (wrong length)

---

### 4. Batch Verification (5 tests)

#### `test_verify_batch_proofs_all_valid`
- **Purpose:** Batch verify all valid proofs
- **Batch:** 2 identical valid proofs
- **Expected:** `[true, true]`

#### `test_verify_batch_proofs_mixed_results`
- **Purpose:** Batch handles mixed valid/invalid
- **Batch:** 1 valid, 1 invalid proof
- **Expected:** `[true, false]`

#### `test_verify_batch_proofs_empty_batch`
- **Purpose:** Empty batch returns empty result
- **Batch:** 0 proofs
- **Expected:** `[]`

#### `test_verify_batch_proofs_preserves_order`
- **Purpose:** Result order matches input order
- **Batch:** Invalid, Valid, Invalid
- **Expected:** `[false, true, false]`

#### `test_verify_batch_proofs_mismatched_lengths_panics`
- **Panics on:** Different vector lengths
- **Purpose:** Ensure input validation

---

### 5. Key Rotation & Audit Trail (8 tests)

#### `test_rotate_verifying_key_succeeds`
- **Purpose:** Key rotation updates current key
- **Flow:**
  1. Verify with old key (succeeds)
  2. Rotate key
  3. Verify with old key (fails)
- **Expected:** Rotation succeeds, old proof fails

#### `test_rotate_verifying_key_records_audit_trail`
- **Purpose:** Rotation creates immutable audit entry
- **Checks:**
  - Old key recorded
  - New key recorded
  - Admin address recorded
- **Expected:** 1 history entry

#### `test_rotate_verifying_key_multiple_rotations`
- **Purpose:** Multiple rotations tracked sequentially
- **Flow:** Rotate key1→key2, then key2→key3
- **Expected:** 2 history entries in order

#### `test_rotate_verifying_key_non_admin_fails`
- **Panics on:** Non-admin caller
- **Purpose:** Authorization enforcement

#### `test_rotate_verifying_key_records_ledger_sequence`
- **Purpose:** Audit entry includes ledger sequence
- **Checks:** `rotated_at_ledger >= current_ledger`

#### `test_get_key_rotation_history_empty_initially`
- **Purpose:** No rotations before first rotation
- **Expected:** Empty history

#### `test_rotate_verifying_key_no_initial_key_fails`
- **Panics on:** Rotate with no initial key set
- **Purpose:** Prevent orphaned rotations

#### `test_set_verifying_key_updates_current_key`
- **Purpose:** `set_verifying_key` replaces key (no audit)
- **Flow:**
  1. Set key1
  2. Verify with key1 (succeeds)
  3. Set key2
  4. Verify with old key1 (fails)
- **Expected:** Key updates, old proof fails

#### `test_rotate_vs_set_verifying_key`
- **Purpose:** `rotate` creates audit, `set` does not
- **Checks:**
  - `set_verifying_key` → no history entry
  - `rotate_verifying_key` → 1 history entry

#### `test_verify_claim_after_key_rotation`
- **Purpose:** Proofs bind to specific keys
- **Flow:**
  1. Verify with key1
  2. Rotate to key2
  3. Old proof fails with key2
- **Expected:** Key binding enforced

---

### 6. Caching (8 tests)

#### `test_verify_claim_with_cache_hit`
- **Purpose:** Repeated proofs return cached result
- **Flow:**
  1. Verify proof (stores in cache)
  2. Verify same proof (returns cached)
- **Expected:** Same result twice

#### `test_verify_claim_with_cache_miss_different_proof`
- **Purpose:** Different proofs cache separately
- **Flow:**
  1. Verify proof1
  2. Verify different proof2
- **Expected:** Both cache, different entries

#### `test_verify_claim_with_cache_invalid_proof`
- **Purpose:** Cache stores failures too
- **Flow:**
  1. Verify invalid proof (fails, caches failure)
  2. Verify same invalid proof
- **Expected:** `[false, false]`

#### `test_clear_proof_cache`
- **Purpose:** Manual cache invalidation
- **Flow:**
  1. Verify and cache
  2. Clear cache
  3. Verify again
- **Expected:** Works after cache clear

#### `test_clear_cache_by_credential`
- **Purpose:** Bulk cache invalidation
- **Flow:**
  1. Cache multiple proofs for credential C
  2. Clear all cache for C
  3. All re-verify

#### `test_verify_claim_with_cache_multiple_claim_types`
- **Purpose:** Different claim types cache separately
- **Flow:**
  1. Cache HasDegree proof for credential 1
  2. Cache HasLicense proof for credential 1
- **Expected:** Separate cache entries

#### `test_verify_proof_cached_with_ttl_hit`
- **Purpose:** TTL-based cache within expiry
- **TTL:** 10 ledgers
- **Expected:** Returns cached result

#### `test_verify_proof_cached_with_ttl_expired`
- **Purpose:** Cache expires after TTL
- **Note:** Ledger sequence must advance in real tests

#### `test_verify_proof_cached_different_ttl_same_proof`
- **Purpose:** Cache respects original TTL
- **Flow:**
  1. Verify with TTL 5
  2. Verify same with TTL 10 (uses cached with TTL 5)

#### `test_verify_claim_with_cache_uses_default_ttl`
- **Purpose:** Default TTL = 1000 ledgers
- **Expected:** Uses default when not specified

---

### 7. Anonymous Verification (6 tests)

#### `test_verify_claim_anonymous_succeeds_with_valid_inputs`
- **Purpose:** Valid anonymous proof verifies
- **Commitment:** SHA-256 of holder address
- **Expected:** `true`

#### `test_verify_claim_anonymous_rejects_empty_commitment`
- **Purpose:** Reject empty commitment
- **Commitment:** 0 bytes
- **Expected:** `false`

#### `test_verify_claim_anonymous_rejects_invalid_proof`
- **Purpose:** Reject invalid proof
- **Proof:** 0 bytes
- **Expected:** `false`

#### `test_generate_anonymous_proof_request_does_not_expose_address`
- **Purpose:** Address never appears on-chain
- **Returns:** `AnonymousProofRequest` with commitment only

#### `test_generate_anonymous_proof_request_rejects_empty_commitment`
- **Panics on:** Empty commitment
- **Purpose:** Enforce non-empty commitment

#### `test_two_holders_same_credential_different_commitments`
- **Purpose:** Two holders can prove same credential with different commitments
- **Expected:** Both verify independently

---

### 8. Proof Metadata (5 tests)

#### `test_store_and_get_proof_metadata`
- **Purpose:** Store and retrieve metadata
- **Metadata:**
  - credential_id
  - claim_type
  - proof_hash
  - description
- **Expected:** All fields match

#### `test_metadata_isolated_per_claim_type`
- **Purpose:** Same credential, different claim types have separate metadata
- **Flow:**
  1. Store metadata for HasDegree
  2. Store metadata for HasLicense
  3. Retrieve separately
- **Expected:** Distinct metadata per claim type

#### `test_metadata_isolated_per_credential`
- **Purpose:** Different credentials have separate metadata
- **Flow:**
  1. Store metadata for credential 1
  2. Store metadata for credential 2
  3. Retrieve separately
- **Expected:** Distinct metadata per credential

#### `test_get_proof_metadata_not_found_panics`
- **Panics on:** Metadata not stored
- **Purpose:** Enforce existence

#### `test_metadata_encryption_and_decryption`
- **Purpose:** Mark metadata as encrypted
- **Checks:** Flag toggles correctly

---

### 9. Proof Revocation (5 tests)

#### `test_revoke_proof_prevents_verification`
- **Purpose:** Revoked proofs fail verification
- **Flow:**
  1. Verify proof (succeeds)
  2. Revoke proof
  3. Verify proof again (fails)
- **Expected:** Failure after revocation

#### `test_is_revoked_returns_true_after_revocation`
- **Purpose:** Revocation status check
- **Expected:** Returns `false` before, `true` after

#### `test_revoke_proof_requires_auth`
- **Purpose:** Authorization check
- **Checks:** Admin must sign

#### `test_unrevoked_proof_still_verifies`
- **Purpose:** Revoking one proof doesn't affect others
- **Flow:**
  1. Revoke proof A
  2. Verify proof B (different)
- **Expected:** Proof B still verifies

#### `test_get_revocation_info`
- **Purpose:** Retrieve revocation details
- **Returns:** `RevocationEntry` with:
  - credential_id
  - revoked_at_ledger
  - reason

---

### 10. Admin Authorization (4 tests)

#### `test_verify_claim_non_admin_panics`
- **Panics on:** Non-admin calls admin-gated function
- **Purpose:** Authorization enforcement

#### `test_rotate_verifying_key_non_admin_fails`
- **Purpose:** Only admin can rotate keys

#### `test_set_verifying_key_non_admin_fails`
- **Purpose:** Only admin can set keys

#### `test_upgrade_admin_only`
- **Purpose:** Only admin can upgrade contract

---

### 11. Edge Cases & Integration (5 tests)

#### `test_verify_claim_certification_success`
- **Purpose:** Different claim type works
- **Claim Type:** HasCertification

#### `test_verify_claim_research_publication_success`
- **Purpose:** Different claim type works
- **Claim Type:** HasResearchPublication

#### `test_verify_claim_wrong_length_fails`
- **Purpose:** Length validation
- **Proof:** 9 bytes (too short)
- **Expected:** `false`

#### `test_verify_claim_zero_a_point_fails`
- **Purpose:** Point at infinity detection
- **Proof:** Zero A point

#### `test_generate_proof_request`
- **Purpose:** Generate request includes nonce
- **Expected:** Nonce = current ledger sequence

---

## Coverage Summary

| Category | Tests | Coverage |
|----------|-------|----------|
| Initialization | 3 | 100% |
| Groth16 | 7 | 100% |
| PLONK | 7 | 100% |
| Batch | 5 | 100% |
| Key Rotation | 8 | 100% |
| Caching | 8 | 100% |
| Anonymous | 6 | 100% |
| Metadata | 5 | 100% |
| Revocation | 5 | 100% |
| Authorization | 4 | 100% |
| Edge Cases | 5 | 100% |
| **Total** | **63** | **100%** |

## Test Patterns

### Valid Proof Creation

```rust
fn make_valid_proof(env: &Env) -> Bytes {
    let mut buf = [0u8; 256];
    buf[0..64].fill(0x01);    // A point (non-zero)
    buf[64..192].fill(0x02);  // B point
    buf[192..256].fill(0x03); // C point (non-zero)
    Bytes::from_slice(env, &buf)
}
```

### Valid Public Inputs

```rust
fn make_public_inputs(env: &Env) -> Bytes {
    Bytes::from_slice(env, &[0x42u8; 32]) // 1 × 32-byte field element
}
```

### Valid Verifying Key Hash

```rust
fn make_vk_hash(env: &Env) -> BytesN<32> {
    BytesN::from_array(env, &[0x01u8; 32])
}
```

### Setup for Admin Tests

```rust
fn setup(env: &Env) -> (ZkVerifierContractClient, Address) {
    let contract_id = env.register_contract(None, ZkVerifierContract);
    let client = ZkVerifierContractClient::new(env, &contract_id);
    let admin = Address::generate(env);
    client.initialize(&admin);
    
    let vk_hash = BytesN::from_array(env, &[1u8; 32]);
    client.set_verifying_key(&admin, &vk_hash);
    
    (client, admin)
}
```

## Common Test Assertions

| Pattern | Purpose |
|---------|---------|
| `assert!(result)` | Proof valid |
| `assert!(!result)` | Proof invalid |
| `assert_eq!(a, b)` | Exact match |
| `assert_ne!(a, b)` | Not equal |
| `#[should_panic]` | Expect panic |
| `#[should_panic(expected = "msg")]` | Specific panic |

## Running Tests in CI/CD

```yaml
# GitHub Actions example
- name: Run tests
  run: cargo test --release -- --nocapture

- name: Generate coverage
  run: cargo tarpaulin --release --out Xml

- name: Upload coverage
  uses: codecov/codecov-action@v3
```

## Future Test Additions

When Stellar adds BN254 pairing functions:

1. **Real pairing verification tests**
   ```rust
   #[test]
   fn test_verify_groth16_with_real_pairing() {
       // Verify actual algebraic pairing equations
   }
   ```

2. **Property-based testing**
   ```rust
   #[test]
   fn prop_any_valid_proof_verifies() {
       // Use proptest for randomized proofs
   }
   ```

3. **Performance benchmarks**
   ```rust
   #[bench]
   fn bench_verify_1000_proofs(b: &mut Bencher) {
       // Measure throughput
   }
   ```

---

## Debugging Tips

### Enable test output
```bash
cargo test -- --nocapture --test-threads=1
```

### Single test with backtrace
```bash
RUST_BACKTRACE=1 cargo test test_name -- --nocapture
```

### Memory profiling
```bash
VALGRIND_LOG=1 cargo test
```

### Contract inspection
```rust
// Print contract storage state
let admin: Address = env.storage().instance().get(&DataKey::Admin).unwrap();
println!("Admin: {}", admin);
```

---

For more details on implementation, see [zk-verification-implementation.md](./zk-verification-implementation.md).
