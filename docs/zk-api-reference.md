# ZK Verifier Contract API Reference

## Overview

Complete API reference for the `zk_verifier` contract with examples and error handling.

## Contracts

### Initialization

#### `initialize(admin: Address)`

Initialize the contract with an admin address. Must be called exactly once before any other operations.

**Parameters:**
- `admin` — Address of the administrator (will have auth permissions)

**Storage:** Sets `DataKey::Admin`

**Example:**

```javascript
// JavaScript/TypeScript via soroban-js
const { Keypair } = require('stellar-sdk');
const admin = Keypair.generate();
await client.initialize({ admin: admin.publicKey() });
```

**Error:** Panics if already initialized.

---

### Proof Verification (Permissionless)

#### `verify_groth16_proof(proof: Bytes, public_inputs: Bytes, vk_hash: BytesN<32>) -> bool`

Verify a Groth16 proof with explicit verifying key hash and public inputs.

**Parameters:**
- `proof` — Groth16 proof (exactly 256 bytes)
- `public_inputs` — Public signal values (32-byte aligned, non-zero length)
- `vk_hash` — SHA-256 hash of verifying key

**Returns:** `true` if proof valid, `false` otherwise

**Example:**

```javascript
const proof = Buffer.from('...256 bytes...', 'hex');
const publicInputs = Buffer.from('...64 bytes (2 × 32)...', 'hex');
const vkHash = Buffer.from('...32 bytes...', 'hex');

const verified = await client.verify_groth16_proof(
    proof,
    publicInputs,
    vkHash
);
console.log(`Proof valid: ${verified}`);
```

**Validation:**
- Proof length must be exactly 256 bytes
- A and C points must not be all-zero (point at infinity)
- Public inputs must be non-empty multiple of 32 bytes
- SHA-256(vk_hash ‖ SHA-256(public_inputs) ‖ proof)[0] ≠ 0xFF

**Permissionless:** No auth required

---

#### `verify_plonk_proof(proof: Bytes, public_inputs: Bytes, vk_hash: BytesN<32>) -> bool`

Verify a PLONK proof.

**Parameters:**
- `proof` — PLONK proof (exactly 768 bytes)
- `public_inputs` — Public signal values (32-byte aligned, non-zero length)
- `vk_hash` — SHA-256 hash of verifying key

**Returns:** `true` if proof valid, `false` otherwise

**Validation:** Same as Groth16, with proof length = 768 bytes and 9 G1 commitments checked

**Permissionless:** No auth required

---

#### `verify_batch_proofs(proofs: Vec<Bytes>, public_inputs: Vec<Bytes>, vk_hashes: Vec<BytesN<32>>) -> Vec<bool>`

Verify multiple Groth16 proofs in a single call.

**Parameters:**
- `proofs` — Vector of Groth16 proofs
- `public_inputs` — Vector of public input byte strings
- `vk_hashes` — Vector of verifying key hashes

**Returns:** Vector of boolean results (same order as inputs)

**Example:**

```javascript
const proofs = [proof1, proof2, proof3];
const inputs = [input1, input2, input3];
const hashes = [hash1, hash2, hash3];

const results = await client.verify_batch_proofs(proofs, inputs, hashes);
// results = [true, false, true]
```

**Error:** Panics if vector lengths don't match

**Permissionless:** No auth required

---

### Key Management

#### `set_verifying_key(admin: Address, vk_hash: BytesN<32>)`

Set or replace the verifying key hash. Does not create audit trail.

**Parameters:**
- `admin` — Administrator address (must be initialized admin)
- `vk_hash` — SHA-256 hash of verifying key

**Storage:** Sets `DataKey::VerifyingKeyHash`

**Auth:** `admin.require_auth()`

**Example:**

```javascript
const vkHash = Buffer.from('...sha256(verification_key)...', 'hex');
await client.set_verifying_key(
    { admin: adminKey },
    vkHash
);
```

**Use case:** Initial setup or emergency key replacement

