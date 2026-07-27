# ZK Verification Developer Guide

## Purpose

Zero-knowledge proof verification is the most cryptographically dense part of QuorumProof, and it is easy to use the `zk_verifier` contract correctly without understanding *why* it is safe. This guide is the missing "how verification actually works" education layer: it walks through the Groth16 proof structure, the PLONK protocol currently implemented on-chain, folding schemes as the likely next step, worked examples with concrete test vectors, and the security implications a developer must keep in mind before shipping changes to this contract.

This guide is deliberately conceptual/educational. For the authoritative byte-level API, see:
- [`docs/zk-proof-scheme-specification.md`](./zk-proof-scheme-specification.md) — canonical wire formats
- [`docs/plonk-verification.md`](./plonk-verification.md) — implemented PLONK verifier details
- [`docs/groth16-migration.md`](./groth16-migration.md) — history of the Groth16 verifier's stub-to-production migration
- [`docs/zk-api-reference.md`](./zk-api-reference.md) — contract entry points
- [ADR-003: Zero-Knowledge Verification Approach](./adr/adr-003-zk-verification.md) — why Groth16 and PLONK were chosen at all

## 1. Groth16 Proof Structure and Verification

### 1.1 What a Groth16 proof actually is

Groth16 (Groth, 2016) is a pairing-based zk-SNARK for proving satisfiability of a Rank-1 Constraint System (R1CS) — the arithmetic circuit representation of a claim like "I know a valid credential attestation chain that satisfies this quorum threshold." A Groth16 proof consists of exactly three elliptic curve points:

```
π = (A, B, C)
  A ∈ G1   (64 bytes uncompressed on BN254)
  B ∈ G2   (128 bytes uncompressed on BN254)
  C ∈ G1   (64 bytes uncompressed on BN254)
  -----------------------------------------
  Total: 256 bytes  (see contracts/zk_verifier/src/lib.rs::GROTH16_PROOF_LEN)
```

This fixed, constant size regardless of circuit complexity is Groth16's headline property — a circuit with a million constraints produces the same 256-byte proof as one with ten.

### 1.2 The verification equation

A verifier holds a verifying key `VK = (α, β, γ, δ, [ICᵢ])` produced once during the circuit-specific trusted setup, plus the public inputs `x = (x₁, ..., xₗ)`. Verification checks a single pairing equation:

```
e(A, B) = e(α, β) · e(vk_x, γ) · e(C, δ)

where vk_x = IC₀ + Σ xᵢ·ICᵢ
```

`e(·,·)` is a bilinear pairing over the BN254 curve. Intuitively:
- `e(α, β)` is a fixed "anchor" baked into the verifying key
- `vk_x` binds the public inputs into a single G1 point via a linear combination
- The equation only balances if `A`, `B`, `C` were derived from a satisfying witness for *this* circuit and *these* public inputs

If any public input is wrong, or the proof was generated for a different circuit or different verifying key, the pairing equation fails.

### 1.3 How QuorumProof verifies Groth16 today

Soroban does not currently expose BN254 pairing host functions, so `contracts/zk_verifier` cannot perform the real pairing check above on-chain today. Instead it performs **structural and cryptographic binding validation**:
1. Proof is exactly 256 bytes and none of `A`, `B`, `C` is the point at infinity (all-zero)
2. A binding hash ties the proof to a specific `vk_hash` and the claimed `credential_id`/`claim_type`, so a proof cannot be replayed against a different verifying key or claim
3. Admin-gated `verify_claim` and permissionless `verify_groth16_proof` entry points enforce these checks consistently

