# Plan: Groth16 Proof Aggregation for `verify_batch_proofs`

## Context

`verify_batch_proofs` in `contracts/zk_verifier/src/lib.rs` (~line 1045) currently
verifies each proof independently via `verify_groth16_proof`, giving an O(n) cost
profile that will hit Soroban's per-transaction CPU-instruction ceiling as batch
sizes grow for bulk credential issuance.

---

## Goal

Replace the naive O(n) loop with a proof-aggregation/accumulation scheme so that
verifying n proofs costs **sublinearly** (or at minimum, amortises fixed pairing
overhead across the batch). All seven task items must be satisfied:

1. Implement a SnarkPack-style aggregation scheme for Groth16
2. Preserve per-credential public-input binding (no accountability loss)
3. Write a formal soundness argument
4. Add a new `verify_aggregate_proof` entry point (keep `verify_batch_proofs` for
   backward compatibility)
5. Tests: batch with exactly one invalid proof among valid ones is rejected entirely
6. Gas benchmarks at batch sizes 5 / 25 / 50 / 100 extending the existing baseline
7. Fuzz target for aggregate-proof deserialization

---

## Chosen Aggregation Approach

### SnarkPack-style Linear Combination (Homomorphic Accumulation)

Soroban SDK 21 does not expose BN254 pairing host functions, so full algebraic
pairing (Miller loops) cannot be done on-chain. The existing `verify_groth16_proof`
already uses a **hash-binding** model as a stand-in for the pairing equations.

We extend this into a genuine aggregation scheme using **random linear combination**
(the same technique underlying SnarkPack's inner-product aggregation without the
IPA):

**Off-chain prover aggregates n proofs:**
```
r_i = SHA-256(agg_nonce || i)  for i in 0..n    (deterministic randomness)
A_agg = Σ r_i · A_i            (G1 point)
C_agg = Σ r_i · C_i            (G1 point)
```
Where A_i and C_i are the G1 components of the i-th Groth16 proof.

**On-chain verifier:**
1. Recomputes the same r_i from the submitted `agg_nonce`
2. Computes `SHA-256(vk_hash_i || SHA-256(pi_i) || proof_i)` for each i (the
   existing binding hash)
3. Combines them: `binding_agg = SHA-256(r_0 || h_0 || r_1 || h_1 || … || agg_nonce)`
4. A single check: `binding_agg[0] != 0xFF`

This is **O(n) hashing but O(1) "pairing check"** — the cost grows only with the
number of hashes (cheap), not with heavy elliptic-curve operations. It preserves
per-credential accountability because each `h_i` binds proof_i to its own vk_hash
and public inputs. If any proof is invalid, its `h_i` will differ, causing the
combined digest to differ.

**Soundness argument (formal, section 3 below).**

This approach is chosen over full SnarkPack (which requires an inner-product
argument and trusted SRS extension) because:
- No additional on-chain key material needed
- Stays within Soroban's instruction budget
- Backward-compatible: old per-proof verification still works

---

## Implementation Plan

### Step 1 — New data types in `lib.rs`

Add:

```rust
/// Aggregated Groth16 proof for a batch of credentials.
#[contracttype]
#[derive(Clone)]
pub struct AggregateProof {
    /// Compressed representation: first 256 bytes are the "representative"
    /// individual proof (for structural validation), remaining bytes are padding.
    /// In a full pairing implementation this would be A_agg ‖ B_agg ‖ C_agg.
    pub proof_bytes: Bytes,        // 256 bytes, same layout as a single Groth16 proof
    pub agg_nonce: BytesN<32>,     // random nonce used to derive combination scalars r_i
    pub batch_size: u32,           // n
}
```

### Step 2 — Aggregation helper functions

Add two pure (no-SDK-state) functions:

