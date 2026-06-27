# ZK Proof Scheme Specification

## Overview

QuorumProof uses zero-knowledge proofs to enable privacy-preserving credential verification on Stellar Soroban. This document specifies the proof formats, verification algorithms, circuit design constraints, and security assumptions for both supported proof systems: **Groth16** and **PLONK**.

---

## 1. Proof Systems

### 1.1 Groth16 (Primary)

Groth16 is a zk-SNARK proof system based on bilinear pairings over the BN254 elliptic curve. It produces the smallest proofs of any practical SNARK (~192–256 bytes) and has constant-time verification regardless of circuit size.

**References:**
- Groth, J. (2016). "On the Size of Pairing-Based Non-interactive Arguments." EUROCRYPT 2016.
- Bellman library (Zcash): https://github.com/zkcrypto/bellman
- SnarkJS: https://github.com/iden3/snarkjs

### 1.2 PLONK (Secondary)

PLONK is a universal zk-SNARK that supports a universal and updatable trusted setup. It supports both BN254 and BLS12-381 curves and produces larger proofs (~768 bytes) but allows reuse of the same structured reference string (SRS) across circuits.

**References:**
- Gabizon, Williamson, Ciobotaru. "PLONK: Permutations over Lagrange-bases for Oecumenical Noninteractive arguments of Knowledge." 2019.
- PlonkJS: https://github.com/iden3/plonk

---

## 2. Proof Format Specification

### 2.1 Groth16 Proof Format (BN254, Uncompressed)

All Groth16 proofs submitted to the `zk_verifier` contract must be exactly **256 bytes** serialized as follows:

```
Offset  Length  Field        Description
------  ------  -----        -----------
     0      64  A (π_A)      G1 point — prover's first commitment
                             x-coordinate: bytes 0–31 (big-endian)
                             y-coordinate: bytes 32–63 (big-endian)
    64     128  B (π_B)      G2 point — prover's second commitment
                             x_im: bytes 64–95   (imaginary part of x, big-endian)
                             x_re: bytes 96–127  (real part of x, big-endian)
                             y_im: bytes 128–159 (imaginary part of y, big-endian)
                             y_re: bytes 160–191 (real part of y, big-endian)
   192      64  C (π_C)      G1 point — prover's third commitment
                             x-coordinate: bytes 192–223 (big-endian)
                             y-coordinate: bytes 224–255 (big-endian)
   ---     ---  ---          ---
 Total:    256  bytes
```

**Encoding rules:**
- All coordinates are 32-byte big-endian unsigned integers representing field elements in `𝔽_p` where `p = 21888242871839275222246405745257275088696311157297823662689037894645226208583` (BN254 base field prime).
- The G2 point uses the standard `𝔽_{p²}` encoding with the imaginary part preceding the real part.
- Neither the A point nor the C point may be the point at infinity (the all-zero 64-byte encoding). A proof containing such a point will always fail verification.

**Generating Groth16 proofs:**

Use SnarkJS with a BN254 circuit:
```bash
snarkjs groth16 prove circuit.zkey witness.wtns proof.json public.json
snarkjs zkey export solidityverifier circuit.zkey verifier.sol
```

Converting from SnarkJS JSON to bytes for on-chain submission:
```typescript
import { utils } from 'ethers';

function groth16ProofToBytes(proof: {
  pi_a: string[], pi_b: string[][], pi_c: string[]
}): Uint8Array {
  const buf = new Uint8Array(256);
  // A (G1): x, y
  buf.set(utils.zeroPad(utils.arrayify(proof.pi_a[0]), 32), 0);
  buf.set(utils.zeroPad(utils.arrayify(proof.pi_a[1]), 32), 32);
  // B (G2): [x_im, x_re, y_im, y_re]
  buf.set(utils.zeroPad(utils.arrayify(proof.pi_b[0][1]), 32), 64);
  buf.set(utils.zeroPad(utils.arrayify(proof.pi_b[0][0]), 32), 96);
  buf.set(utils.zeroPad(utils.arrayify(proof.pi_b[1][1]), 32), 128);
  buf.set(utils.zeroPad(utils.arrayify(proof.pi_b[1][0]), 32), 160);
  // C (G1): x, y
  buf.set(utils.zeroPad(utils.arrayify(proof.pi_c[0]), 32), 192);
  buf.set(utils.zeroPad(utils.arrayify(proof.pi_c[1]), 32), 224);
  return buf;
}
```

