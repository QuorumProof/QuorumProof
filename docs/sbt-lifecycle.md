# SBT Lifecycle — End-to-End Guide

This document describes the complete lifecycle of a Soulbound Token (SBT) in
QuorumProof: from quorum co-signing through minting, active use, suspension or
revocation, and burn. It maps each lifecycle stage to the relevant
`sbt_registry` and `quorum_proof` contract functions so contributors and
integrators have a single reference rather than having to reconstruct the flow
from contract code and scattered docs.

---

## Related documents

- [SBT Possession & Privacy](./sbt-possession-privacy.md) — possession
  commitments, privacy guarantees, and the `create_sbt_possession_commitment` /
  `verify_sbt_commitment` API.
- [Credential Types](./credential-types.md) — credential type hierarchy, on-chain
  registration, and the numeric ranges used in `issue_credential`.
- [ADR-002 — SBT Non-Transferability](./adr/adr-002-sbt-non-transferability.md) —
  the design rationale for why `transfer()` always panics.

---

## State diagram

```
                         ┌───────────────────────────────┐
                         │          credential            │
                         │  issue_credential() in         │
                         │  quorum_proof                  │
                         └──────────────┬────────────────┘
                                        │
                                        ▼
                             ┌──────────────────┐
                             │  CREDENTIAL ISSUED│  (on quorum_proof)
                             └────────┬─────────┘
                                      │  quorum co-signing
                                      │  attest() reaches threshold
                                      ▼
                           ┌────────────────────┐
                           │  CREDENTIAL ATTESTED│
                           └─────────┬──────────┘
                                     │  holder calls mint()
                                     │  on sbt_registry
                                     ▼
                          ┌──────────────────────┐
                          │       ACTIVE (SBT)    │◄──────────────────────┐
                          └──┬──────────┬─────────┘                       │
                             │          │                                  │
               suspend_      │          │ expires_at                       │ renew_credential()
               credential()  │          │ approaches                       │ (issuer)
                             ▼          ▼                                  │
                    ┌────────────┐  ┌───────────────┐                     │
                    │ SUSPENDED  │  │ EXPIRING SOON │─────────────────────┘
                    └──────┬─────┘  └──────┬────────┘
                           │               │ expires_at passes
                           │               ▼
                           │        ┌────────────┐
                           │        │   EXPIRED   │
                           │        └──────┬──────┘
                           │               │
                           │   revoke_credential() (issuer)
                           ▼               ▼
                    ┌───────────────────────────┐
                    │         REVOKED            │  (terminal — cannot be un-revoked)
                    └───────────────────────────┘
                                    │
                                    │ holder calls burn() / burn_sbt()
                                    ▼
                           ┌─────────────────┐
                           │     BURNED       │  (SBT removed from chain)
                           └─────────────────┘
```