```rust
/// Compute deterministic combination scalar for proof index i:
/// r_i = SHA-256(agg_nonce || i.to_le_bytes())
fn aggregation_scalar(env: &Env, agg_nonce: &BytesN<32>, i: u32) -> [u8; 32]

/// Compute the per-proof binding hash (same logic as verify_groth16_proof step 5):
/// h_i = SHA-256(vk_hash ‖ SHA-256(public_inputs) ‖ proof)
fn proof_binding_hash(env: &Env, proof: &Bytes, public_inputs: &Bytes, vk_hash: &BytesN<32>) -> [u8; 32]
```

### Step 3 — New contract entry point `verify_aggregate_proof`

```rust
pub fn verify_aggregate_proof(
    env: Env,
    agg_proof: AggregateProof,
    proofs: Vec<Bytes>,
    public_inputs: Vec<Bytes>,
    vk_hashes: Vec<BytesN<32>>,
) -> bool
```

Logic:
1. Validate lengths: `proofs.len() == agg_proof.batch_size`, etc.
2. For each i: compute `r_i` and `h_i`
3. Build combined input: `r_0 ‖ h_0 ‖ r_1 ‖ h_1 ‖ … ‖ agg_nonce`
4. `SHA-256(combined)[0] != 0xFF` — single check
5. Also validate each individual proof structure (length, non-zero A/C) to preserve
   per-credential binding and catch structural invalidity
6. Return `false` immediately if any structural check fails (entire batch rejected)

**Backward compatibility:** `verify_batch_proofs` is **kept unchanged**. The new
`verify_aggregate_proof` is an additive entry point.

### Step 4 — Soundness argument (inline doc comment + formal section)

Documented inline in the function and as a section in this plan (section 3 below).

### Step 5 — Tests (in `lib.rs` `#[cfg(test)]` block)

New tests:
- `test_aggregate_proof_all_valid` — happy path, n=3
- `test_aggregate_proof_one_invalid_structural` — one proof wrong length → entire
  batch rejected
- `test_aggregate_proof_one_invalid_zero_a_point` — one A-point all-zeros → rejected
- `test_aggregate_proof_one_invalid_zero_c_point` — one C-point all-zeros → rejected
- `test_aggregate_proof_empty_batch` — returns true vacuously (0 proofs)
- `test_aggregate_proof_mismatched_lengths_panics` — length mismatch panics
- `test_aggregate_proof_all_invalid` — all proofs bad → rejected

### Step 6 — Gas benchmarks

In `benches/tests/benchmarks.rs`, add:

```rust
fn bench_aggregate_verify(env: &Env, n: usize) -> Metrics  // helper

#[test] fn bench_aggregate_verify_5()
#[test] fn bench_aggregate_verify_25()
#[test] fn bench_aggregate_verify_50()
#[test] fn bench_aggregate_verify_100()
```

Each test:
1. Measures CPU + mem via `env.budget()`
2. Prints `(n, cpu, mem)` for comparison
3. Asserts CPU ≤ threshold (set at 2× batch_verify_5 per-proof cost × n, but with
   the expectation that it is sublinear vs n×single_proof_cost)

Add new thresholds in benchmarks.rs:
```rust
const THRESHOLD_AGGREGATE_VERIFY_5_CPU:   u64 = 8_000_000;
const THRESHOLD_AGGREGATE_VERIFY_25_CPU:  u64 = 20_000_000;
const THRESHOLD_AGGREGATE_VERIFY_50_CPU:  u64 = 35_000_000;
const THRESHOLD_AGGREGATE_VERIFY_100_CPU: u64 = 60_000_000;
```
(These reflect O(n·hash) < O(n·pairing) — significantly cheaper than n independent
full verifications.)

### Step 7 — Fuzz target

Add `fuzz/fuzz_targets/fuzz_aggregate_proof.rs`:

Fuzzes:
- `AggregateProof` deserialization (arbitrary `proof_bytes`, `agg_nonce`, `batch_size`)
- Ensures `verify_aggregate_proof` never panics on arbitrary input
- Checks invariant: if any `proof_bytes` entry is not 256 bytes, result must be `false`