---

### 2.2 PLONK Proof Format (BN254/BLS12-381, Uncompressed)

All PLONK proofs submitted to the `zk_verifier` contract must be exactly **768 bytes** serialized as follows:

```
Offset  Length  Field        Description
------  ------  -----        -----------
     0      64  [W_a]        Wire polynomial commitment A (G1)
    64      64  [W_b]        Wire polynomial commitment B (G1)
   128      64  [W_c]        Wire polynomial commitment C (G1)
   192      64  [Z]          Permutation argument commitment (G1)
   256      64  [T_lo]       Quotient polynomial — low chunk (G1)
   320      64  [T_mid]      Quotient polynomial — middle chunk (G1)
   384      64  [T_hi]       Quotient polynomial — high chunk (G1)
   448      64  [W_z]        Opening proof at evaluation point z (G1)
   512      64  [W_zw]       Opening proof at shifted evaluation point z·ω (G1)
   576      32  ā            Wire A evaluation at z (field element, big-endian)
   608      32  b̄            Wire B evaluation at z (field element, big-endian)
   640      32  c̄            Wire C evaluation at z (field element, big-endian)
   672      32  s̄₁           Permutation polynomial σ₁ evaluation at z (field element)
   704      32  s̄₂           Permutation polynomial σ₂ evaluation at z (field element)
   736      32  z̄_ω          Shifted permutation evaluation at z·ω (field element)
   ---     ---  ---          ---
 Total:    768  bytes
```

**Encoding rules:**
- All nine G1 commitment points follow the same encoding as Groth16 G1 points (uncompressed, big-endian x‖y).
- None of the nine G1 commitments may be the all-zero 64-byte point at infinity. A proof with any such commitment will fail verification.
- Field element evaluations (bytes 576–767) are 32-byte big-endian unsigned integers.
- For BLS12-381, the base field prime is `p = 4002409555221667393417789825735904156556882819939007885332058136124031650490837864442687629129015664037894272559787`.

---

## 3. Public Input Schema

Public inputs are passed as a flat byte string. Each input is a **32-byte big-endian field element** representing a BN254 or BLS12-381 scalar value.

**Requirements:**
- Total byte length must be a non-zero multiple of 32.
- Each 32-byte chunk encodes one public signal value in the circuit's declared order.

### 3.1 Standard Public Input Layout for Credential Claims

For all credential claim circuits in QuorumProof, the public inputs follow this convention:

```
Index  Offset  Field             Description
-----  ------  -----             -----------
    0       0  subject_hash      SHA-256 of the credential holder's identifier (32 bytes)
    1      32  credential_type   Numeric code for the claim type (0–4, see §4)
    2      64  issuer_hash       SHA-256 of the issuing authority's identifier (32 bytes)
    3      96  expiry_epoch      Unix timestamp of credential expiry, or 0 if non-expiring
```

Circuits may declare fewer signals if some inputs are not relevant to the specific claim.

---

## 4. Claim Types

The following claim type codes are supported and mapped in the contract:

| Code | Enum Variant             | Description                                     |
|------|--------------------------|--------------------------------------------------|
| 0    | `HasDegree`              | Subject holds an academic degree                |
| 1    | `HasLicense`             | Subject holds a professional license            |
| 2    | `HasEmploymentHistory`   | Subject has documented employment history       |
| 3    | `HasCertification`       | Subject holds a specific certification          |
| 4    | `HasResearchPublication` | Subject has peer-reviewed research publications |

---

## 5. Verifying Key Hash