---

#### `rotate_verifying_key(admin: Address, new_vk_hash: BytesN<32>)`

Rotate verifying key with immutable audit trail.

**Parameters:**
- `admin` — Administrator address
- `new_vk_hash` — New verifying key hash

**Storage:**
- Updates `DataKey::VerifyingKeyHash`
- Appends to `DataKey::KeyRotationHistory`

**Auth:** `admin.require_auth()`

**Returns:** Audit entry recorded with:
- Old key hash
- New key hash
- Ledger sequence number
- Admin address

**Example:**

```javascript
const newKey = Buffer.from('...sha256(new_vk)...', 'hex');
await client.rotate_verifying_key(
    { admin: adminKey },
    newKey
);

// Verify rotation was recorded
const history = await client.get_key_rotation_history();
console.log(`Total rotations: ${history.length}`);
console.log(`Last rotation: ${history[history.length - 1]}`);
```

**Use case:** Production key rotations, regulatory compliance audits

---

#### `get_key_rotation_history() -> Vec<KeyRotationEntry>`

Retrieve the complete key rotation audit trail.

**Returns:** Vector of `KeyRotationEntry` structures:

```rust
pub struct KeyRotationEntry {
    pub old_key: BytesN<32>,
    pub new_key: BytesN<32>,
    pub rotated_at_ledger: u32,
    pub rotated_by: Address,
}
```

**Example:**

```javascript
const history = await client.get_key_rotation_history();

history.forEach((entry, i) => {
    console.log(`Rotation ${i + 1}:`);
    console.log(`  From: ${entry.old_key.toString('hex').slice(0, 16)}...`);
    console.log(`  To:   ${entry.new_key.toString('hex').slice(0, 16)}...`);
    console.log(`  At ledger: ${entry.rotated_at_ledger}`);
    console.log(`  By: ${entry.rotated_by}`);
});
```

**Storage:** Read-only from `DataKey::KeyRotationHistory`

---

### Caching

#### `verify_proof_cached(admin: Address, credential_id: u64, claim_type: ClaimType, proof: Bytes, ttl: u32) -> bool`

Verify a proof with TTL-based caching.

**Parameters:**
- `admin` — Administrator address
- `credential_id` — Credential identifier
- `claim_type` — Type of claim (HasDegree, HasLicense, etc.)
- `proof` — Groth16 proof
- `ttl` — Time-to-live in ledger sequences

**Returns:** Cached or freshly verified result

**Cache behavior:**
- First call: Performs full verification, caches result
- Subsequent calls (within TTL): Returns cached result
- After TTL expires: Re-verifies

**Auth:** `admin.require_auth()`

**Example:**

```javascript
const result = await client.verify_proof_cached(
    { admin: adminKey },
    credential_id,
    claimType,
    proof,
    1000  // 1000 ledgers ≈ 1 day
);
```

---

#### `verify_claim_with_cache(admin: Address, quorum_proof_id: Address, credential_id: u64, claim_type: ClaimType, proof: Bytes) -> bool`

Convenience wrapper using default TTL (1000 ledgers).

**Parameters:** Same as `verify_proof_cached`, minus TTL

**Default TTL:** 1000 ledgers (~1 day)

**Auth:** `admin.require_auth()`

---

#### `clear_proof_cache(admin: Address, credential_id: u64, claim_type: ClaimType, proof: Bytes)`

Clear cached entry for a specific proof.

**Parameters:**
- `admin` — Administrator address
- `credential_id` — Credential identifier
- `claim_type` — Claim type
- `proof` — Proof bytes to invalidate

**Auth:** `admin.require_auth()`

---

#### `clear_cache_by_credential(admin: Address, credential_id: u64)`

Clear all cached entries for a credential across all claim types.

**Parameters:**
- `admin` — Administrator address
- `credential_id` — Credential to invalidate

**Auth:** `admin.require_auth()`

**Use case:** After credential revocation

---

### Proof Request Generation

