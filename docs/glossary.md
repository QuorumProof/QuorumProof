# Glossary

Definitions of the project-specific and domain terms used throughout the
QuorumProof documentation (issue #1640). Terms are alphabetical; each entry
links to the doc that covers it in depth.

When you introduce a new term in a doc, add it here and link the first use in
your doc to its entry, e.g. `[quorum slice](./glossary.md#quorum-slice)`.

**Index:**
[A](#a) · [B](#b) · [C](#c) · [D](#d) · [E](#e) · [F](#f) · [G](#g) ·
[I](#i) · [L](#l) · [M](#m) · [N](#n) · [P](#p) · [Q](#q) · [R](#r) ·
[S](#s) · [T](#t) · [U](#u) · [V](#v) · [W](#w) · [Z](#z)

---

## A

### Admin
The Stellar address stored at contract initialization that is allowed to
perform privileged operations: pausing, upgrading, migrating state and
managing the circuit breaker. See
[ADR-014](./adr/adr-014-admin-circuit-breaker-and-rate-limiting.md).

### API version
The version segment of a REST path (`/api/v1/...`, `/api/v2/...`). v1 is in
maintenance and sunsets on 2027-03-01; v2 is GA. Unversioned `/api/...`
paths behave as v1. See [Migration guides](./migration-guides.md#api-v1--v2).

### Attestation
A signed statement by an [attestor](#attestor) that a
[credential](#credential) is genuine. A credential becomes *attested* once
the attestations collected meet its [quorum slice](#quorum-slice)'s
[threshold](#threshold). See [sbt-lifecycle.md](./sbt-lifecycle.md#stage-2--quorum-co-signing-quorum_proof).

### Attestor
A trusted institution — university, licensing body, employer — that is a
member of a quorum slice and can attest credentials. Each attestor has a
[weight](#weight) in the slice. See
[ADR-009](./adr/adr-009-attestor-independence.md).

---

## B

### BBS+
A pairing-based signature scheme that lets a holder reveal a chosen subset of
signed fields ([selective disclosure](#selective-disclosure)) without
revealing the rest. See [bbs-plus-tutorial.md](./bbs-plus-tutorial.md).

### Batch verification
Verifying many `(credential_id, claim_type)` pairs in one
`POST /api/verify/batch` request. Duplicate pairs are resolved once. See
[api-response-examples.md](./api-response-examples.md#post-apiverifybatch).

### BLS12-381
The pairing-friendly elliptic curve used by the Groth16, PLONK and BBS+
verifiers.

---

## C

### Circuit breaker
An admin-controlled switch that pauses state-changing contract calls during
an incident. Upgrades are blocked while the contract is paused. See
[ADR-014](./adr/adr-014-admin-circuit-breaker-and-rate-limiting.md).

### Claim / claim type
A specific statement a holder proves about a credential — for example
`HasDegree` or `HasLicense` — without necessarily revealing the credential
itself. See [claim-types.md](./claim-types.md).

### Credential
An on-chain record in the `quorum_proof` contract binding an
[issuer](#issuer), a [subject](#subject), a
[credential type](#credential-type) and a [metadata hash](#metadata-hash).
Identified by a numeric `credential_id`.

### Credential type
The kind of credential (degree, professional license, employment record…),
stored as a `u32`. See [credential-types.md](./credential-types.md).

### Crypto-shredding
Erasing personal data by destroying the key it was encrypted with, so the
ciphertext left behind is useless. Used for GDPR erasure of off-chain data.
See [crypto-shredding-architecture.md](./crypto-shredding-architecture.md).

---

## D

### Deprecation / Sunset headers
HTTP response headers added to requests on a maintenance-mode API version.
`Sunset` carries the date after which the version returns `410 Gone`.

### Digest
A 16-hex-character correlation id in batch verification results. It is **not**
a security primitive.

---

## E

### Expiry
The optional `expires_at` timestamp after which a credential no longer
verifies, even if it was never revoked. See
[sbt-lifecycle.md](./sbt-lifecycle.md#stage-6--expiry).

---

## F

### FBA (Federated Byzantine Agreement)
The consensus model underlying Stellar, in which each participant chooses
whom it trusts rather than relying on a global membership list. QuorumProof
applies it to credential trust: each holder picks their own
[quorum slice](#quorum-slice). See
[ADR-001](./adr/adr-001-fba-trust-model.md).

---

## G

### Groth16
A zk-SNARK proof system with small, constant-size proofs, verified on-chain
by `verify_groth16_proof`. See [groth16-migration.md](./groth16-migration.md).

---

## I

### Issuer
The address that created a credential (typically an institution). Only the
issuer or admin can revoke it.

---

## L

### Ledger
One closed block of the Stellar network. Contract storage lifetimes
([TTL](#ttl)) are measured in ledgers.

---

## M

### Metadata hash
A 32-byte hash of the credential's off-chain metadata document. The document
itself is never stored on-chain; see [privacy-guide.md](./privacy-guide.md).
Named `metadata` in API v1 and `metadata_hash` in v2.

### Metadata schema version
The version of the *format* of a credential's metadata bytes, tracked per
credential. Independent from [state version](#state-version). See
[METADATA_SCHEMA_VERSIONING_PLAN.md](./METADATA_SCHEMA_VERSIONING_PLAN.md).

### Migration job
A resumable, chunked on-chain data migration driven by repeated
`migrate_next_chunk` calls. A completed job is a permanent no-op. See
[migration-invariants.md](./migration-invariants.md).

---

## N

### Nonce (proof request)
A single-use value in a `ProofRequest` that binds an off-chain proof to one
verification request, preventing replay.

---

## P

### PLONK
A universal-setup zk-SNARK proof system, verified on-chain by
`verify_plonk_proof`. See [plonk-verification.md](./plonk-verification.md).

### Problem Details
The RFC 9457 JSON error format (`type`, `title`, `status`, `detail`) used by
API v2 errors.

---

## Q

### Quorum
The set of attestations that together satisfy a slice's
[threshold](#threshold).

### Quorum intersection
The property that any two quorums share at least one honest member, which
prevents two conflicting outcomes from both being accepted. See
[ADR-006](./adr/adr-006-quorum-intersection-verification.md).

### Quorum slice
A holder-defined set of [attestors](#attestor) plus a
[threshold](#threshold). A credential is verified when enough of the slice
has attested it. See [quorum-slice-guide.md](./quorum-slice-guide.md).

---

## R

### Revocation
Permanently invalidating a credential. Revoked credentials fail verification
and cannot have new [SBTs](#sbt-soulbound-token) minted for them. See
[sbt-lifecycle.md](./sbt-lifecycle.md#revocation).

### Rollback
Returning to the previous contract WASM, database schema or API version after
a failed upgrade. See [migration-guides.md](./migration-guides.md#rollback-procedures).

---

## S

### SBT (Soulbound Token)
A non-transferable token in the `sbt_registry` contract that ties a
credential to its holder's Stellar address. See
[ADR-002](./adr/adr-002-sbt-non-transferability.md) and
[sbt-lifecycle.md](./sbt-lifecycle.md).

### Selective disclosure
Revealing only chosen fields of a credential to a verifier. See
[BBS+](#bbs).

### Simulation
Executing a contract call against current ledger state without submitting a
transaction. The API server serves reads this way. See
[ADR-015](./adr/adr-015-read-only-api-server-via-simulation.md).

### Soroban
Stellar's smart-contract platform. All three QuorumProof contracts are
Soroban contracts written in Rust. See [ADR-004](./adr/adr-004-soroban-platform.md).

### State version
The contract-level storage-layout version (`DataKey::StateVersion`), advanced
one step at a time by `migrate_state`. See
[ADR-011](./adr/adr-011-state-versioning-and-upgrades.md).

### Subject
The address a credential is about — the engineer who holds it.

### Suspension
Temporarily disabling a credential; unlike [revocation](#revocation) it can
be lifted.

---

## T

### Threshold
The minimum total [weight](#weight) of attestations a quorum slice needs for a
credential to count as attested.

### TTL (time to live)
How many [ledgers](#ledger) a Soroban storage entry lives before it must be
extended. See [ADR-013](./adr/adr-013-instance-storage-and-ttl.md).

---

## U

### Upgrade
Replacing a deployed contract's WASM with a new build via `upgrade(admin,
new_wasm_hash)`, keeping its address and storage. See
[contract-upgrade-guide.md](./contract-upgrade-guide.md).

---

## V

### Verifier
Any party — typically an employer — checking a credential or claim. Verifiers
need no special role; verification reads are public.

---

## W

### Weight
An attestor's voting power within a slice, from 1 to 100. See
[weighted-voting.md](./weighted-voting.md).

---

## Z

### ZK proof (zero-knowledge proof)
A proof that a statement is true — e.g. "this holder has an engineering
degree" — that reveals nothing beyond the statement itself. See
[zk-verification-developer-guide.md](./zk-verification-developer-guide.md).

---

See also: [FAQ](./faq.md) · [Documentation index](./README.md)