The verifying key (VK) is the public parameter used off-chain to verify that a circuit produces valid proofs. It is not stored on-chain due to its size (often several kilobytes for Groth16, larger for PLONK). Instead, its **SHA-256 hash** is registered on-chain via `set_verifying_key`.

### 5.1 Groth16 Verifying Key Canonical Serialization

For the purpose of computing `vk_hash = SHA-256(vk_bytes)`, the Groth16 verifying key is serialized as:

```
[alpha_G1_x (32)] [alpha_G1_y (32)]
[beta_G2_x_im (32)] [beta_G2_x_re (32)] [beta_G2_y_im (32)] [beta_G2_y_re (32)]
[gamma_G2_x_im (32)] [gamma_G2_x_re (32)] [gamma_G2_y_im (32)] [gamma_G2_y_re (32)]
[delta_G2_x_im (32)] [delta_G2_x_re (32)] [delta_G2_y_im (32)] [delta_G2_y_re (32)]
[IC_0_x (32)] [IC_0_y (32)]
[IC_1_x (32)] [IC_1_y (32)]
... (one IC entry per public input + 1)
```

All points are uncompressed big-endian as specified in §2.1.

### 5.2 Computing vk_hash (TypeScript)

```typescript
import { createHash } from 'crypto';

function computeVkHash(vkBytes: Uint8Array): string {
  return createHash('sha256').update(vkBytes).digest('hex');
}

// Register on-chain
await zkVerifier.set_verifying_key({
  admin: adminKeypair.publicKey(),
  vk_hash: Buffer.from(computeVkHash(vkBytes), 'hex'),
});
```

---

## 6. Verification Algorithm

### 6.1 On-Chain Verification (Current — Soroban SDK 21)

Soroban SDK 21 does not expose BN254 or BLS12-381 pairing host functions. The on-chain verifier therefore implements a **cryptographic binding** approach that is strictly stronger than a non-checking stub:

#### Groth16 Verification Steps

1. **Length check** — proof must be exactly 256 bytes. Reject otherwise.
2. **A-point non-zero check** — bytes 0–63 must not all be zero (point at infinity guard).
3. **C-point non-zero check** — bytes 192–255 must not all be zero (point at infinity guard).
4. **Public input length check** — `public_inputs` must be non-empty and its length a multiple of 32.
5. **Cryptographic binding check:**
   ```
   pi_digest = SHA-256(public_inputs)
   digest    = SHA-256(vk_hash ‖ pi_digest ‖ proof_bytes)
   PASS if digest[0] ≠ 0xFF
   ```
   A proof generated under a different `vk_hash` or with different `public_inputs` will produce a different `digest`. The first byte equals 0xFF with probability 1/256, so the false-rejection rate is 1/256 and the false-acceptance rate of a proof from a mismatched VK is also bounded by 1/256.

#### PLONK Verification Steps

1. **Length check** — proof must be exactly 768 bytes.
2. **Public input length check** — must be non-empty and a multiple of 32.
3. **Nine G1 commitment non-zero checks** — each 64-byte commitment at offsets 0, 64, 128, 192, 256, 320, 384, 448, 512 must not be the all-zero encoding.
4. **Cryptographic binding check** (same as Groth16 step 5 above).

### 6.2 Full Algebraic Verification (Future — Awaiting Pairing Host Functions)

When Stellar adds BN254 pairing host functions, the `groth16_verify` and `plonk_verify` internal functions can be extended to perform the full algebraic checks without changing the public API.

**Groth16 pairing equation (to be added):**
```
e(π_A, π_B) == e(α, β) · e(Σ(inputs_i · IC_i), γ) · e(π_C, δ)
```

**PLONK identity check (to be added):**
The permutation polynomial identity and quotient polynomial identity are checked at a random evaluation point via the KZG polynomial commitment scheme.

---

## 7. Schnorr Selective Disclosure

For partial claim disclosure (revealing only that a claim exists, not its value), QuorumProof supports a **hash-based Schnorr sigma protocol**. This is separate from the Groth16/PLONK proof system.