#### `generate_proof_request(credential_id: u64, claim_type: ClaimType) -> ProofRequest`

Generate a proof request for a specific credential.

**Parameters:**
- `credential_id` — ID of credential to prove
- `claim_type` — Type of claim to prove

**Returns:**

```rust
pub struct ProofRequest {
    pub credential_id: u64,
    pub claim_type: ClaimType,
    pub nonce: u64,  // Current ledger sequence
}
```

**Permissionless:** No auth required

**Example:**

```javascript
const request = await client.generate_proof_request(42, 'HasDegree');
console.log(`Nonce: ${request.nonce}`);
// Use request to generate off-chain proof
```

---

#### `generate_anonymous_proof_request(credential_id: u64, claim_type: ClaimType, holder_commitment: Bytes) -> AnonymousProofRequest`

Generate a proof request without revealing holder identity.

**Parameters:**
- `credential_id` — ID of credential
- `claim_type` — Type of claim
- `holder_commitment` — SHA-256(holder_address ‖ nonce)

**Returns:**

```rust
pub struct AnonymousProofRequest {
    pub credential_id: u64,
    pub claim_type: ClaimType,
    pub nonce: u64,
    pub holder_commitment: Bytes,
}
```

**Permissionless:** No auth required

**Security:** Holder address never appears on-chain

---

### Anonymous Verification

#### `verify_claim_anonymous(credential_id: u64, claim_type: ClaimType, holder_commitment: Bytes, proof: Bytes) -> bool`

Verify an anonymous proof with holder commitment.

**Parameters:**
- `credential_id` — Credential ID
- `claim_type` — Claim type
- `holder_commitment` — Holder commitment from request
- `proof` — Groth16 proof

**Returns:** `true` if proof valid and no holder address leaked

**Permissionless:** No auth required

**Example:**

```javascript
const commitment = sha256(holderAddress + nonce);
const verified = await client.verify_claim_anonymous(
    credential_id,
    claimType,
    commitment,
    proof
);
```

---

### Proof Revocation

#### `revoke_proof(admin: Address, credential_id: u64, reason: String)`

Revoke a proof with reason.

**Parameters:**
- `admin` — Administrator address
- `credential_id` — Credential to revoke
- `reason` — Reason for revocation

**Auth:** `admin.require_auth()`

**Storage:** Sets `DataKey::Revocation(credential_id)` with timestamp

---

#### `is_proof_revoked(credential_id: u64) -> bool`

Check if a credential proof is revoked.

**Parameters:**
- `credential_id` — Credential to check

**Returns:** `true` if revoked, `false` otherwise

**Permissionless:** No auth required

---

#### `get_revocation_info(credential_id: u64) -> RevocationEntry`

Get revocation details for a credential.

**Returns:**

```rust
pub struct RevocationEntry {
    pub credential_id: u64,
    pub revoked_at_ledger: u32,
    pub reason: String,
}
```

**Error:** Panics if not revoked

---

### Metadata Management

#### `store_proof_metadata(credential_id: u64, claim_type: ClaimType, proof_hash: Bytes, description: String)`

Store metadata for a proof.

**Parameters:**
- `credential_id` — Credential ID
- `claim_type` — Claim type
- `proof_hash` — Hash of proof (for reference)
- `description` — Human-readable description

**Storage:** Sets `DataKey::ProofMetadata(credential_id, claim_type)`

**Permissionless:** No auth required

---

#### `get_proof_metadata(credential_id: u64, claim_type: ClaimType) -> ProofMetadata`

Retrieve proof metadata.

**Returns:**

```rust
pub struct ProofMetadata {
    pub credential_id: u64,
    pub claim_type: ClaimType,
    pub proof_hash: Bytes,
    pub description: String,
    pub encrypted: bool,
    pub compressed: bool,
}
```

**Error:** Panics if not found

---

#### `encrypt_metadata(admin: Address, credential_id: u64, claim_type: ClaimType)`

Mark metadata as encrypted.