This gives a 255/256-bit binding guarantee against proof substitution and replay, but it is **not** equivalent to full pairing-based soundness — see [Security Implications](#4-security-implications) below and [`docs/groth16-migration.md`](./groth16-migration.md) for the full rationale and the path to full pairing verification once/if Soroban exposes BN254 precompiles.

## 2. PLONK and Folding Schemes

### 2.1 PLONK, briefly

Where Groth16 needs a per-circuit trusted setup, PLONK (Gabizon, Williamson, Ciobotaru, 2019) uses a **universal and updatable** structured reference string (SRS) — one SRS (from a KZG commitment scheme) serves any circuit up to a maximum gate count. PLONK represents computation as a sequence of gates connected by a permutation argument, and a proof consists of:
- Wire commitments (`[a]`, `[b]`, `[c]`)
- A permutation accumulator commitment (`[z]`)
- Quotient polynomial commitments split into parts (`[t_lo]`, `[t_mid]`, `[t_hi]`)
- KZG opening proofs (`[W_zeta]`, `[W_zeta_omega]`)
- Scalar evaluations at the challenge point (`a_bar`, `b_bar`, `c_bar`, `s1_bar`, `s2_bar`, `zw_bar`)

QuorumProof's PLONK verifier (`contracts/zk_verifier/src/plonk.rs`) performs **genuine BLS12-381 pairing checks** — unlike the Groth16 path above, Soroban does expose the BLS12-381 pairing host functions QuorumProof relies on here. See [`docs/plonk-verification.md`](./plonk-verification.md) for the exact 624-byte proof layout and the r0-direct linearisation variant used.

### 2.2 Folding schemes — the next step beyond one-shot SNARKs

Both Groth16 and PLONK verify *one* proof for *one* circuit execution. When a workflow requires proving a chain of steps (e.g. "this credential was attested, then re-attested three times, then presented"), the naive approach is one proof per step — linear prover cost and linear on-chain verification cost.

**Folding schemes** (Nova — Kothapalli, Setty, Tzialla 2021; and successors like SuperNova, ProtoStar, HyperNova) instead "fold" two instances of the same relation into one, accumulating an arbitrary number of steps into a single running instance with **constant-size folding cost per step**. Only at the very end is a single, small "compression" SNARK (often Groth16 or PLONK itself) applied to the final folded instance to produce a succinct, verifier-friendly proof.

Why this matters for QuorumProof specifically:
- Credential lifecycles are inherently incremental (issue → attest → re-attest → revoke-check → present), which is exactly the recursive/incremental structure folding schemes target
- A folded proof lets a holder prove "my full attestation history is valid" in time roughly linear in the *number of new steps since last proof*, not the full history length
- Folding schemes are not yet implemented in this repository — they are documented here as the evaluated next architectural step, not as shipped functionality. Do not assume any `fold_*` contract entry points exist; grep `contracts/zk_verifier` before relying on this section for implementation details.

If/when folding is adopted, expect it to sit *alongside* Groth16/PLONK rather than replace them: the final compression step of a folding scheme still needs a one-shot SNARK verifier like the ones described above.

## 3. Worked Examples with Test Vectors

These examples show the exact byte layouts a developer will see when debugging proof verification. They are illustrative encodings that match the contract's documented formats — always cross-check against `contracts/zk_verifier/src/lib.rs` and its test modules for the current canonical vectors, since production keys and real curve points are not reproduced here.

### 3.1 Groth16 — minimal proof skeleton (256 bytes)

Byte layout (all-zero point coordinates below are placeholders to show *positions*, not valid curve points):

```
Offset   Length   Field
0        64       A  (G1 point, uncompressed: x‖y, 32 bytes each)
64       128      B  (G2 point, uncompressed: x_c0‖x_c1‖y_c0‖y_c1, 32 bytes each)
192      64       C  (G1 point, uncompressed: x‖y, 32 bytes each)
-------------------------------------------------------------
Total: 256 bytes
```

Verification-side pseudocode matching `contracts/zk_verifier`'s structural checks:

```rust
fn verify_groth16_structural(proof: &[u8], vk_hash: [u8; 32], credential_id: u64, claim_type: u8) -> bool {
    assert_eq!(proof.len(), 256);
    let a = &proof[0..64];
    let b = &proof[64..192];
    let c = &proof[192..256];

    // Reject the point-at-infinity encoding (all-zero) for each component.
    if a.iter().all(|&b| b == 0) { return false; }
    if b.iter().all(|&b| b == 0) { return false; }
    if c.iter().all(|&b| b == 0) { return false; }

    // Binding hash bit: proof must commit to this vk_hash + claim context.
    let binding = sha256(&[a, b, c, &vk_hash, &credential_id.to_le_bytes(), &[claim_type]].concat());
    binding_matches_embedded_tag(&binding, proof)
}
```

### 3.2 PLONK — proof component test vector (624 bytes)

```
Offset   Length   Field
0        48       [a]           wire commitment
48       48       [b]           wire commitment
96       48       [c]           wire commitment
144      48       [z]           permutation accumulator
192      48       [t_lo]        quotient (low)
240      48       [t_mid]       quotient (mid)
288      48       [t_hi]        quotient (high)
336      48       [W_zeta]      KZG opening at zeta
384      48       [W_zeta_omega] KZG opening at zeta*omega
432      32       a_bar         wire a evaluation (Fr, LE)
464      32       b_bar         wire b evaluation (Fr, LE)
496      32       c_bar         wire c evaluation (Fr, LE)
528      32       s1_bar        permutation poly 1 evaluation (Fr, LE)
560      32       s2_bar        permutation poly 2 evaluation (Fr, LE)
592      32       zw_bar        accumulator eval at zeta*omega (Fr, LE)
-------------------------------------------------------------
Total: 624 bytes
```

A verifier walks through, in order: (1) recompute the Fiat-Shamir challenges (`beta`, `gamma`, `alpha`, `zeta`, `v`, `u`) by hashing the transcript of commitments in the order they appear above, (2) evaluate the public-input polynomial at `zeta`, (3) compute the linearisation polynomial's constant term directly (the r0-direct variant), and (4) perform the final KZG batched pairing check. See [`docs/plonk-verification.md`](./plonk-verification.md) for the full transcript and pairing equation.

### 3.3 Reading a failed verification

When `verify_claim` or `verify_groth16_proof` return `false`, the two most common root causes during development are:
1. **Wrong VK hash** — the proof was generated against a different verifying key than the one registered on-chain (check `KeyRotationEntry` history for the credential's issuer — the VK may have rotated)
2. **Truncated/misordered bytes** — a common bug when hand-assembling proof bytes in a test is concatenating `A`, `B`, `C` in the wrong order, or using compressed instead of uncompressed point encoding

## 4. Security Implications

1. **Groth16's binding check is not full soundness.** Because Soroban lacks BN254 pairing host functions, the on-chain Groth16 path validates proof *shape* and *binding* but cannot verify the pairing equation itself. This means a proof that is well-formed and correctly bound to a `vk_hash` is not cryptographically guaranteed to encode a satisfying witness in the same sense a full pairing check would guarantee. Treat Groth16-verified claims as **binding-checked, not soundness-verified**, and prefer the PLONK path (which performs real BLS12-381 pairing checks) for claims where full on-chain soundness is required. Track `docs/groth16-migration.md` for when/if this changes.

2. **Trusted setup toxic waste (Groth16 only).** Groth16's per-circuit SRS has "toxic waste" (the secret randomness used to generate it) that must be destroyed. If any party retained it, they can forge proofs for that circuit that pass the pairing check. PLONK's universal SRS has the same toxic-waste requirement at generation time, but the SRS is circuit-agnostic and can be reused, reducing (not eliminating) exposure to repeated ceremonies.

3. **Verifying key rotation is a trust boundary.** `KeyRotationEntry` lets an admin rotate the registered verifying key for a circuit. A malicious or compromised admin key could rotate to a VK for which they hold the toxic waste, then forge arbitrary "valid" claims. Key rotation must be multisig-gated in production (see [`docs/deployment-guide.md`](./deployment-guide.md) §4.2) and every rotation is written to an immutable audit trail for exactly this reason.

4. **Public input binding matters as much as the proof.** A pairing check (or the binding-hash equivalent) is only meaningful relative to the specific public inputs it was computed against. Never separate a proof from its public inputs when passing them across a trust boundary (e.g. API → contract call) — a proof valid for public inputs `X` says nothing about public inputs `X'`.

5. **Proof malleability and replay.** Some proof systems permit malleating a valid proof into another valid proof for the same statement (e.g. re-randomizing `A`/`B` in certain Groth16 implementations if the implementation is not malleability-resistant). QuorumProof's binding hash over `(proof, vk_hash, credential_id, claim_type)` is specifically designed to prevent a malleated or replayed proof from being accepted for a different claim context — do not remove this binding when refactoring.

6. **Folding schemes widen the audit surface.** If folding is adopted (see §2.2), the recursive verifier circuit itself becomes part of the trusted computation — a bug in the folding/accumulation logic can silently accept an invalid step anywhere in a long chain, and that error compounds until the final compression proof is checked. Any future folding implementation needs its own dedicated security review; do not assume today's Groth16/PLONK security analysis transfers automatically.

## References
- [ADR-003: Zero-Knowledge Verification Approach](./adr/adr-003-zk-verification.md)
- [`docs/zk-proof-scheme-specification.md`](./zk-proof-scheme-specification.md)
- [`docs/plonk-verification.md`](./plonk-verification.md)
- [`docs/groth16-migration.md`](./groth16-migration.md)
- Groth, "On the Size of Pairing-Based Non-interactive Arguments" (2016)
- Gabizon, Williamson, Ciobotaru, "PLONK: Permutations over Lagrange-bases..." (2019)
- Kothapalli, Setty, Tzialla, "Nova: Recursive Zero-Knowledge Arguments from Folding Schemes" (2021)