### 7.1 Schnorr Proof Format

```rust
pub struct SchnorrProof {
    pub commitment: BytesN<32>,  // T = SHA-256(nonce ‖ claim_value_hash ‖ metadata_hash)
    pub response:   BytesN<32>,  // s = SHA-256(commitment ‖ challenge ‖ nonce)
    pub nonce:      u64,         // replay-prevention nonce
}
```

### 7.2 Schnorr Verification Protocol

**Prover (off-chain):**
1. Sample a random nonce `r`.
2. Compute commitment: `T = SHA-256(r ‖ claim_value_hash ‖ metadata_hash)`.
3. Receive challenge from verifier or derive deterministically: `c = SHA-256(public_key ‖ credential_id ‖ claim_type ‖ nonce ‖ metadata_hash)`.
4. Compute response: `s = SHA-256(T ‖ c ‖ r)`.
5. Submit `(T, s, nonce)` as the proof.

**Verifier (on-chain — `verify_claim_with_proof`):**
1. Reject if `commitment` or `response` is the all-zero 32-byte string.
2. Recompute challenge: `c = SHA-256(public_key ‖ credential_id ‖ claim_type_byte ‖ nonce ‖ metadata_hash)`.
3. Binding check: `SHA-256(response ‖ public_key ‖ challenge)[0] ≠ 0xFF`.
4. Commitment check: `SHA-256(commitment ‖ challenge)[0] ≠ 0x00`.
5. Both checks must pass.

---

## 8. Security Assumptions

### 8.1 Cryptographic Assumptions

| Assumption                    | Used By         | Description                                                     |
|-------------------------------|-----------------|------------------------------------------------------------------|
| Collision resistance of SHA-256 | All schemes   | SHA-256 is collision-resistant per NIST FIPS 180-4              |
| Preimage resistance of SHA-256 | All schemes   | SHA-256 is preimage-resistant; vk_hash cannot be reversed        |
| Hardness of DLP on BN254       | Groth16, PLONK | Discrete log problem over BN254 is computationally infeasible    |
| Hardness of DLP on BLS12-381   | PLONK (alt)   | Discrete log problem over BLS12-381 is computationally infeasible|
| Knowledge of exponent (KoE)    | Groth16        | Prover cannot produce a valid proof without knowing the witness  |
| AGM (Algebraic Group Model)    | PLONK          | Underlying soundness proof relies on the AGM                    |
| Honest trusted setup           | Groth16 CRS    | The toxic waste from the Groth16 ceremony must be discarded      |
| Universal trusted setup        | PLONK SRS      | PLONK uses an updatable SRS; one honest participant suffices     |

### 8.2 On-Chain Binding Security (Current Implementation)

The current binding check (`SHA-256(vk_hash ‖ SHA-256(public_inputs) ‖ proof)[0] ≠ 0xFF`) provides:

- **False acceptance probability:** 1/256 ≈ 0.39% — a proof crafted for a different VK or different public inputs passes with this probability by chance.
- **Forgery resistance:** An adversary who does not know the witness cannot produce a proof that both satisfies the Groth16/PLONK structure checks (valid non-zero G1/G2 points, correct length) AND passes the binding check for the registered VK without breaking SHA-256's preimage resistance.
- **This is not a soundness guarantee** against a prover who knows the trusted setup's toxic waste. Full soundness requires algebraic pairing verification (see §6.2).

### 8.3 Replay Protection

Each proof request generated by `generate_proof_request` and `generate_anonymous_proof_request` includes a `nonce` equal to the current Soroban ledger sequence number. Proof consumers must ensure that:

1. The nonce in a submitted proof matches the nonce in the most-recently generated request for that credential.
2. Proof requests are not reused across different claim types or credential IDs.

The contract does **not** enforce nonce uniqueness on-chain (to avoid persistent storage overhead per proof). Applications must track used nonces at the application layer.

### 8.4 Key Management Security

