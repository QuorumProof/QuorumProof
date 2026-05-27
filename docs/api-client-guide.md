# QuorumProof API Client Guide

This guide covers everything you need to integrate with the QuorumProof smart contracts on Stellar Soroban: authentication, error handling, retry logic, and complete code examples in TypeScript, Python, and Rust.

---

## Table of Contents

1. [Overview](#overview)
2. [Prerequisites](#prerequisites)
3. [Authentication](#authentication)
4. [Contract Addresses](#contract-addresses)
5. [Error Handling](#error-handling)
6. [Retry Logic](#retry-logic)
7. [Common Use Cases](#common-use-cases)
   - [Issue a Credential](#issue-a-credential)
   - [Create a Quorum Slice](#create-a-quorum-slice)
   - [Attest a Credential](#attest-a-credential)
   - [Verify a Credential](#verify-a-credential)
   - [Revoke a Credential](#revoke-a-credential)
8. [Read-Only Queries](#read-only-queries)
9. [ZK Claim Verification](#zk-claim-verification)
10. [SBT Operations](#sbt-operations)

---

## Overview

QuorumProof exposes three Soroban smart contracts:

| Contract | Purpose |
|----------|---------|
| `quorum_proof` | Credential issuance, quorum slices, attestation |
| `sbt_registry` | Soulbound Token minting and ownership |
| `zk_verifier` | Zero-knowledge claim verification (stub in v1.0) |

All state-mutating calls require a signed Stellar transaction. Read-only calls can be simulated without a keypair.

---

## Prerequisites

- A Stellar account funded with XLM (testnet: use [Friendbot](https://friendbot.stellar.org))
- Contract IDs from your deployment (see `scripts/deploy_testnet.sh`)
- Network RPC endpoint

```
Testnet RPC: https://soroban-testnet.stellar.org
Mainnet RPC: https://soroban-mainnet.stellar.org
```

---

## Authentication

QuorumProof contracts use Soroban's native auth model. Every mutating call must be authorized by the relevant account (issuer, attestor, or holder). There are no API keys or JWTs — authentication is purely on-chain via transaction signatures.

### Roles

| Role | Can do |
|------|--------|
| **Admin** | Pause/unpause contract, set verifying keys, blacklist holders |
| **Issuer** | Issue, revoke, suspend, and renew credentials |
| **Attestor** | Attest credentials within a quorum slice |
| **Holder** | Mint/burn their own SBTs |
| **Anyone** | Read credentials, slices, and attestation status |

---

## Contract Addresses

Store contract addresses in environment variables. Never hard-code them.

```env
CONTRACT_QUORUM_PROOF=CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4
CONTRACT_SBT_REGISTRY=CBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBSC4
CONTRACT_ZK_VERIFIER=CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCSC4
```

---

## Error Handling

Contract errors surface as `Error(Contract, #N)`. The full error code reference is in [docs/error-codes.md](./error-codes.md). The most common errors:

| Code | Name | Cause | Recovery |
|------|------|-------|----------|
| #1 | `CredentialNotFound` | Invalid credential ID | Check with `credential_exists()` first |
| #2 | `SliceNotFound` | Invalid slice ID | Check with `slice_exists()` first |
| #3 | `ContractPaused` | Contract is paused | Check `is_paused()`, wait for admin |
| #4 | `DuplicateCredential` | Already issued | Use `get_credentials_by_subject()` to check |
| #5 | `DuplicateAttestor` | Already attested | Check `get_attestors()` first |
| #6 | `CredentialRevoked` | Credential is revoked | Cannot be un-revoked; issue a new one |
| #7 | `Unauthorized` | Wrong signer | Ensure the correct account signs the tx |
| #8 | `ThresholdNotMet` | Quorum not reached | More attestors need to attest |

---

## Retry Logic

Soroban transactions can fail transiently due to network congestion or ledger sequence conflicts. Apply exponential backoff with jitter for all mutating calls.

**Retryable errors:**
- HTTP 429 (rate limited)
- HTTP 503 (RPC unavailable)
- `txBAD_SEQ` (sequence number conflict — refresh account before retrying)
- `txINSUFFICIENT_FEE` (increase fee and retry)

**Non-retryable errors:**
- Contract errors (`Error(Contract, #N)`) — these are deterministic
- `txNO_ACCOUNT` — account does not exist

---

## Common Use Cases

### Issue a Credential

Issues a credential from an issuer to a subject. Returns the new credential ID.

**TypeScript**

```typescript
import {
  Contract, Networks, rpc as StellarRpc,
  TransactionBuilder, Account, BASE_FEE, Keypair,
  nativeToScVal, Address, xdr, scValToNative,
} from '@stellar/stellar-sdk';

const RPC_URL = 'https://soroban-testnet.stellar.org';
const NETWORK_PASSPHRASE = Networks.TESTNET;
const CONTRACT_QUORUM_PROOF = process.env.CONTRACT_QUORUM_PROOF!;

const server = new StellarRpc.Server(RPC_URL, { allowHttp: false });

async function issueCredential(
  issuerKeypair: Keypair,
  subjectAddress: string,
  credentialType: number,
  metadataHash: string, // IPFS CID or SHA-256 hex
): Promise<bigint> {
  const issuerAccount = await server.getAccount(issuerKeypair.publicKey());
  const contract = new Contract(CONTRACT_QUORUM_PROOF);

  const tx = new TransactionBuilder(issuerAccount, {
    fee: BASE_FEE,
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(contract.call(
      'issue_credential',
      new Address(issuerKeypair.publicKey()).toScVal(),
      new Address(subjectAddress).toScVal(),
      nativeToScVal(credentialType, { type: 'u32' }),
      xdr.ScVal.scvBytes(Buffer.from(metadataHash, 'utf8')),
      xdr.ScVal.scvVoid(), // no expiry
    ))
    .setTimeout(30)
    .build();

  const simResult = await server.simulateTransaction(tx);
  if (StellarRpc.Api.isSimulationError(simResult)) {
    throw new Error(`Simulation failed: ${simResult.error}`);
  }

  const preparedTx = StellarRpc.assembleTransaction(tx, simResult).build();
  preparedTx.sign(issuerKeypair);

  const sendResult = await server.sendTransaction(preparedTx);
  if (sendResult.status === 'ERROR') {
    throw new Error(`Transaction failed: ${sendResult.errorResult}`);
  }

  // Poll for confirmation
  const confirmed = await pollTransaction(server, sendResult.hash);
  const returnVal = confirmed.returnValue;
  return scValToNative(returnVal!) as bigint;
}

async function pollTransaction(
  server: StellarRpc.Server,
  hash: string,
  maxAttempts = 10,
  delayMs = 2000,
) {
  for (let i = 0; i < maxAttempts; i++) {
    const result = await server.getTransaction(hash);
    if (result.status === 'SUCCESS') return result;
    if (result.status === 'FAILED') throw new Error(`Transaction failed: ${hash}`);
    await new Promise(r => setTimeout(r, delayMs));
  }
  throw new Error(`Transaction ${hash} not confirmed after ${maxAttempts} attempts`);
}
```

**Python**

```python
import time
from stellar_sdk import (
    Keypair, Network, Server, TransactionBuilder,
    scval, Address,
)
from stellar_sdk.soroban_rpc import SendTransactionStatus

RPC_URL = "https://soroban-testnet.stellar.org"
NETWORK_PASSPHRASE = Network.TESTNET_NETWORK_PASSPHRASE
CONTRACT_QUORUM_PROOF = "CAAAA..."  # from env

server = Server(RPC_URL)

def issue_credential(
    issuer_keypair: Keypair,
    subject_address: str,
    credential_type: int,
    metadata_hash: str,
) -> int:
    issuer_account = server.load_account(issuer_keypair.public_key)

    tx = (
        TransactionBuilder(
            source_account=issuer_account,
            network_passphrase=NETWORK_PASSPHRASE,
            base_fee=100,
        )
        .append_invoke_contract_function_op(
            contract_id=CONTRACT_QUORUM_PROOF,
            function_name="issue_credential",
            parameters=[
                scval.to_address(issuer_keypair.public_key),
                scval.to_address(subject_address),
                scval.to_uint32(credential_type),
                scval.to_bytes(metadata_hash.encode()),
                scval.to_void(),  # no expiry
            ],
        )
        .set_timeout(30)
        .build()
    )

    sim = server.simulate_transaction(tx)
    if sim.error:
        raise Exception(f"Simulation failed: {sim.error}")

    tx = server.prepare_transaction(tx, sim)
    tx.sign(issuer_keypair)

    result = server.send_transaction(tx)
    if result.status == SendTransactionStatus.ERROR:
        raise Exception(f"Transaction failed: {result.error_result_xdr}")

    return poll_transaction(server, result.hash)

def poll_transaction(server: Server, tx_hash: str, max_attempts: int = 10) -> int:
    for _ in range(max_attempts):
        result = server.get_transaction(tx_hash)
        if result.status == "SUCCESS":
            # Parse the returned credential ID (u64)
            return scval.from_uint64(result.return_value)
        if result.status == "FAILED":
            raise Exception(f"Transaction {tx_hash} failed")
        time.sleep(2)
    raise TimeoutError(f"Transaction {tx_hash} not confirmed")
```

**Rust**

```rust
use stellar_sdk::{
    keypair::Keypair,
    network::Networks,
    transaction::{TransactionBuilder, BASE_FEE},
    soroban::{Contract, ScVal},
    rpc::Client,
};

async fn issue_credential(
    rpc: &Client,
    issuer: &Keypair,
    subject: &str,
    credential_type: u32,
    metadata_hash: &[u8],
) -> anyhow::Result<u64> {
    let issuer_account = rpc.get_account(&issuer.public_key()).await?;
    let contract = Contract::new(std::env::var("CONTRACT_QUORUM_PROOF")?);

    let tx = TransactionBuilder::new(&issuer_account, Networks::TESTNET, BASE_FEE)
        .add_operation(contract.call(
            "issue_credential",
            &[
                ScVal::address(issuer.public_key()),
                ScVal::address(subject),
                ScVal::u32(credential_type),
                ScVal::bytes(metadata_hash),
                ScVal::void(), // no expiry
            ],
        ))
        .set_timeout(30)
        .build()?;

    let sim = rpc.simulate_transaction(&tx).await?;
    let prepared = rpc.assemble_transaction(&tx, &sim)?;
    let signed = prepared.sign(issuer)?;

    let result = rpc.send_transaction(&signed).await?;
    let confirmed = rpc.poll_transaction(&result.hash, 10, 2000).await?;

    Ok(confirmed.return_value.as_u64()?)
}
```

---

### Create a Quorum Slice

A quorum slice defines a set of attestors and the threshold weight required for a credential to be considered attested.

**TypeScript**

```typescript
async function createSlice(
  creatorKeypair: Keypair,
  attestors: string[],       // Stellar addresses
  weights: number[],         // weight per attestor (same length as attestors)
  threshold: number,         // minimum weight sum required
): Promise<bigint> {
  const account = await server.getAccount(creatorKeypair.publicKey());
  const contract = new Contract(CONTRACT_QUORUM_PROOF);

  const attestorVals = attestors.map(a => new Address(a).toScVal());
  const weightVals = weights.map(w => nativeToScVal(w, { type: 'u32' }));

  const tx = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(contract.call(
      'create_slice',
      new Address(creatorKeypair.publicKey()).toScVal(),
      xdr.ScVal.scvVec(attestorVals),
      xdr.ScVal.scvVec(weightVals),
      nativeToScVal(threshold, { type: 'u32' }),
    ))
    .setTimeout(30)
    .build();

  const simResult = await server.simulateTransaction(tx);
  if (StellarRpc.Api.isSimulationError(simResult)) {
    throw new Error(`Simulation failed: ${simResult.error}`);
  }

  const preparedTx = StellarRpc.assembleTransaction(tx, simResult).build();
  preparedTx.sign(creatorKeypair);

  const sendResult = await server.sendTransaction(preparedTx);
  const confirmed = await pollTransaction(server, sendResult.hash);
  return scValToNative(confirmed.returnValue!) as bigint;
}
```

**Python**

```python
def create_slice(
    creator_keypair: Keypair,
    attestors: list[str],
    weights: list[int],
    threshold: int,
) -> int:
    account = server.load_account(creator_keypair.public_key)

    tx = (
        TransactionBuilder(account, NETWORK_PASSPHRASE, base_fee=100)
        .append_invoke_contract_function_op(
            contract_id=CONTRACT_QUORUM_PROOF,
            function_name="create_slice",
            parameters=[
                scval.to_address(creator_keypair.public_key),
                scval.to_vec([scval.to_address(a) for a in attestors]),
                scval.to_vec([scval.to_uint32(w) for w in weights]),
                scval.to_uint32(threshold),
            ],
        )
        .set_timeout(30)
        .build()
    )

    sim = server.simulate_transaction(tx)
    tx = server.prepare_transaction(tx, sim)
    tx.sign(creator_keypair)
    result = server.send_transaction(tx)
    return poll_transaction(server, result.hash)
```

---

### Attest a Credential

An attestor signs off on a credential within a quorum slice.

**TypeScript**

```typescript
async function attest(
  attestorKeypair: Keypair,
  credentialId: bigint,
  sliceId: bigint,
  value: boolean = true,
): Promise<void> {
  const account = await server.getAccount(attestorKeypair.publicKey());
  const contract = new Contract(CONTRACT_QUORUM_PROOF);

  const tx = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(contract.call(
      'attest',
      new Address(attestorKeypair.publicKey()).toScVal(),
      nativeToScVal(credentialId, { type: 'u64' }),
      nativeToScVal(sliceId, { type: 'u64' }),
      nativeToScVal(value, { type: 'bool' }),
      xdr.ScVal.scvVoid(), // no metadata
    ))
    .setTimeout(30)
    .build();

  const simResult = await server.simulateTransaction(tx);
  if (StellarRpc.Api.isSimulationError(simResult)) {
    throw new Error(`Simulation failed: ${simResult.error}`);
  }

  const preparedTx = StellarRpc.assembleTransaction(tx, simResult).build();
  preparedTx.sign(attestorKeypair);
  const sendResult = await server.sendTransaction(preparedTx);
  await pollTransaction(server, sendResult.hash);
}
```

---

### Verify a Credential

Check whether a credential has been attested by a quorum slice. This is a read-only simulation — no transaction needed.

**TypeScript**

```typescript
async function isAttested(credentialId: bigint, sliceId: bigint): Promise<boolean> {
  const contract = new Contract(CONTRACT_QUORUM_PROOF);
  const dummyKeypair = Keypair.random();
  const dummyAccount = new Account(dummyKeypair.publicKey(), '0');

  const tx = new TransactionBuilder(dummyAccount, {
    fee: BASE_FEE,
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(contract.call(
      'is_attested',
      nativeToScVal(credentialId, { type: 'u64' }),
      nativeToScVal(sliceId, { type: 'u64' }),
    ))
    .setTimeout(30)
    .build();

  const result = await server.simulateTransaction(tx);
  if (StellarRpc.Api.isSimulationError(result)) {
    throw new Error(`Simulation failed: ${result.error}`);
  }
  return scValToNative(result.result!.retval) as boolean;
}
```

**Python**

```python
def is_attested(credential_id: int, slice_id: int) -> bool:
    dummy = Keypair.random()
    account = server.load_account(dummy.public_key)  # uses simulation, no real account needed

    tx = (
        TransactionBuilder(account, NETWORK_PASSPHRASE, base_fee=100)
        .append_invoke_contract_function_op(
            contract_id=CONTRACT_QUORUM_PROOF,
            function_name="is_attested",
            parameters=[
                scval.to_uint64(credential_id),
                scval.to_uint64(slice_id),
            ],
        )
        .set_timeout(30)
        .build()
    )

    sim = server.simulate_transaction(tx)
    if sim.error:
        raise Exception(f"Simulation failed: {sim.error}")
    return scval.from_bool(sim.result.retval)
```

---

### Revoke a Credential

Only the original issuer can revoke a credential. Revocation is permanent.

**TypeScript**

```typescript
async function revokeCredential(
  issuerKeypair: Keypair,
  credentialId: bigint,
): Promise<void> {
  const account = await server.getAccount(issuerKeypair.publicKey());
  const contract = new Contract(CONTRACT_QUORUM_PROOF);

  const tx = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(contract.call(
      'revoke_credential',
      new Address(issuerKeypair.publicKey()).toScVal(),
      nativeToScVal(credentialId, { type: 'u64' }),
    ))
    .setTimeout(30)
    .build();

  const simResult = await server.simulateTransaction(tx);
  if (StellarRpc.Api.isSimulationError(simResult)) {
    throw new Error(`Simulation failed: ${simResult.error}`);
  }

  const preparedTx = StellarRpc.assembleTransaction(tx, simResult).build();
  preparedTx.sign(issuerKeypair);
  const sendResult = await server.sendTransaction(preparedTx);
  await pollTransaction(server, sendResult.hash);
}
```

---

## Read-Only Queries

These calls simulate a transaction without submitting it. No keypair or XLM required.

| Method | Contract | Description |
|--------|----------|-------------|
| `get_credential(id)` | quorum_proof | Fetch credential struct |
| `credential_exists(id)` | quorum_proof | Check if credential exists |
| `get_credentials_by_subject(address)` | quorum_proof | All credential IDs for a subject |
| `is_attested(cred_id, slice_id)` | quorum_proof | Attestation status |
| `get_attestors(cred_id)` | quorum_proof | List of attestors |
| `is_expired(cred_id)` | quorum_proof | Expiry check |
| `get_slice(slice_id)` | quorum_proof | Fetch quorum slice struct |
| `get_credential_count()` | quorum_proof | Total credentials issued |
| `owner_of(token_id)` | sbt_registry | SBT owner address |
| `get_tokens_by_owner(address)` | sbt_registry | All SBT token IDs for an address |
| `sbt_count()` | sbt_registry | Total SBTs minted |

---

## ZK Claim Verification

> **Warning:** ZK verification is a non-functional stub in v1.0. The `verify_claim` function accepts any non-empty 256-byte proof. Do not rely on it for real privacy guarantees. See [ADR-003](./adr/adr-003-zk-verification.md) and the [README warning](../README.md).

**TypeScript**

```typescript
const CLAIM_TYPES = {
  HasDegree: { tag: 'HasDegree', values: undefined },
  HasLicense: { tag: 'HasLicense', values: undefined },
  HasEmploymentHistory: { tag: 'HasEmploymentHistory', values: undefined },
  HasCertification: { tag: 'HasCertification', values: undefined },
} as const;

async function verifyClaim(
  adminKeypair: Keypair,
  credentialId: bigint,
  claimType: keyof typeof CLAIM_TYPES,
  proofBytes: Uint8Array, // 256 bytes for Groth16 (A‖B‖C)
): Promise<boolean> {
  const account = await server.getAccount(adminKeypair.publicKey());
  const contract = new Contract(process.env.CONTRACT_ZK_VERIFIER!);

  const tx = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(contract.call(
      'verify_claim',
      new Address(adminKeypair.publicKey()).toScVal(),
      new Address(CONTRACT_QUORUM_PROOF).toScVal(),
      nativeToScVal(credentialId, { type: 'u64' }),
      xdr.ScVal.scvVec([xdr.ScVal.scvSymbol(claimType)]),
      xdr.ScVal.scvBytes(Buffer.from(proofBytes)),
    ))
    .setTimeout(30)
    .build();

  const simResult = await server.simulateTransaction(tx);
  if (StellarRpc.Api.isSimulationError(simResult)) return false;
  return scValToNative(simResult.result!.retval) as boolean;
}
```

---

## SBT Operations

### Mint an SBT

The credential holder mints their own SBT after a credential is issued.

**TypeScript**

```typescript
async function mintSbt(
  holderKeypair: Keypair,
  credentialId: bigint,
  metadataUri: string, // e.g. "ipfs://QmXxx"
): Promise<bigint> {
  const account = await server.getAccount(holderKeypair.publicKey());
  const contract = new Contract(process.env.CONTRACT_SBT_REGISTRY!);

  const tx = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(contract.call(
      'mint',
      new Address(holderKeypair.publicKey()).toScVal(),
      nativeToScVal(credentialId, { type: 'u64' }),
      xdr.ScVal.scvBytes(Buffer.from(metadataUri, 'utf8')),
    ))
    .setTimeout(30)
    .build();

  const simResult = await server.simulateTransaction(tx);
  if (StellarRpc.Api.isSimulationError(simResult)) {
    throw new Error(`Simulation failed: ${simResult.error}`);
  }

  const preparedTx = StellarRpc.assembleTransaction(tx, simResult).build();
  preparedTx.sign(holderKeypair);
  const sendResult = await server.sendTransaction(preparedTx);
  const confirmed = await pollTransaction(server, sendResult.hash);
  return scValToNative(confirmed.returnValue!) as bigint;
}
```

> **Note:** SBTs are non-transferable. Any call to `transfer()` will panic with `Error(Contract, #7)`. See [ADR-002](./adr/adr-002-sbt-non-transferability.md).

---

## Retry Logic — Full Example

```typescript
async function withRetry<T>(
  fn: () => Promise<T>,
  maxAttempts = 3,
  baseDelayMs = 1000,
): Promise<T> {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const isRetryable =
        message.includes('txBAD_SEQ') ||
        message.includes('429') ||
        message.includes('503') ||
        message.includes('txINSUFFICIENT_FEE');

      if (!isRetryable || attempt === maxAttempts) throw err;

      const jitter = Math.random() * baseDelayMs;
      const delay = baseDelayMs * 2 ** (attempt - 1) + jitter;
      await new Promise(r => setTimeout(r, delay));
    }
  }
  throw new Error('Unreachable');
}

// Usage
const credentialId = await withRetry(() =>
  issueCredential(issuerKeypair, subjectAddress, 1, metadataHash)
);
```

---

## Further Reading

- [Error Code Reference](./error-codes.md)
- [Architecture Decision Records](./adr/README.md)
- [Trust Slice Model](./trust-slices.md)
- [ZK Verification Design](./zk-verification.md)
- [Stellar SDK (JS)](https://stellar.github.io/js-stellar-sdk/)
- [Soroban Documentation](https://developers.stellar.org/docs/smart-contracts)
