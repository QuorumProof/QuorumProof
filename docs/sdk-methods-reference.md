# QuorumProof SDK Methods Reference

Complete reference for all QuorumProof smart contract methods with detailed signatures, parameters, return values, and error handling.

---

## Table of Contents

1. [Credential Management](#credential-management)
2. [Quorum Slice Management](#quorum-slice-management)
3. [Attestation](#attestation)
4. [Verification & Queries](#verification--queries)
5. [SBT Operations](#sbt-operations)
6. [ZK Verification](#zk-verification)
7. [Error Handling Guide](#error-handling-guide)

---

## Credential Management

### issue_credential

Issues a new credential from an issuer to a subject.

**Signature**
```rust
pub fn issue_credential(
    env: Env,
    issuer: Address,
    subject: Address,
    credential_type: u32,
    metadata_hash: Bytes,
) -> u64
```

**Parameters**
- `issuer` (Address): The issuing institution (must be the transaction signer)
- `subject` (Address): The credential holder's Stellar address
- `credential_type` (u32): Credential category (1=Degree, 2=License, 3=Certification, 4=Employment)
- `metadata_hash` (Bytes): IPFS CID or SHA-256 hash of credential metadata

**Returns**
- `u64`: Unique credential ID

**Errors**
- `#1` (CredentialNotFound): Should not occur on issue
- `#4` (DuplicateCredential): Credential already exists for this subject+type
- `#7` (Unauthorized): Caller is not the issuer

**Example (TypeScript)**
```typescript
const credentialId = await issueCredential(
  issuerKeypair,
  'GBUQWP3BOUZX34ULNQG23RQ6F4YUSXHTQSXUSMIQ375YQRDX5TWUC4N',
  1, // Degree
  'QmXxxx...', // IPFS CID
);
console.log(`Issued credential: ${credentialId}`);
```

---

### get_credential

Retrieves a credential's full details.

**Signature**
```rust
pub fn get_credential(env: Env, credential_id: u64) -> Credential
```

**Parameters**
- `credential_id` (u64): The credential ID to fetch

**Returns**
```rust
pub struct Credential {
    pub id: u64,
    pub issuer: Address,
    pub subject: Address,
    pub credential_type: u32,
    pub metadata_hash: Bytes,
    pub issued_at: u64,
    pub expires_at: Option<u64>,
    pub is_revoked: bool,
}
```

**Errors**
- `#1` (CredentialNotFound): Credential ID does not exist

**Example (TypeScript)**
```typescript
const cred = await getCredential(credentialId);
console.log(`Issued by: ${cred.issuer}`);
console.log(`Revoked: ${cred.is_revoked}`);
```

---

### revoke_credential

Revokes a credential permanently. Only the issuer can revoke.

**Signature**
```rust
pub fn revoke_credential(env: Env, issuer: Address, credential_id: u64) -> ()
```

**Parameters**
- `issuer` (Address): The original issuer (must be the transaction signer)
- `credential_id` (u64): The credential to revoke

**Returns**
- `()`: Void

**Errors**
- `#1` (CredentialNotFound): Credential does not exist
- `#6` (CredentialRevoked): Already revoked
- `#7` (Unauthorized): Caller is not the issuer

**Example (TypeScript)**
```typescript
await revokeCredential(issuerKeypair, credentialId);
console.log('Credential revoked');
```

---

### credential_exists

Checks if a credential exists without fetching full details.

**Signature**
```rust
pub fn credential_exists(env: Env, credential_id: u64) -> bool
```

**Parameters**
- `credential_id` (u64): The credential ID to check

**Returns**
- `bool`: True if credential exists, false otherwise

**Errors**
- None (read-only)

**Example (TypeScript)**
```typescript
const exists = await credentialExists(credentialId);
if (!exists) {
  console.log('Credential not found');
}
```

---

### get_credentials_by_subject

Retrieves all credential IDs issued to a specific subject.

**Signature**
```rust
pub fn get_credentials_by_subject(env: Env, subject: Address) -> Vec<u64>
```

**Parameters**
- `subject` (Address): The credential holder's address

**Returns**
- `Vec<u64>`: List of credential IDs

**Errors**
- None (returns empty vec if no credentials)

**Example (TypeScript)**
```typescript
const credIds = await getCredentialsBySubject(subjectAddress);
console.log(`Subject has ${credIds.length} credentials`);
```

---

### get_credential_count

Returns the total number of credentials issued.

**Signature**
```rust
pub fn get_credential_count(env: Env) -> u64
```

**Parameters**
- None

**Returns**
- `u64`: Total credential count

**Errors**
- None

**Example (TypeScript)**
```typescript
const total = await getCredentialCount();
console.log(`Total credentials: ${total}`);
```

---

## Quorum Slice Management

### create_slice

Creates a new quorum slice with attestors and weights.

**Signature**
```rust
pub fn create_slice(
    env: Env,
    creator: Address,
    attestors: Vec<Address>,
    weights: Vec<u32>,
    threshold: u32,
) -> u64
```

**Parameters**
- `creator` (Address): The slice creator (must be the transaction signer)
- `attestors` (Vec<Address>): List of attestor addresses
- `weights` (Vec<u32>): Weight for each attestor (same length as attestors)
- `threshold` (u32): Minimum weight sum required for attestation

**Returns**
- `u64`: Unique slice ID

**Errors**
- `#7` (Unauthorized): Caller is not the creator

**Validation**
- `attestors.len() == weights.len()` (must match)
- `threshold > 0` (must be positive)
- `sum(weights) >= threshold` (threshold must be achievable)

**Example (TypeScript)**
```typescript
const sliceId = await createSlice(
  creatorKeypair,
  [
    'GBUQWP3BOUZX34ULNQG23RQ6F4YUSXHTQSXUSMIQ375YQRDX5TWUC4N', // University
    'GBUQWP3BOUZX34ULNQG23RQ6F4YUSXHTQSXUSMIQ375YQRDX5TWUC4O', // Licensing body
  ],
  [100, 50], // weights
  100, // threshold
);
console.log(`Created slice: ${sliceId}`);
```

---

### get_slice

Retrieves a quorum slice's configuration.

**Signature**
```rust
pub fn get_slice(env: Env, slice_id: u64) -> QuorumSlice
```

**Parameters**
- `slice_id` (u64): The slice ID to fetch

**Returns**
```rust
pub struct QuorumSlice {
    pub id: u64,
    pub creator: Address,
    pub attestors: Vec<Address>,
    pub weights: Vec<u32>,
    pub threshold: u32,
    pub created_at: u64,
}
```

**Errors**
- `#2` (SliceNotFound): Slice does not exist

**Example (TypeScript)**
```typescript
const slice = await getSlice(sliceId);
console.log(`Slice has ${slice.attestors.length} attestors`);
console.log(`Threshold: ${slice.threshold}`);
```

---

### add_attestor

Adds a new attestor to an existing slice.

**Signature**
```rust
pub fn add_attestor(
    env: Env,
    creator: Address,
    slice_id: u64,
    attestor: Address,
    weight: u32,
) -> ()
```

**Parameters**
- `creator` (Address): The slice creator (must be the transaction signer)
- `slice_id` (u64): The slice to modify
- `attestor` (Address): New attestor address
- `weight` (u32): Weight for the new attestor

**Returns**
- `()`: Void

**Errors**
- `#2` (SliceNotFound): Slice does not exist
- `#5` (DuplicateAttestor): Attestor already in slice
- `#7` (Unauthorized): Caller is not the creator

**Example (TypeScript)**
```typescript
await addAttestor(
  creatorKeypair,
  sliceId,
  'GBUQWP3BOUZX34ULNQG23RQ6F4YUSXHTQSXUSMIQ375YQRDX5TWUC4P',
  50,
);
console.log('Attestor added');
```

---

## Attestation

### attest

An attestor signs off on a credential within a quorum slice.

**Signature**
```rust
pub fn attest(
    env: Env,
    attestor: Address,
    credential_id: u64,
    slice_id: u64,
    value: bool,
    metadata: Option<Bytes>,
) -> ()
```

**Parameters**
- `attestor` (Address): The attesting party (must be the transaction signer)
- `credential_id` (u64): The credential being attested
- `slice_id` (u64): The quorum slice context
- `value` (bool): True to attest, false to revoke attestation
- `metadata` (Option<Bytes>): Optional attestation metadata (e.g., verification notes)

**Returns**
- `()`: Void

**Errors**
- `#1` (CredentialNotFound): Credential does not exist
- `#2` (SliceNotFound): Slice does not exist
- `#6` (CredentialRevoked): Credential is revoked
- `#7` (Unauthorized): Attestor is not in the slice

**Example (TypeScript)**
```typescript
await attest(
  attestorKeypair,
  credentialId,
  sliceId,
  true, // attest
  Buffer.from('Verified via official records'),
);
console.log('Attestation recorded');
```

---

### is_attested

Checks if a credential meets the quorum threshold for a slice.

**Signature**
```rust
pub fn is_attested(env: Env, credential_id: u64, slice_id: u64) -> bool
```

**Parameters**
- `credential_id` (u64): The credential to check
- `slice_id` (u64): The quorum slice context

**Returns**
- `bool`: True if attestation weight meets threshold, false otherwise

**Errors**
- None (returns false if credential or slice not found)

**Example (TypeScript)**
```typescript
const attested = await isAttested(credentialId, sliceId);
if (attested) {
  console.log('Credential meets quorum threshold');
}
```

---

### get_attestors

Retrieves all attestors who have signed a credential.

**Signature**
```rust
pub fn get_attestors(env: Env, credential_id: u64) -> Vec<Address>
```

**Parameters**
- `credential_id` (u64): The credential to query

**Returns**
- `Vec<Address>`: List of attestor addresses

**Errors**
- None (returns empty vec if no attestations)

**Example (TypeScript)**
```typescript
const attestors = await getAttestors(credentialId);
console.log(`${attestors.length} attestors have signed`);
```

---

## Verification & Queries

### is_expired

Checks if a credential has expired.

**Signature**
```rust
pub fn is_expired(env: Env, credential_id: u64) -> bool
```

**Parameters**
- `credential_id` (u64): The credential to check

**Returns**
- `bool`: True if expired, false if valid or no expiry set

**Errors**
- `#1` (CredentialNotFound): Credential does not exist

**Example (TypeScript)**
```typescript
const expired = await isExpired(credentialId);
if (expired) {
  console.log('Credential has expired');
}
```

---

## SBT Operations

### mint

Mints a Soulbound Token for a credential holder.

**Signature**
```rust
pub fn mint(
    env: Env,
    holder: Address,
    credential_id: u64,
    metadata_uri: Bytes,
) -> u64
```

**Parameters**
- `holder` (Address): The SBT owner (must be the transaction signer)
- `credential_id` (u64): The credential to mint as SBT
- `metadata_uri` (Bytes): IPFS URI or metadata reference

**Returns**
- `u64`: Unique token ID

**Errors**
- `#1` (CredentialNotFound): Credential does not exist
- `#7` (Unauthorized): Holder is not the credential subject

**Example (TypeScript)**
```typescript
const tokenId = await mintSbt(
  holderKeypair,
  credentialId,
  Buffer.from('ipfs://QmXxxx'),
);
console.log(`Minted SBT: ${tokenId}`);
```

---

### burn

Burns (destroys) an SBT. Only the owner can burn.

**Signature**
```rust
pub fn burn(env: Env, holder: Address, token_id: u64) -> ()
```

**Parameters**
- `holder` (Address): The SBT owner (must be the transaction signer)
- `token_id` (u64): The token to burn

**Returns**
- `()`: Void

**Errors**
- `#7` (Unauthorized): Caller is not the token owner

**Example (TypeScript)**
```typescript
await burnSbt(holderKeypair, tokenId);
console.log('SBT burned');
```

---

### owner_of

Retrieves the owner of an SBT.

**Signature**
```rust
pub fn owner_of(env: Env, token_id: u64) -> Address
```

**Parameters**
- `token_id` (u64): The token to query

**Returns**
- `Address`: The owner's Stellar address

**Errors**
- None (returns zero address if token not found)

**Example (TypeScript)**
```typescript
const owner = await ownerOf(tokenId);
console.log(`Token owner: ${owner}`);
```

---

### get_tokens_by_owner

Retrieves all SBT token IDs owned by an address.

**Signature**
```rust
pub fn get_tokens_by_owner(env: Env, owner: Address) -> Vec<u64>
```

**Parameters**
- `owner` (Address): The owner's address

**Returns**
- `Vec<u64>`: List of token IDs

**Errors**
- None (returns empty vec if no tokens)

**Example (TypeScript)**
```typescript
const tokens = await getTokensByOwner(ownerAddress);
console.log(`Owner has ${tokens.length} SBTs`);
```

---

### sbt_count

Returns the total number of SBTs minted.

**Signature**
```rust
pub fn sbt_count(env: Env) -> u64
```

**Parameters**
- None

**Returns**
- `u64`: Total SBT count

**Errors**
- None

**Example (TypeScript)**
```typescript
const total = await sbtCount();
console.log(`Total SBTs minted: ${total}`);
```

---

## ZK Verification

### verify_claim

Verifies a zero-knowledge proof for a credential claim.

**⚠️ WARNING**: This is a non-functional stub in v1.0. It accepts any non-empty 256-byte proof. Do not use in production.

**Signature**
```rust
pub fn verify_claim(
    env: Env,
    admin: Address,
    contract: Address,
    credential_id: u64,
    claim_type: Vec<Symbol>,
    proof: Bytes,
) -> bool
```

**Parameters**
- `admin` (Address): Admin account (must be the transaction signer)
- `contract` (Address): The quorum_proof contract address
- `credential_id` (u64): The credential being verified
- `claim_type` (Vec<Symbol>): Claim category (e.g., `["HasDegree"]`)
- `proof` (Bytes): ZK proof bytes (256 bytes for Groth16)

**Returns**
- `bool`: True if proof is valid, false otherwise

**Errors**
- `#7` (Unauthorized): Caller is not admin

**Supported Claim Types**
- `HasDegree` — Credential is a degree
- `HasLicense` — Credential is a license
- `HasEmploymentHistory` — Credential includes employment records
- `HasCertification` — Credential is a certification

**Example (TypeScript)**
```typescript
const valid = await verifyClaim(
  adminKeypair,
  CONTRACT_QUORUM_PROOF,
  credentialId,
  ['HasDegree'],
  proofBytes, // 256 bytes
);
console.log(`Proof valid: ${valid}`);
```

---

### generate_proof_request

Generates a proof request for a specific claim (stub in v1.0).

**Signature**
```rust
pub fn generate_proof_request(
    env: Env,
    credential_id: u64,
    claim_type: Vec<Symbol>,
) -> ProofRequest
```

**Parameters**
- `credential_id` (u64): The credential to generate proof for
- `claim_type` (Vec<Symbol>): The claim type

**Returns**
```rust
pub struct ProofRequest {
    pub credential_id: u64,
    pub claim_type: Vec<Symbol>,
    pub circuit_id: Bytes,
    pub public_inputs: Vec<Bytes>,
}
```

**Errors**
- `#1` (CredentialNotFound): Credential does not exist

**Example (TypeScript)**
```typescript
const request = await generateProofRequest(credentialId, ['HasDegree']);
console.log(`Circuit ID: ${request.circuit_id}`);
```

---

## Error Handling Guide

### Common Error Codes

| Code | Name | Cause | Recovery |
|------|------|-------|----------|
| #1 | CredentialNotFound | Invalid credential ID | Verify ID with `credential_exists()` |
| #2 | SliceNotFound | Invalid slice ID | Verify ID with `get_slice()` |
| #3 | ContractPaused | Contract is paused | Wait for admin to unpause |
| #4 | DuplicateCredential | Already issued | Check `get_credentials_by_subject()` |
| #5 | DuplicateAttestor | Already in slice | Check `get_slice()` first |
| #6 | CredentialRevoked | Credential is revoked | Issue a new credential |
| #7 | Unauthorized | Wrong signer | Ensure correct account signs |
| #8 | ThresholdNotMet | Quorum not reached | More attestors needed |

### Error Handling Pattern (TypeScript)

```typescript
async function safeIssueCredential(
  issuer: Keypair,
  subject: string,
  type: number,
  hash: string,
): Promise<bigint | null> {
  try {
    return await issueCredential(issuer, subject, type, hash);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);

    if (message.includes('DuplicateCredential')) {
      console.log('Credential already exists');
      const creds = await getCredentialsBySubject(subject);
      return creds[0]; // Return existing
    }

    if (message.includes('Unauthorized')) {
      console.error('Wrong account signing transaction');
      return null;
    }

    if (message.includes('ContractPaused')) {
      console.error('Contract is paused, try again later');
      return null;
    }

    throw err; // Re-throw unknown errors
  }
}
```

### Error Handling Pattern (Python)

```python
def safe_issue_credential(issuer, subject, cred_type, metadata_hash):
    try:
        return issue_credential(issuer, subject, cred_type, metadata_hash)
    except Exception as err:
        error_msg = str(err)

        if "DuplicateCredential" in error_msg:
            print("Credential already exists")
            creds = get_credentials_by_subject(subject)
            return creds[0] if creds else None

        if "Unauthorized" in error_msg:
            print("Wrong account signing transaction")
            return None

        if "ContractPaused" in error_msg:
            print("Contract is paused, try again later")
            return None

        raise
```

---

## Best Practices

1. **Always check existence before operations**: Use `credential_exists()` and `get_slice()` before issuing or modifying.

2. **Implement retry logic**: Network failures are transient. Use exponential backoff for retryable errors.

3. **Validate inputs**: Ensure addresses are valid Stellar addresses and IDs are positive integers.

4. **Handle revocation**: Check `is_expired()` and credential revocation status before relying on credentials.

5. **Monitor attestation progress**: Use `is_attested()` to track when quorum is reached.

6. **Cache read-only results**: Credentials and slices change infrequently. Cache results to reduce RPC calls.

7. **Use metadata wisely**: Store only essential data on-chain; use IPFS for large metadata.

---

## Further Reading

- [API Client Guide](./api-client-guide.md)
- [Error Code Reference](./error-codes.md)
- [Architecture Overview](./architecture.md)
- [Trust Slice Model](./trust-slices.md)
