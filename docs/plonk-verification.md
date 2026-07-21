# PLONK Verification on Soroban

## Overview

This contract implements genuine BLS12-381 KZG-based PLONK proof verification on Soroban, following the vanilla (non-Turbo) PLONK protocol from [Gabizon, Williamson, Ciobotaru 2019](https://eprint.iacr.org/2019/953) using the r0-direct linearisation variant (the verifier computes the linearisation polynomial's constant term itself rather than requiring the prover to reveal an extra evaluation — the same approach used by production implementations such as [dusk-network/plonk](https://github.com/dusk-network/plonk)).

Unlike Groth16 verification in the same contract (which only performs hash-based binding checks due to Soroban's lack of BN254 pairing host functions), PLONK performs *genuine algebraic verification*: the KZG commitment polynomial evaluation checks are done via real pairing checks over BLS12-381 curves.

## Proof Format

A PLONK proof is a fixed-size **624 bytes** containing:

- **9 compressed G1 points** (48 bytes each, 432 bytes total):
  - `[a]` — wire commitment for witness wire `a`
  - `[b]` — wire commitment for witness wire `b`
  - `[c]` — wire commitment for witness wire `c`
  - `[z]` — permutation accumulator commitment
  - `[t_lo]` — quotient polynomial commitment (low part)
  - `[t_mid]` — quotient polynomial commitment (middle part)
  - `[t_hi]` — quotient polynomial commitment (high part)
  - `[W_zeta]` — KZG opening proof for the linearisation polynomial at the challenge point
  - `[W_zeta_omega]` — KZG opening proof for the permutation accumulator at a shifted point

- **6 little-endian Fr scalars** (32 bytes each, 192 bytes total):
  - `a_bar` — evaluation of wire `a` at the challenge point
  - `b_bar` — evaluation of wire `b` at the challenge point
  - `c_bar` — evaluation of wire `c` at the challenge point
  - `s1_bar` — evaluation of the first permutation polynomial at the challenge point
  - `s2_bar` — evaluation of the second permutation polynomial at the challenge point
  - `zw_bar` — evaluation of the permutation accumulator at `zeta * omega` (the next domain point)

## Verifying Key Format

The **PlonkVerifyingKey** is a structured on-chain object containing the circuit-specific preprocessed commitments plus metadata:

```
domain_size (u32 LE)
num_public_inputs (u32 LE)
q_m (48 bytes, compressed G1 point)  — selector: multiplication gate
q_l (48 bytes, compressed G1 point)  — selector: left wire input
q_r (48 bytes, compressed G1 point)  — selector: right wire input
q_o (48 bytes, compressed G1 point)  — selector: output wire
q_c (48 bytes, compressed G1 point)  — selector: constant (all-ones for copy constraints)
s1 (48 bytes, compressed G1 point)   — copy-permutation polynomial (first)
s2 (48 bytes, compressed G1 point)   — copy-permutation polynomial (second)
s3 (48 bytes, compressed G1 point)   — copy-permutation polynomial (third)
```

This 440-byte structure (8 + 8*48) is hashed via SHA-256 to produce the `vk_hash`:

```
vk_hash = SHA-256(canonical_bytes)
```

The same canonical byte ordering must be used both off-chain (when generating the VK and deriving its hash) and on-chain (when registering the VK and in the Fiat-Shamir transcript).

### Verifying Key Registration

Verifying keys are registered and queryable **by their hash** via:
- `set_plonk_verifying_key(admin, vk_hash, vk)` — register a new or updated circuit VK
- `rotate_plonk_verifying_key(admin, new_vk_hash, new_vk)` — rotate to a new VK with audit trail

Old verifying keys remain permanently stored and queryable by their hash, so proofs signed with any historically-registered VK remain verifiable even after rotations. This enables smooth key rollover without breaking existing proofs.

## Universal Structured Reference String (SRS)

The universal SRS is stored as a single compressed BLS12-381 G2 point:

```
tau_g2 (96 bytes, compressed G2 point)  — the element [tau]_2 in the SRS
```

This is the only on-chain component of the universal SRS. The full G1 powers-of-tau series (needed by the prover) is generated off-chain and must be derived using the same `tau` scalar.

### SRS Registration

The SRS is registered via:
- `set_plonk_srs(admin, tau_g2)` — register the universal SRS (shared across all circuits)
- `rotate_plonk_srs(admin, new_tau_g2)` — rotate the SRS with audit trail

The SRS should be generated via a multi-party trusted-setup ceremony (e.g., similar to the [Ethereum KZG ceremony](https://github.com/ethereum/kzg-ceremony) or the [Filecoin Powers of Tau](https://github.com/filecoin-project/powers-of-tau)). Historical SRS values are retained for the same backward-compatibility reasons as VK rotation.

**Security Note**: The SRS toxic-waste scalar `tau` must never be revealed. Only certified/audited trusted-setup ceremonies should be used to generate production SRS values.

## Fiat-Shamir Transcript

The verifier constructs a **SHA-256-based Fiat-Shamir transcript** to derive the challenge scalars from the proof data. This ensures the proof is tied to the specific circuit and public inputs.

Domain separator: `b"QuorumProof-PLONK-v1"`

### Transcript Sequence

The exact absorb/challenge order (side effects matter for reproducibility):

1. Absorb the verifying key's canonical bytes (circuit metadata + selector/permutation commitments)
2. Absorb the public inputs (as 32-byte scalars, concatenated)
3. Absorb the commitments `[a]`, `[b]`, `[c]` (wire commitments)
4. **Squeeze** challenge `beta`
5. **Squeeze** challenge `gamma`
6. Absorb the commitment `[z]` (permutation accumulator)
7. **Squeeze** challenge `alpha`
8. Absorb the commitments `[t_lo]`, `[t_mid]`, `[t_hi]` (quotient polynomial splits)
9. **Squeeze** challenge `zeta` (the evaluation point for the linearisation)
10. Absorb the evaluations `a_bar`, `b_bar`, `c_bar`, `s1_bar`, `s2_bar`, `zw_bar` (witness and permutation values at `zeta`)
11. **Squeeze** challenge `v` (used to build the batched commitment `[F]`)
12. Absorb the commitments `[W_zeta]`, `[W_zeta_omega]` (opening proofs)
13. **Squeeze** challenge `u` (the second batching factor)

### Challenge Derivation

Each challenge is derived via **wide (512-bit) reduction** of two SHA-256 outputs to ensure uniform distribution over the scalar field:

```
d0 = SHA-256(state || label || [0])
d1 = SHA-256(state || label || [1])
wide = d0 || d1  (512 bits)
challenge = Scalar::from_bytes_wide(&wide)
state := SHA-256(state || label || [2])
```

This ensures each challenge is independent and uniformly distributed, and the state is ratcheted forward so prior challenges cannot be derived from later ones.

## Verification Equation

The verifier checks that a **linearisation polynomial** vanishes at the evaluation point via a batched KZG pairing equation.

### Key Computations

1. **Domain utilities**:
   - `omega = domain_generator(domain_size)` — the multiplicative domain generator
   - `Z_H(zeta) = zeta^n - 1` — the vanishing polynomial at `zeta`
   - `L_1(zeta)` — the Lagrange basis polynomial for the first domain point, at `zeta`
   - `PI(zeta)` — the public-input polynomial evaluated at `zeta` (computed via Lagrange interpolation)

2. **r₀ (linearisation constant term)**:
   ```
   r0 = PI(zeta)
      - L_1(zeta) * alpha^2
      - alpha * (a_bar + beta*s1_bar + gamma) * (b_bar + beta*s2_bar + gamma) * (c_bar + gamma) * zw_bar
   ```
   This is the constant that, when subtracted from the linearisation polynomial, leaves it zero at `zeta`.

3. **[D] (linearisation commitment)**:
   ```
   [D] = a_bar*b_bar*[q_m] + a_bar*[q_l] + b_bar*[q_r] + c_bar*[q_o] + [q_c]
       + coeff_z*[z] + coeff_s3*[s3]
       - Z_H(zeta)*([t_lo] + zeta^n*[t_mid] + zeta^{2n}*[t_hi])
   ```
   where `coeff_z` and `coeff_s3` are derived from the challenges `alpha`, `beta`, `gamma`.

4. **[F] and E (batched commitments and evaluation)**:
   ```
   [F] = [D] + v*[a] + v^2*[b] + v^3*[c] + v^4*[s1] + v^5*[s2] + u*[z]
   E = -r0 + v*a_bar + v^2*b_bar + v^3*c_bar + v^4*s1_bar + v^5*s2_bar + u*zw_bar
   ```

5. **Final pairing check** (the cryptographic verification):
   ```
   e([W_zeta] + u*[W_zeta_omega], [tau]_2)
     == e(zeta*[W_zeta] + u*zeta*omega*[W_zeta_omega] + [F] - E*[1]_1, [1]_2)
   ```
   
   This check is implemented as two independent single-pair pairings (not a batched multi-Miller-loop) to avoid requiring the `alloc` feature under Soroban's `no_std` environment:
   ```rust
   pairing(&lhs_affine, &x2) == pairing(&rhs_affine, &g2_gen)
   ```

## Implementation Notes

### Why Two Single Pairings (Not Batched)?

The BLS12-381 crate is compiled with `default-features = false, features = ["groups", "pairings"]` (no `"alloc"` feature) to fit within Soroban's `no_std` execution environment. This disables access to `multi_miller_loop` and the `G2Prepared` helper. The final check instead uses two independent calls to the single-pair `pairing()` function, which is slightly less efficient (one extra Miller loop + final exponentiation) but requires no global allocator.

### Proof Structure Validation

Before any cryptographic checks, the verifier ensures:
- The proof is exactly **624 bytes**
- Public inputs are non-empty and a multiple of 32 bytes (Fr scalars)
- The public-input count matches the verifying key's metadata
- All G1/G2 points deserialize correctly as valid curve points in the prime-order subgroup

If any structural check fails, verification returns `false` without attempting pairing checks.

## Admin Key Management

### SRS Rotation (`set_plonk_srs`, `rotate_plonk_srs`)

- `set_plonk_srs(env, admin, tau_g2)` — register the SRS for the first time (panics if already set; use `rotate_plonk_srs` to update)
- `rotate_plonk_srs(env, admin, new_tau_g2)` — rotate to a new SRS
  - Admin must be authorized via `admin.require_auth()`
  - Validated via `plonk::is_valid_g2` (checks the point is on the curve and in the prime-order subgroup)
  - Creates an audit-trail entry `PlonkSrsRotationEntry { old_tau_g2, new_tau_g2, rotated_at_ledger, rotated_by }`
  - Old SRS values are retained for historical verification

### VK Rotation (`set_plonk_verifying_key`, `rotate_plonk_verifying_key`)

- `set_plonk_verifying_key(env, admin, vk_hash, vk)` — register a new circuit VK
  - Admin must be authorized
  - VK is validated: `vk.validate()` checks domain size is power-of-two, public-input count fits, all selector/permutation points are valid G1 points
  - The caller-supplied `vk_hash` must match `SHA-256(vk.canonical_bytes())`; asserts equality
  - VK is stored both by hash (`DataKey::PlonkVerifyingKeyByHash(vk_hash)`) and as the current key (`DataKey::PlonkVerifyingKeyHash`)
- `rotate_plonk_verifying_key(env, admin, new_vk_hash, new_vk)` — rotate to a new circuit VK
  - Creates an audit-trail entry `PlonkKeyRotationEntry { old_vk_hash, new_vk_hash, rotated_at_ledger, rotated_by }`
  - Old VKs remain queryable by their hash for backward compatibility

### Audit Trails

Rotation history is queryable via:
- `get_plonk_srs_rotation_history(env)` — all `PlonkSrsRotationEntry` records
- `get_plonk_key_rotation_history(env)` — all `PlonkKeyRotationEntry` records

This enables off-chain verification that key rotations follow expected governance flows and provides a cryptographic record of when keys changed.

## Security Considerations

### Unaudited Upstream Crate

The BLS12-381 elliptic-curve arithmetic is provided by the upstream [bls12_381 crate (v0.8)](https://crates.io/crates/bls12_381), which is not formally audited. The pairing check logic in this contract (`crate::plonk::verify`) has not undergone formal verification. Production deployments should consider independent code review and/or formal verification of the pairing-check implementation.

### Test SRS (Unsuitable for Production)

The test utility `plonk_test_prover::build_srs()` uses a fixed deterministic "toxic-waste" scalar:
```
tau = 0x51e_c0de (seed-dependent XOR with 424242)
```
This is **explicitly not suitable for any security-critical application** or production circuit verification. Only use this for unit testing. Production SRS values must be generated via a genuine multi-party trusted-setup ceremony with cryptographic assurance that no individual party knows `tau`.

### Groth16 vs. PLONK Asymmetry

Within the same contract, Groth16 and PLONK have different verification models:

- **Groth16** (BN254): Only SHA-256 binding checks, no pairing. Reason: Soroban SDK 21 does not expose BN254 pairing host functions. When Stellar adds BN254 pairings, the full algebraic check can be wired in.
- **PLONK** (BLS12-381): Full KZG pairing checks implemented in pure Rust arithmetic (no host function needed). More trustworthy, but significantly more computationally expensive (~5-10x Groth16).

Both approaches are intentional, not oversights. Choose the proof scheme based on your circuit size, Soroban gas budget, and security requirements.

## API Reference

### Contract Entry Points

```rust
pub fn verify_plonk_proof(
    env: Env,
    proof: Bytes,
    public_inputs: Bytes,
    vk_hash: BytesN<32>,
) -> bool
```

Permissionless entry point. Returns `true` if the proof is valid, `false` for any structural or cryptographic rejection.

### Admin Functions

```rust
pub fn set_plonk_srs(env: Env, admin: Address, tau_g2: BytesN<96>)
pub fn rotate_plonk_srs(env: Env, admin: Address, new_tau_g2: BytesN<96>)
pub fn get_plonk_srs_rotation_history(env: Env) -> Vec<PlonkSrsRotationEntry>

pub fn set_plonk_verifying_key(env: Env, admin: Address, vk_hash: BytesN<32>, vk: PlonkVerifyingKey)
pub fn rotate_plonk_verifying_key(env: Env, admin: Address, new_vk_hash: BytesN<32>, new_vk: PlonkVerifyingKey)
pub fn get_plonk_key_rotation_history(env: Env) -> Vec<PlonkKeyRotationEntry>

pub fn plonk_vk_hash(env: Env, vk: PlonkVerifyingKey) -> BytesN<32>
```

All admin functions require the caller to be authorized via `admin.require_auth()`.

## Testing

Unit tests in `contracts/zk_verifier/src/lib.rs` (mod tests) exercise:
- Valid proofs (genuine PLONK proofs from `plonk_test_prover::generate_valid_proof`)
- Structural rejections: wrong length, empty public inputs, misaligned inputs
- Cryptographic rejections: corrupted commitments, wrong verifying key, missing SRS/VK
- Groth16 cross-check: 256-byte Groth16 proofs are correctly rejected by PLONK

The test prover (`plonk_test_prover.rs`) generates genuinely valid proofs for a small (`n=4`) toy circuit with configurable witness values and variants (different selector polynomials). This ensures tests exercise real pairing checks, not mock data.

## References

- [PLONK: Permutations over Lagrange-bases for Oecumenical Noninteractive arguments of Knowledge](https://eprint.iacr.org/2019/953) — Gabizon, Williamson, Ciobotaru 2019
- [dusk-network/plonk](https://github.com/dusk-network/plonk) — A reference implementation using the r0-direct variant
- [BLS12-381 Curve Specification](https://electriccoin.co/blog/bls12-381-highlights/) — Zcash's description of the curve
- [Ethereum KZG Ceremony](https://github.com/ethereum/kzg-ceremony) — A modern multi-party trusted setup for KZG commitments