> **Note:** Suspension is **not** a terminal state. The issuer can revoke a
> suspended credential; the holder cannot reactivate it independently. There is
> currently no `unsuspend_credential` function — reinstatement requires the
> issuer to revoke-and-reissue. See the [Suspension](#suspendrevoke) section.

---

## Stage 1 — Credential issuance (quorum_proof)

Before any SBT can exist there must be a `Credential` in the `quorum_proof`
contract.

### Function

```rust
// contract: quorum_proof
issue_credential(
    env: Env,
    issuer: Address,       // must authorize
    subject: Address,      // the engineer
    credential_type: u32,  // see docs/credential-types.md
    metadata_hash: Bytes,  // SHA-256 or IPFS CID
    expires_at: Option<u64>, // Unix timestamp; None = no expiry
    nonce: u64,            // anti-replay proof-of-work nonce
) -> u64  // returns credential_id
```

The call:
1. Requires the issuer's authorization.
2. Enforces rate limits, quota, and a lightweight proof-of-work check.
3. Stores a `Credential` struct with `revoked: false`, `suspended: false`,
   `status: CredentialStatus::Active`.
4. Returns a monotonic `credential_id`.

### What happens on-chain

- A `Credential` record is written to persistent storage keyed by
  `DataKey::Credential(credential_id)`.
- The credential is indexed under the subject's address
  (`SubjectCredentialIndex`).

---

## Stage 2 — Quorum co-signing (quorum_proof)

The issuer's credential is not yet considered valid for SBT minting until the
configured quorum slice has co-signed it.

### Functions

```rust
// contract: quorum_proof

// Create a quorum slice (once per credential type / use case)
create_slice(
    env: Env,
    creator: Address,
    attestors: Vec<Address>,
    weights: Vec<u32>,
    threshold: u32,
) -> u64  // returns slice_id

// Each attestor calls this
attest(
    env: Env,
    attestor: Address,
    credential_id: u64,
    slice_id: u64,
    value: bool,
    metadata: Option<Bytes>,
)

// Read-only check (no transaction required)
is_attested(env: Env, credential_id: u64, slice_id: u64) -> bool
is_attested_by_count(env: Env, credential_id: u64) -> bool
```

Once the sum of attestor weights for a slice meets or exceeds `threshold`,
`is_attested` returns `true` and the holder may mint.

---

## Stage 3 — Minting (sbt_registry)

The credential holder calls `mint` on the `sbt_registry` contract. The
registry performs a cross-contract call to `quorum_proof.is_revoked` before
minting (with a 1-hour ledger cache, ~720 ledgers at 5 s/ledger).

### Function

```rust
// contract: sbt_registry
mint(
    env: Env,
    owner: Address,      // holder; must authorize
    credential_id: u64,  // must exist and not be revoked in quorum_proof
    metadata_uri: Bytes, // IPFS URI, max 256 bytes, must begin with "ipfs://"
) -> u64  // returns token_id
```

Preconditions enforced:
- `owner` is not on the admin blacklist.
- No SBT already exists for this `(owner, credential_id)` pair.
- If a whitelist exists for `credential_id`, `owner` must be on it.
- The credential must not be revoked in `quorum_proof` (checked via cache then
  cross-contract call).

A `SoulboundToken` struct is stored in persistent storage with:

```rust
SoulboundToken {
    id: u64,
    owner: Address,
    credential_id: u64,
    metadata_uri: Bytes,  // stored separately under CompressedMetadata(token_id)
    version: u32,         // starts at 1; incremented on metadata updates
    upgraded_to: None,
    co_owner: None,
}
```

---

## Stage 4 — Active: querying and verification

Once minted, the SBT can be queried by anyone. These are read-only simulations
— no transaction or XLM needed.

### Functions

```rust
// contract: sbt_registry

// Fetch the full SoulboundToken struct
get_token(env: Env, token_id: u64) -> SoulboundToken

// Get the address that owns a token
owner_of(env: Env, token_id: u64) -> Address

// All token IDs for a given holder
get_tokens_by_owner(env: Env, owner: Address) -> Vec<u64>

// Alias for get_tokens_by_owner
get_sbt_by_owner(env: Env, owner: Address) -> Vec<u64>

// Total SBTs minted across all holders
sbt_count(env: Env) -> u64

// contract: quorum_proof

// Current expiry / renewal status
get_credential_status(env: Env, credential_id: u64) -> CredentialStatus
// Returns: Active | ExpiringSoon | Expired

// Whether the underlying credential has been revoked
is_revoked(env: Env, credential_id: u64) -> bool

// Whether the underlying credential has been suspended
is_suspended(env: Env, credential_id: u64) -> bool

// Whether the underlying credential has passed its expiry timestamp
is_expired(env: Env, credential_id: u64) -> bool
```

### Privacy-preserving verification

If the holder wants a verifier to confirm SBT possession **without** revealing
their address, they use the possession-commitment scheme described in
[docs/sbt-possession-privacy.md](./sbt-possession-privacy.md):

```rust
// contract: sbt_registry

// Holder creates a commitment (on-chain, requires holder auth)
create_sbt_possession_commitment(env, holder, sbt_id) -> Bytes  // returns commitment

// Verifier checks the proof off-chain (no address input, no transaction)
verify_sbt_commitment(env, commitment, proof) -> bool
assert_sbt_commitment(env, commitment, proof)  // panics on failure
```

---

## Stage 5 — Suspend / Revoke

SBT status is driven by the state of the underlying `Credential` in
`quorum_proof`. The SBT contract itself has no separate suspend/revoke
mechanism — it re-checks `is_revoked` on every `mint` call and caches the
result.

### Suspension

```rust
// contract: quorum_proof
suspend_credential(
    env: Env,
    issuer: Address,           // must be original issuer; must authorize
    credential_id: u64,
    reason: Option<Bytes>,     // stored on-chain; None is valid
)
```

- Only the original issuer may suspend.
- Cannot suspend an already-revoked credential.
- Cannot suspend an expired credential.
- Sets `credential.suspended = true`.
- Emits a `suspension` event and invalidates cached verification results.

**Suspension is not reversible via a dedicated function.** There is no
`unsuspend_credential` in the current contract. Reinstatement requires the
issuer to revoke the suspended credential and issue a new one.

### Revocation

```rust
// contract: quorum_proof
revoke_credential(
    env: Env,
    issuer: Address,       // must be original issuer; must authorize
    credential_id: u64,
    reason: Option<String>,
)
```

- Only the original issuer may revoke (or a registered revocation agent).
- Cannot revoke an already-revoked credential.
- Revocation is **permanent** — there is no un-revoke function.
- Sets `credential.revoked = true`, invalidates verification caches.
- After revocation, existing SBTs are implicitly invalid: `is_revoked` returns
  `true`, and `mint` will refuse to create a new SBT for the same credential.

To recover from a wrongful revocation, the issuer must issue a new credential
and the holder must mint a new SBT.

---

## Stage 6 — Expiry

Credentials may be issued with an optional `expires_at` Unix timestamp. The
`quorum_proof` contract tracks three expiry-related states:

| `CredentialStatus` | Condition |
|--------------------|-----------|
| `Active`           | No expiry set, or `now < expires_at` and outside renewal window |
| `ExpiringSoon`     | `now` is within the issuer's configured `renewal_window_secs` |
| `Expired`          | `now >= expires_at` |

### Relevant functions

```rust
// contract: quorum_proof

get_credential_status(env, credential_id) -> CredentialStatus
is_expired(env, credential_id) -> bool
check_renewal_eligibility(env, credential_id) -> bool

// Issuer extends the expiry date
renew_credential(
    env: Env,
    issuer: Address,
    credential_id: u64,
    new_expires_at: u64,   // must be in the future
)
```

Expiry does **not** automatically revoke the credential or burn the SBT — the
on-chain record persists. Expired credentials return `is_expired: true`, which
verifiers should treat as invalid. The issuer can call `renew_credential` to
extend `expires_at` before the deadline (or within a grace period via
`renew_credential_with_grace`).

---

## Stage 7 — Burn (holder self-removal)

The holder can voluntarily remove their SBT from the registry using one of two
burn functions:

```rust
// contract: sbt_registry

// Simple burn — holder auth only
burn(env: Env, owner: Address, token_id: u64) -> u64  // returns credential_id

// Extended burn — requires a non-empty proof_of_residency
burn_sbt(env: Env, holder: Address, sbt_id: u64, proof_of_residency: Bytes)
```

Both:
- Require the holder to authorize.
- Remove `Token`, `Owner`, `OwnerTokens`, `Delegation`, and `OwnerCredential`
  entries from storage.
- Emit a `burn` event and write notification / activity-log entries.

Burning the SBT does **not** revoke the underlying credential in `quorum_proof`.
If the credential remains active, the holder could mint a new SBT for the same
credential.

---

## Employer / verifier query flow

A typical verification check a hiring firm would run:

```
1. Get the holder's token IDs:
     sbt_registry.get_tokens_by_owner(holder_address) -> [token_id, ...]

2. For each token_id, fetch the token:
     sbt_registry.get_token(token_id) -> SoulboundToken { credential_id, ... }

3. Check credential validity:
     quorum_proof.is_revoked(credential_id)   -> false  ✓
     quorum_proof.is_suspended(credential_id) -> false  ✓
     quorum_proof.is_expired(credential_id)   -> false  ✓
     quorum_proof.is_attested(credential_id, slice_id) -> true  ✓

4. Optionally verify a privacy-preserving proof (if the holder provided one
   out-of-band instead of revealing their address):
     sbt_registry.verify_sbt_commitment(commitment, proof) -> true  ✓
```

For a full integration example with code in TypeScript, Python, and Rust, see
[docs/api-client-guide.md — SBT Operations](./api-client-guide.md#sbt-operations).

---

## Function quick-reference

| Stage | Contract | Function |
|-------|----------|----------|
| Issue credential | `quorum_proof` | `issue_credential` |
| Create quorum slice | `quorum_proof` | `create_slice` |
| Co-sign credential | `quorum_proof` | `attest` |
| Mint SBT | `sbt_registry` | `mint` |
| Query token | `sbt_registry` | `get_token`, `owner_of`, `get_tokens_by_owner` |
| Check attestation | `quorum_proof` | `is_attested`, `is_attested_by_count` |
| Check revoked | `quorum_proof` | `is_revoked` |
| Check suspended | `quorum_proof` | `is_suspended` |
| Check expired | `quorum_proof` | `is_expired`, `get_credential_status` |
| Suspend credential | `quorum_proof` | `suspend_credential` |
| Revoke credential | `quorum_proof` | `revoke_credential` |
| Renew credential | `quorum_proof` | `renew_credential` |
| Privacy-proof possession | `sbt_registry` | `create_sbt_possession_commitment`, `verify_sbt_commitment` |
| Burn SBT | `sbt_registry` | `burn`, `burn_sbt` |
| Recover SBT (wallet loss) | `sbt_registry` | `recover_sbt` (guardian-approved) |
