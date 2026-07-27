# Integration Patterns Guide

Third-party developers integrating with QuorumProof generally build one of
three kinds of application: an **issuer** service that mints credentials, a
**verifier** service that checks a credential before granting access to
something, or an **auditor** service that reviews credential and dispute
history without ever mutating state. This guide documents the recommended
integration pattern for each role, with runnable code examples, how to
handle errors and retries, and a troubleshooting section for the failures
integrators hit most often.

It complements two existing references rather than replacing them:
- [SDK Methods Reference](sdk-methods-reference.md) — full method signatures
- [API Client Guide](api-client-guide.md) — auth model and contract addresses

---

## Table of Contents

1. [Issuer Pattern](#1-issuer-pattern)
2. [Verifier Pattern](#2-verifier-pattern)
3. [Auditor Pattern](#3-auditor-pattern)
4. [Error Handling & Retries](#4-error-handling--retries)
5. [Troubleshooting](#5-troubleshooting)

---

## 1. Issuer Pattern

An issuer integration issues credentials on behalf of an institution
(university, licensing board, employer). It holds the issuer's signing key
(or delegates signing to a custody provider) and calls state-mutating
contract methods.

### Recommended shape

```
Issuer backend
  │
  ├─ Idempotency store (subject, credential_type) → credential_id
  │     Prevents re-issuing the same credential on retry
  │
  ├─ issue_credential() ──> Soroban RPC ──> quorum_proof contract
  │
  └─ Event listener (CredentialIssued) ──> update internal system of record
```

The idempotency store matters because `issue_credential` fails with
`DuplicateCredential` (`#4`) on a retried duplicate call — that failure
should be treated as *success* by the caller, not surfaced as an error (see
[§4](#4-error-handling--retries)).

### Example (TypeScript)

```typescript
import { Contract, SorobanRpc, TransactionBuilder, Keypair } from "@stellar/stellar-sdk";

async function issueCredential(
  issuerKeypair: Keypair,
  subject: string,
  credentialType: number,
  metadataHash: Buffer,
): Promise<bigint> {
  const server = new SorobanRpc.Server(process.env.SOROBAN_RPC_URL!);
  const contract = new Contract(process.env.CONTRACT_QUORUM_PROOF!);

  const account = await server.getAccount(issuerKeypair.publicKey());
  const tx = new TransactionBuilder(account, { fee: "1000000", networkPassphrase: process.env.NETWORK_PASSPHRASE! })
    .addOperation(
      contract.call(
        "issue_credential",
        issuerKeypair.publicKey(),
        subject,
        credentialType,
        metadataHash,
      ),
    )
    .setTimeout(30)
    .build();

  const prepared = await server.prepareTransaction(tx);
  prepared.sign(issuerKeypair);

  const result = await server.sendTransaction(prepared);
  return await pollForCredentialId(server, result.hash);
}
```

### Example (Rust, via soroban-client)

```rust
let credential_id = client
    .issue_credential(&issuer, &subject, &credential_type, &metadata_hash, &None, &0u64)
    .await?;
```

### Key practices

- Store the returned `credential_id` immediately; it is the only handle for
  future `revoke_credential` / `suspend_credential` calls.
- Subscribe to `CredentialIssued` events (see
  [Audit Log Format](audit-log-format.md)) rather than polling, to keep the
  system of record in sync with chain state.
- Never let end users hold or see the issuer's signing key — proxy all
  calls through the backend. See the
  [Issuer Security Checklist](issuer-security-checklist.md) for key
  management requirements.

---

## 2. Verifier Pattern

A verifier integration checks whether a subject holds a valid credential
before granting access to a resource (a job application portal, a
regulated service, a physical access system). Verifiers only make
read-only calls — they never sign transactions on behalf of the subject.

### Recommended shape

```
Verifier backend
  │
  ├─ get_credential(credential_id)         ── fetch the claim
  ├─ is_attested(credential_id, slice_id)  ── confirm quorum was reached
  ├─ is_revoked / is_suspended              ── confirm still valid
  └─ decision: allow / deny
```

Always check attestation *and* revocation/suspension status — a credential
can be issued but not yet attested, or attested but later revoked. Checking
only one leads to false positives.

### Example (TypeScript)

```typescript
async function verifyCredential(credentialId: bigint, sliceId: bigint): Promise<boolean> {
  const contract = new Contract(process.env.CONTRACT_QUORUM_PROOF!);
  const server = new SorobanRpc.Server(process.env.SOROBAN_RPC_URL!);

  const credential = await simulateRead(server, contract, "get_credential", credentialId);
  if (!credential) return false;
  if (credential.revoked || credential.suspended) return false;

  const attested = await simulateRead(server, contract, "is_attested", credentialId, sliceId);
  return Boolean(attested);
}
```

### Example (Python)

```python
def verify_credential(client, credential_id: int, slice_id: int) -> bool:
    credential = client.get_credential(credential_id)
    if credential is None or credential["revoked"] or credential["suspended"]:
        return False
    return client.is_attested(credential_id, slice_id)
```

### Key practices

- Read calls are free simulations — there is no reason to cache
  aggressively, but do cache within a single request lifecycle to avoid
  redundant RPC round trips (e.g. one `get_credential` call feeding both a
  revocation check and a display step).
- Treat `CredentialNotFound` (`#1`) from a read call as "not a valid
  credential," not as an error to alert on — it is an expected outcome when
  verifying user-supplied IDs.
- For ZK-based claims (proving an attribute without revealing the full
  credential), see [ZK API Reference](zk-api-reference.md) instead of the
  plain `get_credential` flow above.

---

## 3. Auditor Pattern

An auditor integration reviews the full history of credentials, disputes,
and attestation events for compliance, reporting, or investigation. It
never issues, attests, or revokes — it only reads and aggregates.

### Recommended shape

```
Auditor backend
  │
  ├─ Event indexer ── subscribes to all contract events (see audit-log-format.md)
  │     └─> writes to an append-only local store (Postgres, BigQuery, etc.)
  │
  ├─ Reconciliation job ── periodically compares indexed counts against
  │     get_credential_count() / get_slice_count() on-chain
  │
  └─ Reporting layer ── queries the local store, never the chain directly,
        for anything beyond point lookups
```

Building a local index is the right pattern for auditors specifically
because compliance queries ("all credentials issued by issuer X in Q1")
are not exposed as contract methods and would require scanning every
credential ID on-chain otherwise.

### Example (TypeScript event indexer)

```typescript
async function indexEvents(server: SorobanRpc.Server, contractId: string, fromLedger: number) {
  const events = await server.getEvents({
    startLedger: fromLedger,
    filters: [{ type: "contract", contractIds: [contractId] }],
  });

  for (const event of events.events) {
    await store.append({
      ledger: event.ledger,
      topic: event.topic,
      value: event.value,
      txHash: event.txHash,
    });
  }

  return events.latestLedger;
}
```

### Key practices

- Reconcile your index against `create_state_snapshot` /
  `get_snapshot` on-chain counters periodically — a mismatch usually means
  the indexer missed an event, not that the contract is wrong. See
  [Backup System — On-Chain State Snapshots](backup-system.md#on-chain-state-snapshots).
- Never expose write credentials to the auditor service; it should hold no
  signing key at all, only an RPC endpoint.
- For dispute history specifically, cross-reference
  [Dispute Resolution Threat Model](threat-model.md#4-dispute-resolution-threat-model).

---

## 4. Error Handling & Retries

All three patterns share the same error-handling contract because they all
talk to Soroban RPC over the network.

### Classifying failures

| Failure class | Example | Retry? |
|---|---|---|
| Network/transient | RPC timeout, `503`, connection reset | Yes, with backoff |
| Simulation/preflight error | Insufficient resource fee, expired ledger footprint | Yes, rebuild and resubmit |
| Contract error (`Error(Contract, #N)`) | `DuplicateCredential`, `CredentialNotFound` | Usually no — it's a logic error, not a transient one |
| Auth error | Missing signature, wrong signer | No — fix the caller, don't retry |

Full per-code recovery guidance lives in
[Error Code Reference](error-codes.md); this section covers the *retry
strategy* around those codes, not the codes themselves.

### Retry pattern (exponential backoff with jitter)

```typescript
async function withRetry<T>(fn: () => Promise<T>, maxAttempts = 5): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (!isRetryable(err) || attempt === maxAttempts - 1) throw err;
      const delayMs = Math.min(1000 * 2 ** attempt, 15_000) + Math.random() * 250;
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  throw lastError;
}

function isRetryable(err: unknown): boolean {
  const message = String((err as Error)?.message ?? err);
  // Network-level and preflight failures are retryable; contract panics
  // (Error(Contract, #N)) and auth failures are not.
  return !/Error\(Contract, #\d+\)/.test(message) && !/auth/i.test(message);
}
```

### Idempotency for issuers

Because `issue_credential` is not naturally idempotent across retries (a
second call for the same subject+type raises `DuplicateCredential`, `#4`),
wrap it so a retry after a network failure resolves correctly:

```typescript
async function issueIdempotent(subject: string, credentialType: number, metadataHash: Buffer) {
  try {
    return await withRetry(() => issueCredential(issuerKeypair, subject, credentialType, metadataHash));
  } catch (err) {
    if (/Error\(Contract, #4\)/.test(String(err))) {
      // Already issued by a previous attempt — look up the existing ID instead of failing.
      return await findExistingCredentialId(subject, credentialType);
    }
    throw err;
  }
}
```

---

## 5. Troubleshooting

This section covers integration-specific failures. For end-user-facing
error diagnosis (decision tree, log interpretation), see the
[Troubleshooting Guide](troubleshooting-guide.md).

| Symptom | Likely cause | Fix |
|---|---|---|
| `issue_credential` succeeds on-chain but the app never sees the ID | Polling for the transaction result stopped too early, or the RPC node served a stale ledger | Poll `getTransaction` until status is `SUCCESS` or `FAILED`, not just `sendTransaction`'s immediate response |
| Every call fails with an auth error | The keypair used to sign doesn't match the address passed as `issuer`/`admin` | Confirm `require_auth()` target matches the signing key; check for a stale cached keypair |
| Reads return stale data right after a write | Reading from a different RPC node than the one that processed the write, before it propagated | Read from the same RPC endpoint, or add a short delay / poll `get_credential_count` for the expected increment |
| `DuplicateCredential` on what looks like a first attempt | A prior request succeeded but the client crashed/timed out before recording the result | Look up by `(subject, credential_type)` before treating this as a real error — see idempotency pattern above |
| Verifier always returns "not attested" for a credential you know was attested | Checking the wrong `slice_id` — a credential can be associated with multiple slices | Confirm the `slice_id` used at attestation time, not an assumed default |
| Auditor's local index count drifts from on-chain count | Missed events due to an indexer restart without resuming from the last processed ledger | Persist `latestLedger` after each batch and resume from it, not from "now" |
| WASM/contract calls fail after a contract upgrade | Client SDK bindings are generated from an older contract spec | Regenerate bindings from the current `.wasm`; see [Contract Upgrade Guide](contract-upgrade-guide.md) |

If none of these match, capture the full `Error(Contract, #N)` code and the
transaction hash, then check [Error Code Reference](error-codes.md) and
[Troubleshooting Guide](troubleshooting-guide.md#decision-tree) before
opening a support request.