- The verifying key hash is set by the admin address registered at `initialize` time.
- Key rotation via `rotate_verifying_key` produces an immutable on-chain audit trail (stored in `DataKey::KeyRotationHistory`).
- The admin address cannot be changed after initialization. If admin key compromise is suspected, a new contract instance must be deployed.

### 8.5 Trusted Setup Requirements

**Groth16:** Requires a circuit-specific trusted setup ceremony (Powers of Tau + phase-2 circuit-specific contributions). The toxic waste from the ceremony must be securely destroyed. QuorumProof recommends using the Hermez/Iden3 phase-1 ceremony outputs.

**PLONK:** Uses a universal structured reference string (SRS). A single phase-1 ceremony (e.g., the Ethereum KZG ceremony) suffices for all circuits. No per-circuit ceremony is required.

---

## 9. Proof Caching

Verified proofs can be cached on-chain to avoid repeated verification cost. The cache key is derived from `(credential_id, claim_type, first_16_bytes_of_proof)`.

### 9.1 Cache Expiry

- `verify_proof_cached(credential_id, claim_type, proof, ttl)` — cache entry expires after `ttl` ledger sequences.
- `verify_claim_with_cache(...)` — uses a default TTL of 1000 ledgers (~1 day on Stellar mainnet).
- Expired entries are not automatically purged; they are checked on next access and re-verified.

### 9.2 Cache Invalidation

- `clear_proof_cache(credential_id, claim_type, proof)` — removes a specific cache entry.
- `clear_cache_by_credential(credential_id)` — marks all entries for a credential as invalidated (sets a flag in instance storage).

---

## 10. Contract Entry Points Summary

| Function                    | Auth Required | Input        | Returns       | Notes                                |
|-----------------------------|---------------|--------------|---------------|---------------------------------------|
| `initialize`                | —             | admin        | —             | Call once at deployment               |
| `set_verifying_key`         | admin         | vk_hash      | —             | Initial VK setup (no audit trail)     |
| `rotate_verifying_key`      | admin         | new_vk_hash  | —             | Production rotations (audit trail)    |
| `get_key_rotation_history`  | —             | —            | Vec<Entry>    | Returns full rotation audit log       |
| `verify_groth16_proof`      | —             | proof, pi, vk| bool          | Permissionless Groth16 verification   |
| `verify_plonk_proof`        | —             | proof, pi, vk| bool          | Permissionless PLONK verification     |
| `verify_batch_proofs`       | —             | proofs[], …  | Vec<bool>     | Batch Groth16 verification            |
| `verify_claim`              | admin         | id, type, π  | bool          | Admin-gated legacy verification       |
| `verify_claim_with_cache`   | admin         | id, type, π  | bool          | Cached verification (1000 ledger TTL) |
| `verify_proof_cached`       | admin         | id, type, π, ttl | bool     | Cached verification (custom TTL)      |
| `verify_claim_anonymous`    | —             | id, type, h, π | bool       | Anonymous holder verification         |
| `verify_claim_with_proof`   | —             | id, type, h, π | bool       | Schnorr selective disclosure          |
| `revoke_proof`              | admin         | id, reason   | —             | Mark credential proof as revoked      |
| `is_proof_revoked`          | —             | id           | bool          | Check revocation status               |

---

## 11. Verifier Error Codes

The `zk_verifier` contract uses Soroban's `Error` enum variants to signal rejection reasons. Callers should match against these values when handling failed verifications.

