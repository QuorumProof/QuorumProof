# Quorum Slice Trust Model — Contributor Guide

This guide walks through how QuorumProof's trust model works end-to-end: from the FBA theory that underpins it all the way down to the exact `quorum_proof` contract calls a developer makes. It is intended for contributors who are new to the codebase or to Stellar's Federated Byzantine Agreement (FBA) model.

> **Prerequisites**: Skim [ADR-001: FBA Trust Model](./adr/adr-001-fba-trust-model.md) first. This guide deliberately does not restate the theoretical rationale — ADR-001 covers that. Instead it translates the theory into concrete contract interactions.

---

## Table of Contents

1. [What Is a Quorum Slice?](#1-what-is-a-quorum-slice)
2. [Defining a Slice on-chain](#2-defining-a-slice-on-chain)
3. [Managing Attestors](#3-managing-attestors)
4. [Attesting a Credential](#4-attesting-a-credential)
5. [Checking Attestation Status](#5-checking-attestation-status)
6. [Quorum Intersection — Nested Slices](#6-quorum-intersection--nested-slices)
7. [What Happens When an Attestor Is Removed or a Slice Is Redefined?](#7-what-happens-when-an-attestor-is-removed-or-a-slice-is-redefined)
8. [Sample Slice — ASCII Flow Diagram](#8-sample-slice--ascii-flow-diagram)
9. [Quick-Reference: Key Contract Functions](#9-quick-reference-key-contract-functions)

---

## 1. What Is a Quorum Slice?

In Stellar's FBA model each participant defines its own *quorum slice* — the minimal set of peers whose agreement is sufficient to accept a fact. QuorumProof applies this directly to credential attestation:

- An engineer (the **credential subject**) owns a `credential_id`.
- She defines a **quorum slice** consisting of the institutions she trusts: her university, a national engineering society, and one or more former employers.
- Each member of the slice is an **attestor** — an on-chain `Address` that can co-sign her credential.
- The slice has a **threshold**: the minimum total weight of attestors that must have signed before the credential is considered attested.

For a deeper treatment of *why* FBA is used instead of centralized registries or proof-of-stake, see [ADR-001](./adr/adr-001-fba-trust-model.md).

---

## 2. Defining a Slice On-chain

### `create_slice` — Absolute threshold

```rust
pub fn create_slice(
    env: Env,
    creator: Address,
    attestors: Vec<Address>,
    weights: Vec<u32>,
    threshold: u32,
) -> u64
```

- **`creator`**: The Stellar address defining the slice (must sign the transaction).
- **`attestors`**: Ordered list of attestor addresses.
- **`weights`**: Parallel list of weights — `weights[i]` is the voting power of `attestors[i]`.
- **`threshold`**: Minimum weight sum required for consensus (absolute value).
- **Returns**: A `slice_id` (`u64`) you will use in every subsequent call.

**Example** — an engineer creates a slice where her university (weight 40), engineering society (weight 35), and two employers (weight 15 each) must collectively reach 70 before a credential is considered attested:

```rust
let slice_id = client.create_slice(
    &engineer_addr,
    &vec![&env, university, eng_society, employer_a, employer_b],
    &vec![&env, 40u32, 35u32, 15u32, 15u32],
    &70u32,
);
```

### `create_slice_percentage` — Percentage threshold

```rust
pub fn create_slice_percentage(
    env: Env,
    creator: Address,
    attestors: Vec<Address>,
    weights: Vec<u32>,
    percentage: u32,
) -> u64
```

Identical to `create_slice` but `percentage` is interpreted as `required_weight = ceil(total_weight × percentage / 100)`. Useful when you want "at least 60% of the total stake must sign" semantics.

### Inspecting a slice

```rust
pub fn get_slice(env: Env, slice_id: u64) -> QuorumSlice
```

Returns the full `QuorumSlice` struct — attestors, weights, threshold, creator, and creation timestamp. Panics with `ContractError::SliceNotFound` if the ID does not exist.

---

## 3. Managing Attestors

### `add_attestor` — Extend the trust network

```rust
pub fn add_attestor(
    env: Env,
    creator: Address,
    slice_id: u64,
    attestor: Address,
    weight: u32,
)
```

Only the original `creator` can add attestors (enforced via `require_auth`). Adding an attestor increases the total weight of the slice but does not change the threshold, so existing attestation ratios shift. If the attestor address already exists in the slice the call panics with `ContractError::DuplicateAttestor`.

```rust
// Later: engineer adds a second employer without changing the threshold
client.add_attestor(&engineer_addr, &slice_id, &employer_c, &15u32);
```

> See [ADR-001 § Implementation Notes](./adr/adr-001-fba-trust-model.md#implementation-notes) for a discussion of how weighted attestation generalises to unequal trust across different institution types.

---

## 4. Attesting a Credential

```rust
pub fn attest(
    env: Env,
    attestor: Address,
    credential_id: u64,
    slice_id: u64,
    attestation_value: bool,
    expires_at: Option<u64>,
)
```

- **`attestor`**: The institution address signing off — must be in the slice and must authorise the transaction.
- **`credential_id`**: The SBT credential being attested (issued via `issue_credential`).
- **`slice_id`**: Which quorum slice this attestation is cast under.
- **`attestation_value`**: `true` to affirm the credential, `false` to cast a negative vote.
- **`expires_at`**: Optional Unix timestamp after which this attestation lapses. Pass `None` for a permanent attestation.

```rust
// University attests the engineer's credential under slice 1
client.attest(&university_addr, &credential_id, &slice_id, &true, &None);

// Engineering society attests with an expiry (e.g. licence renewal in 2 years)
let expiry = env.ledger().timestamp() + 63_072_000; // ~2 years
client.attest(&eng_society_addr, &credential_id, &slice_id, &true, &Some(expiry));
```

The contract records:
- Which attestors have voted and their values.
- The cumulative weight of positive attestations.
- The slice that each attestation belongs to (used later for intersection checks).

---

## 5. Checking Attestation Status

### `is_attested`

```rust
pub fn is_attested(env: Env, credential_id: u64, slice_id: u64) -> bool
```

Returns `true` when the running weight sum of positive (non-expired) attestations from slice members meets or exceeds the slice's threshold. This is the primary verification call for verifiers.

```rust
let verified = client.is_attested(&credential_id, &slice_id);
```

For credentials that span **multiple slices** (see §6), `is_attested` automatically verifies that the attestors form a quorum in all applicable slices — not just one. Two disjoint slices independently reaching their own thresholds on conflicting claims will both fail this check because no common set of attestors spans both slices.

---

## 6. Quorum Intersection — Nested Slices

Flat single-level slices are sufficient for most use-cases. However, when a credential is co-attested under two or more independent slices — or when slices themselves reference other slices (nested FBA) — you need to ensure no **partition** exists: a scenario where two sub-networks each independently form quorum on mutually exclusive facts.

For the full rationale and algorithm see [ADR-006: Quorum Intersection Verification](./adr/adr-006-quorum-intersection-verification.md).

### `is_quorum`

```rust
pub fn is_quorum(env: Env, slice_id: u64, candidates: Vec<Address>) -> bool
```

Asks: *"do the addresses in `candidates` form a quorum relative to `slice_id`?"*  
For flat slices this is a simple weight-sum check. For nested slices it recurses through child slices (max depth 4) and requires `candidates` to satisfy **every** child's threshold — strict intersection.

```rust
let attesting_set = vec![&env, university_addr, eng_society_addr];
let forms_quorum = client.is_quorum(&slice_id, &attesting_set);
```

Use `is_quorum` in tests and diagnostic tooling to validate a proposed attestor set before committing attestations.

### `check_quorum_intersection`

```rust
pub fn check_quorum_intersection(
    env: Env,
    slice_ids: Vec<u64>,
    certificate: QuorumIntersectionCertificate,
) -> IntersectionReport
```

Verifies an **off-chain certificate** that a common safe node set exists across all listed slice IDs. The client SDK computes this proof; the contract verifies it efficiently in O(k × d × n) time (well within Soroban's ~20 M CPU budget).

- **`slice_ids`**: All slice IDs you want to verify have a common intersection.
- **`certificate`**: Contains `safe_nodes` — the candidate intersection set — and a `proof_hash`.
- **Returns**: `IntersectionReport { is_safe, common_nodes, partition_count, proof_hash, certificate_version }`.

The result is cached on-chain for one hour to amortise the cost across repeated queries.

```rust
let cert = QuorumIntersectionCertificate {
    slice_ids: vec![&env, slice_a_id, slice_b_id],
    safe_nodes: vec![&env, university_addr, eng_society_addr],
    proof_hash: computed_hash,
    signature: None,
};
let report = client.check_quorum_intersection(
    &vec![&env, slice_a_id, slice_b_id],
    &cert,
);
assert!(report.is_safe);
```

---

## 7. What Happens When an Attestor Is Removed or a Slice Is Redefined?

### Removing an attestor

Removing an attestor reduces the total weight in the slice. If the remaining weight can no longer reach the threshold, any credential that depended on that attestor transitions from `is_attested = true` to `is_attested = false` on the very next verification call. No explicit invalidation event is emitted — verifiers must re-query `is_attested` to get the current state.

### Redefining a slice (adding attestors, changing threshold)

Changes are additive only via `add_attestor`; the threshold is fixed at creation time. If you need a different threshold, deploy a **new slice** via `create_slice` and have attestors re-attest under it. The old slice and its attestations remain on-chain and are not deleted.

### Equivocating attestors (forks)

If the contract detects an attestor casting conflicting votes (e.g., attesting `true` and `false` for the same credential), it emits a `ForkDetected` event, suspends the attestor in the affected slice, and — for nested slices — transitively suspends them in all parent slices via `suspend_attestor_recursive`. This prevents a single corrupt institution from contaminating both levels of a hierarchical trust structure.

See [ADR-006 § Equivocation Handling](./adr/adr-006-quorum-intersection-verification.md#consequences) for the full cascade logic.

---

## 8. Sample Slice — ASCII Flow Diagram

Below is a concrete example of a Brazilian mechanical engineer, Ana, seeking verification by a German employer. Her quorum slice has three attestors. Threshold is 70 out of a total weight of 90.

```
  Ana's Credential (credential_id = 42)
  ├── Slice ID: 7  (threshold: 70 / 90 total weight)
  │
  │   Attestor                    Weight   Status
  │   ─────────────────────────── ──────   ──────
  │   CREA-SP (Brazil Lic. Body)   40      ✅ attested (t=0)
  │   UFMG University              35      ✅ attested (t=1)
  │   Siemens Brazil (employer)    15      ⏳ pending
  │
  │   Running weight: 75 ≥ 70 → is_attested = TRUE
  │
  └── Verification call by German employer
      client.is_attested(42, 7)  →  true ✅


  Co-signing flow (sequence):

  ┌──────────┐   create_slice(creator=Ana, ...)   ┌──────────────┐
  │   Ana    │ ─────────────────────────────────► │  Contract    │
  │ (subject)│ ◄── slice_id = 7 ─────────────────│ quorum_proof │
  └──────────┘                                    └──────┬───────┘
                                                         │
  ┌──────────┐   attest(attestor=CREA, cred=42,          │
  │  CREA-SP │ ──slice=7, value=true) ──────────────────►│ weight: +40
  └──────────┘                                           │
                                                         │
  ┌──────────┐   attest(attestor=UFMG, cred=42,          │
  │   UFMG   │ ──slice=7, value=true) ──────────────────►│ weight: +35
  └──────────┘                                           │ total: 75 ≥ 70
                                                         │
  ┌──────────┐   is_attested(cred=42, slice=7)           │
  │  Employer│ ─────────────────────────────────────────►│
  │ (verifier│ ◄── true ─────────────────────────────────┘
  └──────────┘
```

---

## 9. Quick-Reference: Key Contract Functions

| Function | Purpose | Auth required |
|---|---|---|
| `create_slice(creator, attestors, weights, threshold)` | Define a new quorum slice; returns `slice_id` | Creator |
| `create_slice_percentage(creator, attestors, weights, pct)` | Same with percentage threshold | Creator |
| `get_slice(slice_id)` | Read a slice's current state | None |
| `add_attestor(creator, slice_id, attestor, weight)` | Extend the slice with a new attestor | Creator |
| `attest(attestor, credential_id, slice_id, value, expires_at)` | Cast an attestation for a credential | Attestor |
| `is_attested(credential_id, slice_id)` | Check if threshold is met (primary verification call) | None |
| `is_quorum(slice_id, candidates)` | Test whether a candidate set forms quorum in a slice | None |
| `check_quorum_intersection(slice_ids, certificate)` | Verify off-chain intersection certificate across multiple slices | None |

---

## Further Reading

- [ADR-001: Federated Byzantine Agreement Trust Model](./adr/adr-001-fba-trust-model.md) — theoretical rationale for FBA
- [ADR-006: Quorum Intersection Verification](./adr/adr-006-quorum-intersection-verification.md) — nested slices, off-chain certificate pattern, equivocation handling
- [ADR-008: Economic Security Model](./adr/adr-008-economic-security-model.md) — reputation-tied weighting and cost-of-attack estimation
- [contracts/quorum_proof/API.md](../contracts/quorum_proof/API.md) — full contract API reference
- [docs/trust-slices.md](./trust-slices.md) — broader trust-slice architecture overview