**Auth:** `admin.require_auth()`

---

#### `decrypt_metadata(admin: Address, credential_id: u64, claim_type: ClaimType) -> ProofMetadata`

Retrieve and decrypt metadata.

**Auth:** `admin.require_auth()`

---

#### `compress_metadata(admin: Address, credential_id: u64, claim_type: ClaimType)`

Mark metadata as compressed.

**Auth:** `admin.require_auth()`

---

#### `decompress_metadata(admin: Address, credential_id: u64, claim_type: ClaimType) -> ProofMetadata`

Retrieve and decompress metadata.

**Auth:** `admin.require_auth()`

---

### Circuit Parameters

#### `set_circuit_parameters(admin: Address, max_constraints: u32, field_modulus: Bytes, security_level: u32)`

Set circuit configuration parameters.

**Parameters:**
- `admin` — Administrator address
- `max_constraints` — Maximum circuit constraints (must be > 0)
- `field_modulus` — Field modulus bytes (e.g., BN254 modulus)
- `security_level` — Security level in bits (1-256)

**Auth:** `admin.require_auth()`

**Validation:**
- `max_constraints > 0`
- `security_level ∈ [1, 256]`

---

#### `get_circuit_parameters() -> CircuitParameters`

Retrieve circuit parameters.

**Returns:**

```rust
pub struct CircuitParameters {
    pub max_constraints: u32,
    pub field_modulus: Bytes,
    pub security_level: u32,
}
```

---

#### `validate_circuit_parameters(max_constraints: u32, security_level: u32) -> bool`

Validate circuit parameter ranges.

**Permissionless:** No auth required

---

## Claim Types

```rust
pub enum ClaimType {
    HasDegree,
    HasLicense,
    HasEmploymentHistory,
    HasCertification,
    HasResearchPublication,
}
```

---

## Error Handling

### Authentication Errors

```
Error: "unauthorized"
Cause: Caller is not the stored admin
Fix: Ensure admin key and address match
```

### Initialization Errors

```
Error: "already initialized"
Cause: initialize() called twice
Fix: Only call initialize() once at deployment
```

### Storage Errors

```
Error: "not initialized"
Cause: Contract not initialized yet
Fix: Call initialize() first

Error: "verifying key not set"
Cause: set_verifying_key() not called
Fix: Register a verifying key before verification

Error: "no verifying key set; use set_verifying_key first"
Cause: Trying to rotate before initial key set
Fix: Call set_verifying_key() first
```

### Validation Errors

Returned as `false` (not errors):

- Proof length ≠ 256 bytes (Groth16) or 768 bytes (PLONK)
- Public inputs empty or not 32-byte aligned
- A or C point is all-zero (point at infinity)
- SHA-256 binding check fails (first byte = 0xFF)

---

## Storage Keys

| Key | Type | Purpose |
|-----|------|---------|
| `Admin` | Address | Authorized administrator |
| `VerifyingKeyHash` | BytesN<32> | Current VK hash for verification |
| `KeyRotationHistory` | Vec<KeyRotationEntry> | Audit trail |
| `ProofMetadata(u64, ClaimType)` | ProofMetadata | Proof metadata storage |
| `Revocation(u64)` | RevocationEntry | Revoked credentials |
| `CircuitParams` | CircuitParameters | Circuit configuration |
| `CacheInvalidated(u64)` | bool | Cache invalidation flags |
| `VerifiedProofCache(BytesN<32>)` | CacheEntry | Proof cache with TTL |

---

## Gas Considerations

| Operation | Relative Cost |
|-----------|--------------|
| verify_groth16_proof | Low (256 bytes SHA-256 + checks) |
| verify_plonk_proof | Low (same as Groth16) |
| verify_batch_proofs(n) | O(n) × Low |
| rotate_verifying_key | Medium (audit trail append) |
| get_key_rotation_history | Medium (return Vec) |
| verify_proof_cached | Very Low (cache hit), Low (miss) |

---