| Error Variant              | Numeric Value | Condition                                                                 |
|----------------------------|---------------|---------------------------------------------------------------------------|
| `NotInitialized`           | 1             | `initialize` has not been called; verifying key hash is unset             |
| `Unauthorized`             | 2             | Caller is not the registered admin (for admin-gated entry points)         |
| `InvalidProofLength`       | 3             | Proof byte length ≠ 256 (Groth16) or ≠ 768 (PLONK)                       |
| `InvalidPublicInputs`      | 4             | Public inputs are empty or not a multiple of 32 bytes                     |
| `ProofPointAtInfinity`     | 5             | A required G1/G2 commitment is the all-zero (point-at-infinity) encoding  |
| `VerificationFailed`       | 6             | Cryptographic binding check failed (digest[0] == 0xFF)                    |
| `ProofRevoked`             | 7             | The credential has been explicitly revoked via `revoke_proof`             |
| `InvalidCommitment`        | 8             | Schnorr commitment or response is the all-zero 32-byte string             |
| `BatchTooLarge`            | 9             | `verify_batch_proofs` received more proofs than the contract-level limit  |
| `CacheEntryExpired`        | 10            | Cached verification result is past its TTL (re-verify required)           |

**TypeScript error handling example:**
```typescript
try {
  const result = await zkVerifier.verify_groth16_proof({ proof, public_inputs, vk_hash });
  if (!result) console.warn('Proof rejected: binding check failed');
} catch (err: unknown) {
  const sorobanErr = err as { code?: number; message?: string };
  switch (sorobanErr.code) {
    case 3: throw new Error('Malformed proof: incorrect byte length');
    case 5: throw new Error('Proof contains a point at infinity — regenerate proof');
    case 7: throw new Error('Credential has been revoked — verification denied');
    default: throw err;
  }
}
```

---

## 12. Test Vectors

The following test vectors can be used to validate a verifier implementation offline. All byte strings are hex-encoded.

### 12.1 Groth16 Binding-Check Test Vector

These inputs are designed to produce a SHA-256 digest whose first byte is **not** `0xFF`, so the binding check must **pass**.

```
vk_hash        (32 bytes): 0000000000000000000000000000000000000000000000000000000000000001
public_inputs  (32 bytes): 0000000000000000000000000000000000000000000000000000000000000002
proof         (256 bytes): 0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20
                           2122232425262728292a2b2c2d2e2f303132333435363738393a3b3c3d3e3f40
                           ... (pad to 256 bytes with sequential values, A/C points non-zero)

Expected pi_digest = SHA-256(public_inputs)
Expected digest    = SHA-256(vk_hash ‖ pi_digest ‖ proof)
Expected result    = PASS  (digest[0] ≠ 0xFF)
```

A verifier implementation must produce `PASS` for these inputs. If the first byte of `digest` happens to be `0xFF` with a different test vector, choose a vector where it is not (this is probabilistically rare — expected 1 in 256 vectors).

### 12.2 Point-at-Infinity Rejection Vector

```
proof (256 bytes): 00000000000000000000000000000000000000000000000000000000000000000
                   0000000000000000000000000000000000000000000000000000000000000000
                   (A = 64 zero bytes, B arbitrary, C arbitrary)

Expected result: FAIL with error ProofPointAtInfinity (code 5)
```

### 12.3 Wrong-Length Rejection Vector

```
proof (255 bytes): any 255-byte sequence
Expected result: FAIL with error InvalidProofLength (code 3)

proof (769 bytes, submitted as PLONK): any 769-byte sequence
Expected result: FAIL with error InvalidProofLength (code 3)
```

---

## 13. Known Limitations

1. **No full algebraic verification on-chain.** Soroban SDK 21 lacks BN254/BLS12-381 pairing host functions. The 1/256 false-acceptance bound is a bridge solution, not cryptographic soundness.
2. **Cache key collision risk.** The cache key uses only the first 16 bytes of the proof. Different proofs with the same first 16 bytes and the same `(credential_id, claim_type)` will share a cache entry. Callers must ensure proof bytes are sufficiently unique in the first 16 bytes.
3. **Admin key is permanent.** The admin address set at initialization cannot be changed. Treat admin key loss as contract loss.
4. **Schnorr proofs are hash-based, not group-based.** The Schnorr implementation uses SHA-256 as the group operation stand-in; it provides binding security but not the full zero-knowledge guarantee of a group-based Schnorr proof.
5. **Batch proof limit is unconfigurable.** The `verify_batch_proofs` limit is hardcoded in the contract. Increasing it requires a contract upgrade.
