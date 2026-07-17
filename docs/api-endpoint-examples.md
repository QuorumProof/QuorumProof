# API Endpoint Examples

Practical curl and JavaScript examples for every QuorumProof contract endpoint, with realistic sample responses. All hex values are representative 32-byte or proof-sized payloads.

---

## Setup

```bash
# Environment variables used throughout these examples
export CONTRACT_QUORUM_PROOF=CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4
export CONTRACT_ZK_VERIFIER=CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCSC4
export CONTRACT_SBT_REGISTRY=CBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBSC4
export ADMIN_ADDRESS=GCEZWKCA5VLDNRLN3RPRJMRZOX3Z6G5CHCGZRXDMTGEYJ66SDOQ62RK
export RPC_URL=https://soroban-testnet.stellar.org
export NETWORK_PASSPHRASE="Test SDF Network ; September 2015"
```

---

## Credential Operations (`quorum_proof` contract)

### Issue a Credential

**curl (via Soroban CLI)**
```bash
soroban contract invoke \
  --id "$CONTRACT_QUORUM_PROOF" \
  --network testnet \
  --source-account admin_key.json \
  -- issue_credential \
  --issuer "$ADMIN_ADDRESS" \
  --subject "GBVZHJRZMJXHE3RQXEKW3KRJM45OZDXOLYG35PNZGJDAZOFMFKQLM4H" \
  --credential-type 1 \
  --metadata-hash "a3f1b2c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c2d3e4f5a6b7c8d9e0f1a2"
```

**JavaScript**
```javascript
import * as StellarSdk from 'stellar-sdk';

const server = new StellarSdk.SorobanRpc.Server(process.env.RPC_URL);
const contract = new StellarSdk.Contract(process.env.CONTRACT_QUORUM_PROOF);

const metadataHash = Buffer.from(
  'a3f1b2c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c2d3e4f5a6b7c8d9e0f1a2',
  'hex'
);

const tx = new StellarSdk.TransactionBuilder(sourceAccount, { fee: '100' })
  .addOperation(contract.call(
    'issue_credential',
    StellarSdk.nativeToScVal(issuerAddress, { type: 'address' }),
    StellarSdk.nativeToScVal(subjectAddress, { type: 'address' }),
    StellarSdk.nativeToScVal(1, { type: 'u32' }),       // credential_type: 1 = Degree
    StellarSdk.nativeToScVal(metadataHash, { type: 'bytes' })
  ))
  .setNetworkPassphrase(StellarSdk.Networks.TESTNET)
  .setTimeout(30)
  .build();
```

**Sample Response**
```json
{
  "credential_id": 42
}
```

---

### Get a Credential

**curl**
```bash
soroban contract invoke \
  --id "$CONTRACT_QUORUM_PROOF" \
  --network testnet \
  -- get_credential \
  --credential-id 42
```

**JavaScript**
```javascript
const result = await server.simulateTransaction(
  buildTx(contract.call('get_credential', StellarSdk.nativeToScVal(42n, { type: 'u64' })))
);
const credential = StellarSdk.scValToNative(result.result.retval);
console.log(credential);
```

**Sample Response**
```json
{
  "id": "42",
  "issuer": "GCEZWKCA5VLDNRLN3RPRJMRZOX3Z6G5CHCGZRXDMTGEYJ66SDOQ62RK",
  "subject": "GBVZHJRZMJXHE3RQXEKW3KRJM45OZDXOLYG35PNZGJDAZOFMFKQLM4H",
  "credential_type": 1,
  "metadata_hash": "a3f1b2c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c2d3e4f5a6b7c8d9e0f1a2",
  "revoked": false,
  "expires_at": null,
  "version": 1
}
```

---

### Get Credentials by Subject

**curl**
```bash
soroban contract invoke \
  --id "$CONTRACT_QUORUM_PROOF" \
  --network testnet \
  -- get_credentials_by_subject \
  --subject "GBVZHJRZMJXHE3RQXEKW3KRJM45OZDXOLYG35PNZGJDAZOFMFKQLM4H"
```

**Sample Response**
```json
["42", "43", "71"]
```

---

### Revoke a Credential

**curl**
```bash
soroban contract invoke \
  --id "$CONTRACT_QUORUM_PROOF" \
  --network testnet \
  --source-account issuer_key.json \
  -- revoke_credential \
  --issuer "$ADMIN_ADDRESS" \
  --credential-id 42
```

**JavaScript**
```javascript
const tx = buildTx(contract.call(
  'revoke_credential',
  StellarSdk.nativeToScVal(issuerAddress, { type: 'address' }),
  StellarSdk.nativeToScVal(42n, { type: 'u64' })
));
const signed = await wallet.signTransaction(tx.toEnvelope().toXDR('base64'));
await server.sendTransaction(StellarSdk.TransactionBuilder.fromXDR(signed, StellarSdk.Networks.TESTNET));
```

**Sample Response**
```json
null
```

---

### Get Credential Count

**curl**
```bash
soroban contract invoke \
  --id "$CONTRACT_QUORUM_PROOF" \
  --network testnet \
  -- get_credential_count
```