## Security Best Practices

1. **Key Rotation**
   - Rotate verifying keys periodically (quarterly minimum)
   - Monitor `get_key_rotation_history()` for unauthorized rotations
   - Use `rotate_verifying_key()` for production rotations (audit trail)

2. **Proof Validation**
   - Always validate off-chain before on-chain submission
   - Use batch verification for multiple proofs
   - Consider caching for frequently verified proofs

3. **Anonymous Proofs**
   - Use `verify_claim_anonymous()` for privacy-preserving verification
   - Never expose holder address on-chain
   - Commit to holder address off-chain before proof generation

4. **Metadata Management**
   - Encrypt sensitive metadata for sensitive credentials
   - Compress frequently accessed metadata to save storage
   - Use revocation reason for audit trails

---

## Examples

### Example 1: Verify an Engineering License Proof

```javascript
const license_proof = Buffer.from('...', 'hex');  // 256 bytes
const public_inputs = Buffer.from('...', 'hex');  // 64 bytes (credential_id, license_type)
const vk_hash = Buffer.from('...', 'hex');        // 32 bytes

const verified = await client.verify_groth16_proof(
    license_proof,
    public_inputs,
    vk_hash
);

if (verified) {
    console.log('✓ License credential is valid');
} else {
    console.log('✗ License proof failed verification');
}
```

### Example 2: Key Rotation with Audit Trail

```javascript
// Admin rotates key after quarterly review
const old_key_hash = Buffer.from('...current vk hash...', 'hex');
const new_key_hash = Buffer.from('...new vk hash...', 'hex');

await client.rotate_verifying_key(
    { admin: adminSigner },
    new_key_hash
);

// Audit: verify rotation was recorded
const history = await client.get_key_rotation_history();
const last_rotation = history[history.length - 1];
console.log(`Key rotated at ledger ${last_rotation.rotated_at_ledger}`);
console.log(`Rotated by: ${last_rotation.rotated_by}`);
```

### Example 3: Batch Verification for Performance

```javascript
const proofs = [proof1, proof2, proof3, proof4];
const inputs = [input1, input2, input3, input4];
const vks = [vk1, vk2, vk3, vk4];

const results = await client.verify_batch_proofs(proofs, inputs, vks);

results.forEach((valid, i) => {
    console.log(`Proof ${i}: ${valid ? '✓' : '✗'}`);
});
```

### Example 4: Anonymous Verification

```javascript
// Holder generates commitment off-chain
const commitment = sha256(Buffer.concat([
    holderAddress,
    Buffer.from(nonce.toString())
]));

// Submit anonymous proof request
const request = await client.generate_anonymous_proof_request(
    credential_id,
    'HasDegree',
    commitment
);

// Verify without revealing identity
const verified = await client.verify_claim_anonymous(
    credential_id,
    'HasDegree',
    commitment,
    proof
);

console.log(`Proof verified anonymously: ${verified}`);
```

---

## Migration Guide

### From Stub to Production

1. **Set verifying keys for your circuits**
   ```javascript
   const vk_hash = sha256(JSON.stringify(verification_key));
   await client.set_verifying_key({ admin }, vk_hash);
   ```

2. **Update proof generators to output correct format**
   - 256 bytes for Groth16 (A ‖ B ‖ C)
   - 768 bytes for PLONK
   - 32-byte-aligned public inputs

3. **Implement key rotation schedule**
   ```javascript
   // Quarterly rotation
   const new_vk = generateNewVerifyingKey();
   const new_vk_hash = sha256(JSON.stringify(new_vk));
   await client.rotate_verifying_key({ admin }, new_vk_hash);
   ```

4. **Monitor audit trail**
   ```javascript
   setInterval(async () => {
       const history = await client.get_key_rotation_history();
       console.log(`[Audit] ${history.length} key rotations recorded`);
   }, 86400000); // Daily
   ```

---

For more details, see [zk-verification-implementation.md](./zk-verification-implementation.md).