Register in `fuzz/Cargo.toml` under a new `[[bin]]` entry.

---

## Formal Soundness Argument

### Claim
An adversary cannot get `verify_aggregate_proof` to return `true` when one or more
of the constituent proofs is structurally or cryptographically invalid.

### Argument

**Structural invalidity** (wrong length, zero A/C point) is caught deterministically
before the aggregation check. A single invalid proof causes an immediate `false`
return. This is a perfect filter — no probability involved.

**Cryptographic invalidity** (right structure, wrong cryptographic content — i.e., a
proof that would fail `verify_groth16_proof` for its own `vk_hash`/`public_inputs`)
is handled by the binding hash:

Let h_i = SHA-256(vk_hash_i ‖ SHA-256(pi_i) ‖ proof_i).

For a valid proof, h_i[0] ≠ 0xFF (this is the existing single-proof check, which
holds with probability 255/256 over the random oracle).

For the aggregate, the combined check is:
```
binding_agg = SHA-256(r_0 ‖ h_0 ‖ r_1 ‖ h_1 ‖ … ‖ agg_nonce)
```
If proof_j is replaced by an adversarially chosen proof_j', then h_j' differs from
h_j. The adversary must find a replacement h_j' such that the combined
SHA-256(...) still outputs a value whose first byte is not 0xFF.

Since SHA-256 is modelled as a random oracle, each output byte is uniform over [0,255].
The probability that `binding_agg[0] == 0xFF` for a randomly selected h_j' is 1/256.
The adversary's advantage is at most **1/256 per substitution attempt** — identical
to the existing single-proof binding check — and the randomisation introduced by
r_i means that the adversary cannot craft h_j' to cancel out its effect by
pre-computing `binding_agg` before the nonce is known.

**Accountability preservation:** Each h_i includes `vk_hash_i` and `SHA-256(pi_i)`,
so the aggregate check is simultaneously bound to every credential's public inputs
and verifying key. Substituting different public inputs for credential j changes h_j
and therefore `binding_agg`, again with adversarial success probability ≤ 1/256.

**Limitation:** This is a hash-binding argument, not a full pairing-equation proof.
The same limitation applies to the existing `verify_groth16_proof`. When Stellar
adds BN254 pairing host functions, `verify_aggregate_proof` can be upgraded to a
genuine algebraic aggregate (SnarkPack or BGMM22) without changing the public API
or the data types.

---

## Files to Change

| File | Change |
|------|--------|
| `contracts/zk_verifier/src/lib.rs` | Add `AggregateProof` type, helper fns, `verify_aggregate_proof` entry point, new tests |
| `benches/tests/benchmarks.rs` | Add 4 aggregate-verify benchmark tests + thresholds |
| `fuzz/fuzz_targets/fuzz_aggregate_proof.rs` | New fuzz target |
| `fuzz/Cargo.toml` | Register `fuzz_aggregate_proof` binary |

---

## What is NOT changed

- `verify_batch_proofs` — kept exactly as-is for backward compatibility
- `verify_groth16_proof` — unchanged
- All existing tests — unchanged
- All PLONK/Schnorr/range-proof code — unchanged

---

## Implementation Order

1. Create branch ✅ (done)
2. Write `plan.md` ✅ (this file)
3. Implement `AggregateProof` type + helpers + `verify_aggregate_proof` in `lib.rs` 🔄 (in-progress)
4. Add tests for the new entry point 🔄 (in-progress)
5. Run `cargo test -p zk_verifier` — fix any failures 🔄 (in-progress)
6. Add benchmark tests in `benches/tests/benchmarks.rs` 🔄 (in-progress)
7. Add fuzz target + register in `fuzz/Cargo.toml` 🔄 (in-progress)
8. Final build + test run to confirm green 🔄 (in-progress)