**Sample Response**
```json
"127"
```

---

## Quorum Slice Operations

### Create a Quorum Slice

**curl**
```bash
soroban contract invoke \
  --id "$CONTRACT_QUORUM_PROOF" \
  --network testnet \
  --source-account issuer_key.json \
  -- create_quorum_slice \
  --issuer "$ADMIN_ADDRESS" \
  --threshold 2 \
  --members '["GCEZWKCA5VLDNRLN3RPRJMRZOX3Z6G5CHCGZRXDMTGEYJ66SDOQ62RK","GBVZHJRZMJXHE3RQXEKW3KRJM45OZDXOLYG35PNZGJDAZOFMFKQLM4H","GD7AHJHCDSQI6LVMEJEE2FTNCA2LJQZ4R64GUI3PWANSVEO4KF5MK7"]'
```

**Sample Response**
```json
{
  "slice_id": "7"
}
```

---

### Attest a Credential

**curl**
```bash
soroban contract invoke \
  --id "$CONTRACT_QUORUM_PROOF" \
  --network testnet \
  --source-account attestor_key.json \
  -- attest_credential \
  --attestor "GBVZHJRZMJXHE3RQXEKW3KRJM45OZDXOLYG35PNZGJDAZOFMFKQLM4H" \
  --credential-id 42 \
  --slice-id 7
```

**Sample Response**
```json
null
```

---

### Check Quorum Reached

**curl**
```bash
soroban contract invoke \
  --id "$CONTRACT_QUORUM_PROOF" \
  --network testnet \
  -- is_quorum_reached \
  --credential-id 42 \
  --slice-id 7
```

**Sample Response**
```json
true
```

---

## ZK Verifier Operations (`zk_verifier` contract)

### Verify a Groth16 Proof

**curl**
```bash
soroban contract invoke \
  --id "$CONTRACT_ZK_VERIFIER" \
  --network testnet \
  -- verify_groth16_proof \
  --proof "$(python3 -c "import secrets; print(secrets.token_hex(128))")" \
  --public-inputs "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2" \
  --vk-hash "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
```

**JavaScript**
```javascript
const proof       = Buffer.from('04a1f3...', 'hex');   // 256 bytes
const publicIn    = Buffer.from('a1b2c3...', 'hex');   // 64 bytes (2 × 32)
const vkHash      = Buffer.from('e3b0c4...', 'hex');   // 32 bytes

const result = await server.simulateTransaction(buildTx(
  zkContract.call(
    'verify_groth16_proof',
    StellarSdk.nativeToScVal(proof,     { type: 'bytes' }),
    StellarSdk.nativeToScVal(publicIn,  { type: 'bytes' }),
    StellarSdk.nativeToScVal(vkHash,    { type: 'bytes' })
  )
));
const isValid = StellarSdk.scValToNative(result.result.retval);
console.log(`Proof valid: ${isValid}`); // true
```

**Sample Response**
```json
true
```

---

### Verify a Batch of Groth16 Proofs

**JavaScript**
```javascript
const proofs = [proof1, proof2, proof3];           // each 256 bytes
const inputs = [input1, input2, input3];            // each 64 bytes
const hashes = [vkHash1, vkHash2, vkHash3];        // each 32 bytes

const result = await server.simulateTransaction(buildTx(
  zkContract.call(
    'verify_batch_proofs',
    StellarSdk.nativeToScVal(proofs,  { type: 'vec' }),
    StellarSdk.nativeToScVal(inputs,  { type: 'vec' }),
    StellarSdk.nativeToScVal(hashes,  { type: 'vec' })
  )
));
const results = StellarSdk.scValToNative(result.result.retval);
console.log(results); // [true, false, true]
```

**Sample Response**
```json
[true, false, true]
```

---

### Rotate Verifying Key

**curl**
```bash
soroban contract invoke \
  --id "$CONTRACT_ZK_VERIFIER" \
  --network testnet \
  --source-account admin_key.json \
  -- rotate_verifying_key \
  --admin "$ADMIN_ADDRESS" \
  --new-vk-hash "c2f3a4b5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2c3d4e5f6a7b8c9d0e1f2a3"
```

**Sample Response**
```json
null
```

---

### Get Key Rotation History

**curl**
```bash
soroban contract invoke \
  --id "$CONTRACT_ZK_VERIFIER" \
  --network testnet \
  -- get_key_rotation_history
```

**Sample Response**
```json
[
  {
    "old_key": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    "new_key": "c2f3a4b5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2c3d4e5f6a7b8c9d0e1f2a3",
    "rotated_at_ledger": 1048576,
    "rotated_by": "GCEZWKCA5VLDNRLN3RPRJMRZOX3Z6G5CHCGZRXDMTGEYJ66SDOQ62RK"
  }
]
```

---

### Verify Proof with Cache

**JavaScript**
```javascript
const cached = await server.simulateTransaction(buildTx(
  zkContract.call(
    'verify_proof_cached',
    StellarSdk.nativeToScVal(adminAddress, { type: 'address' }),
    StellarSdk.nativeToScVal(42n,          { type: 'u64' }),    // credential_id
    StellarSdk.nativeToScVal('HasDegree',  { type: 'symbol' }), // claim_type
    StellarSdk.nativeToScVal(proof,        { type: 'bytes' }),
    StellarSdk.nativeToScVal(1000,         { type: 'u32' })     // ttl in ledgers (~1 day)
  )
));
const isValid = StellarSdk.scValToNative(cached.result.retval);
// First call: runs full verification. Subsequent calls within 1000 ledgers return cached result.
```

**Sample Response**
```json
true
```

---

### Generate Proof Request

**curl**
```bash
soroban contract invoke \
  --id "$CONTRACT_ZK_VERIFIER" \
  --network testnet \
  -- generate_proof_request \
  --credential-id 42 \
  --claim-type "HasDegree"
```

**Sample Response**
```json
{
  "credential_id": "42",
  "claim_type": "HasDegree",
  "nonce": "1048601"
}
```

---

### Verify Anonymous Claim

**JavaScript**
```javascript
import { createHash } from 'crypto';

const nonce = 1048601n;
const commitment = createHash('sha256')
  .update(holderAddress + nonce.toString())
  .digest();

const result = await server.simulateTransaction(buildTx(
  zkContract.call(
    'verify_claim_anonymous',
    StellarSdk.nativeToScVal(42n,          { type: 'u64' }),
    StellarSdk.nativeToScVal('HasDegree',  { type: 'symbol' }),
    StellarSdk.nativeToScVal(commitment,   { type: 'bytes' }),
    StellarSdk.nativeToScVal(proof,        { type: 'bytes' })
  )
));
const ok = StellarSdk.scValToNative(result.result.retval);
console.log(`Anonymous verification: ${ok}`);
```

**Sample Response**
```json
true
```

---

## SBT Registry Operations (`sbt_registry` contract)

### Mint SBT

**curl**
```bash
soroban contract invoke \
  --id "$CONTRACT_SBT_REGISTRY" \
  --network testnet \
  --source-account holder_key.json \
  -- mint_sbt \
  --holder "GBVZHJRZMJXHE3RQXEKW3KRJM45OZDXOLYG35PNZGJDAZOFMFKQLM4H" \
  --credential-id 42
```

**Sample Response**
```json
{
  "token_id": "42"
}
```

---

### Get SBT

**curl**
```bash
soroban contract invoke \
  --id "$CONTRACT_SBT_REGISTRY" \
  --network testnet \
  -- get_sbt \
  --token-id 42
```

**Sample Response**
```json
{
  "token_id": "42",
  "holder": "GBVZHJRZMJXHE3RQXEKW3KRJM45OZDXOLYG35PNZGJDAZOFMFKQLM4H",
  "credential_id": "42",
  "minted_at_ledger": 1048590,
  "burned": false
}
```

---

## REST API (api-server)

### Search Credentials

**curl**
```bash
curl "http://localhost:3000/api/credentials/search?q=engineering&type=1&status=active&limit=5"
```

**Sample Response**
```json
{
  "results": [
    {
      "id": "42",
      "issuer": "GCEZWKCA5VLDNRLN3RPRJMRZOX3Z6G5CHCGZRXDMTGEYJ66SDOQ62RK",
      "subject": "GBVZHJRZMJXHE3RQXEKW3KRJM45OZDXOLYG35PNZGJDAZOFMFKQLM4H",
      "credential_type": 1,
      "metadata_hash": "a3f1b2c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c2d3e4f5a6b7c8d9e0f1a2",
      "revoked": false,
      "expires_at": null,
      "version": 1
    }
  ],
  "total": 1,
  "cursor": null
}
```

### Get Credential by ID

**curl**
```bash
curl "http://localhost:3000/api/credentials/42"
```

**Sample Response**
```json
{
  "id": "42",
  "issuer": "GCEZWKCA5VLDNRLN3RPRJMRZOX3Z6G5CHCGZRXDMTGEYJ66SDOQ62RK",
  "subject": "GBVZHJRZMJXHE3RQXEKW3KRJM45OZDXOLYG35PNZGJDAZOFMFKQLM4H",
  "credential_type": 1,
  "metadata_hash": "a3f1b2c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c2d3e4f5a6b7c8d9e0f1a2",
  "revoked": false,
  "expires_at": null,
  "version": 1
}
```

### Error Responses

All endpoints return standard error objects on failure:

```json
{
  "error": "CredentialNotFound",
  "code": 1001,
  "message": "Credential with id 999 does not exist"
}
```

Common error codes:

| Code | Name | Meaning |
|------|------|---------|
| 1001 | `CredentialNotFound` | No credential at the given ID |
| 1002 | `AlreadyRevoked` | Credential is already revoked |
| 1003 | `NotIssuer` | Caller is not the issuer of this credential |
| 1004 | `InvalidInput` | Parameter validation failed |
| 1005 | `Unauthorized` | Auth check failed |
| 1006 | `ContractPaused` | Contract is paused; try again later |
