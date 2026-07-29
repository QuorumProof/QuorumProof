# Formal Verification for Critical Functions

> **Issue #1317** — This document describes the formal verification approach
> applied to QuorumProof's critical functions (credential issuance and
> quorum-slice attestation) using TLA+ and executable Rust invariant tests.

---

## Overview

QuorumProof's correctness guarantees depend on two core subsystems:

1. **Credential issuance** — the rules under which credentials are created,
   deduplicated, and revoked.
2. **Quorum-slice attestation** — the FBA-based threshold logic that decides
   when a credential is considered "attested" by a trust network.

Bugs in either subsystem can allow invalid credentials to be treated as valid
(false acceptance) or valid credentials to be unfairly rejected (false denial).
Both failure modes have real-world consequences for engineering license verification.

We verify these subsystems at two levels:

| Level | Artefact | What it proves |
|---|---|---|
| Abstract model | TLA+ specs (`.tla` files) | All reachable states of the *model* satisfy the invariants |
| Concrete implementation | Rust `formal_verification_invariants.rs` tests | The *actual contract code* upholds each invariant |

The gap between levels is deliberately small: the TLA+ model closely mirrors
the Rust implementation structure and its guards.

---

## TLA+ Specifications

### `CredentialIssuance.tla`

Models the lifecycle of a credential from issuance through revocation.

**State variables:**
- `credentials` — map from credential id → record
- `credential_count` — monotonic counter
- `paused` — contract pause flag
- `pending_issues` — off-chain queue of requests

**Actions modelled:** `SubmitIssueRequest`, `IssueCredential`, `RevokeCredential`,
`PauseContract`, `UnpauseContract`

**Invariants:**

| Name | Statement |
|---|---|
| `TypeInvariant` | All state variables have well-typed values |
| `NoDuplicateActiveCredentials` | No two active (non-revoked) credentials share the same (issuer, subject, type) triple |
| `IssuedBeforeRevoked` | A credential cannot be revoked before it exists |
| `CountConsistency` | `credential_count` equals the number of stored credentials |
| `RevokedIsPermanent` | Once `revoked = TRUE`, it stays `TRUE` (no un-revoke transition) |

**Liveness:**

| Name | Statement |
|---|---|
| `EventualIssuance` | A valid pending request eventually produces a credential (under weak fairness) |

### `QuorumSliceAttestation.tla`

Models the FBA quorum-slice attestation subsystem.

**State variables:**
- `cred_state` — map from credential id → `"Active" | "Revoked" | "Attested"`
- `slices` — map from slice id → members, weights, threshold
- `votes` — (credential × slice × attestor) → boolean
- `challenges` — map from credential id → active challenge flag
- `paused` — contract pause flag

**Actions modelled:** `ConfigureSlice`, `CastVote`, `FinaliseAttestation`,
`RevokeCredential`, `RaiseChallenge`, `ResolveChallenge`, `PauseContract`,
`UnpauseContract`

**Invariants:**

| Name | Statement |
|---|---|
| `TypeInvariant` | All state variables are well-typed |
| `RevokedNotAttested` | A credential in state `"Revoked"` cannot simultaneously be in state `"Attested"` |
| `ThresholdEnforced` | An attested credential must have met the threshold of at least one slice |
| `AttestorInSlice` | Only slice members may cast votes |
| `NoDoubleVotePossible` | Votes are boolean per (credential, slice, attestor) — only one vote per attestor |
| `ChallengeBlocksAttestation` | A credential with an active challenge cannot be in state `"Attested"` |
| `SafetyInvariant` | Conjunction of all the above |

**Liveness:**

| Name | Statement |
|---|---|
| `EventualAttestation` | If threshold is met and no challenge is active, the credential eventually becomes `"Attested"` |

---

## Running TLC (TLA+ Model Checker)

### Prerequisites

- [TLA+ Toolbox](https://github.com/tlaplus/tlaplus/releases) (IDE) or
- [TLC command-line](https://github.com/tlaplus/tlaplus/releases) (`tla2tools.jar`)

### Model setup for `CredentialIssuance.tla`

```
Issuers         ← {Issuer1, Issuer2}
Subjects        ← {Subject1, Subject2}
CredentialTypes ← {1, 2, 3}

Invariants to check:
  TypeInvariant
  NoDuplicateActiveCredentials
  IssuedBeforeRevoked
  CountConsistency

Temporal properties:
  EventualIssuance
```

### Model setup for `QuorumSliceAttestation.tla`

```
Attestors ← {A1, A2, A3}
CredIds   ← {C1, C2}
SliceIds  ← {S1}

Invariants to check:
  SafetyInvariant

Temporal properties:
  EventualAttestation
```

### Command-line invocation

```bash
# From the repo root
java -jar tla2tools.jar -config formal-verification/CredentialIssuance.cfg \
     formal-verification/CredentialIssuance.tla

java -jar tla2tools.jar -config formal-verification/QuorumSliceAttestation.cfg \
     formal-verification/QuorumSliceAttestation.tla
```

**Expected result:** TLC reports `No error has been found` for all invariants.

---

## Rust Invariant Tests

The companion Rust tests in
`contracts/quorum_proof/src/formal_verification_invariants.rs` exercise the
concrete Soroban contract implementation for each TLA+ invariant.

Run them with:

```bash
cargo test -p quorum_proof formal_verification_invariants
```

### Invariant → Test mapping

| TLA+ invariant | Rust test |
|---|---|
| `NoDuplicateActiveCredentials` | `invariant_no_duplicate_active_credentials` |
| (after revocation, re-issue allowed) | `invariant_no_duplicate_after_revocation_re_issue_allowed` |
| `IssuedBeforeRevoked` | `invariant_credential_exists_before_revoked` |
| `CountConsistency` | `invariant_credential_count_consistency` |
| `RevokedIsPermanent` | `invariant_revoked_is_permanent` |
| `RevokedNotAttested` | `invariant_revoked_not_attested` |
| `ThresholdEnforced` | `invariant_threshold_enforced` |
| `AttestorInSlice` | `invariant_attestor_in_slice_only` |
| `NoDoubleVotePossible` | `invariant_no_double_vote` |
| `ChallengeBlocksAttestation` | `invariant_challenge_blocks_new_votes` |
| Cross-subsystem (attested → revoked) | `invariant_attested_then_revoked_still_exists` |
| `EventualAttestation` (L1, 1-step) | `liveness_eventual_attestation_single_step` |
| `EventualAttestation` (L1, N-step) | `liveness_eventual_attestation_multi_step` |

---

## Key Invariants Explained

### RevokedNotAttested

**Why it matters:** If a revoked credential could be attested, a holder whose
credential was revoked (e.g. for fraud) could still pass a `verify_engineer`
check. This is the most safety-critical invariant in the system.

**How it's enforced in Rust:** `attest()` in `lib.rs` checks `is_revoked(id)`
and panics with `ContractError::CredentialNotFound` if the credential is
revoked. The TLA+ model mirrors this with the guard `cred_state[id] = "Active"`
in `CastVote`.

### NoDuplicateActiveCredentials

**Why it matters:** Two active credentials with the same (issuer, subject, type)
would create ambiguity about which one a verifier should trust. Only one active
credential per triple is permitted; a new one can only be issued after the old
one is revoked.

**How it's enforced in Rust:** `issue_credential()` checks for an existing
non-revoked credential with the same key triple via the
`SubjectIssuerType(subject, issuer, type)` storage entry and panics with
`ContractError::DuplicateCredential`.

### ChallengeBlocksAttestation

**Why it matters:** The dispute/challenge mechanism exists so that fraudulently
attested credentials can be contested. If a credential could be attested while a
challenge is active, the challenge window would be meaningless.

**How it's enforced in Rust:** `attest()` checks for an active challenge via
`ActiveChallenge(slice_id, attestor)` storage and panics with
`ContractError::AlreadyChallenged`.

### ThresholdEnforced

**Why it matters:** The entire FBA trust model rests on the guarantee that
attestation requires meeting the declared threshold. A threshold bypass would
let a single (possibly compromised) attestor unilaterally attest any credential.

**How it's enforced in Rust:** `attest()` counts attested attestors weighted by
`get_effective_weight()` and only flips the attested flag once
`weighted_count >= threshold`.

---

## Correspondence Between Model and Implementation

| TLA+ model element | Rust implementation |
|---|---|
| `cred_state[id] = "Active"` | `!is_revoked(id) && credential_exists(id)` |
| `cred_state[id] = "Revoked"` | `is_revoked(id) == true` |
| `cred_state[id] = "Attested"` | `is_attested(id, slice_id) == true` |
| `ThresholdMet(id, sid)` | `weighted_count >= slice.threshold` in `attest()` |
| `challenges[id] = TRUE` | `ActiveChallenge(slice_id, attestor)` key present |
| `votes[id][sid][a] = TRUE` | `Attestors(cred_id)` Vec contains `attestor` |
| `slices[sid].members` | `slice.attestors: Vec<Address>` |
| `slices[sid].threshold` | `slice.threshold: u32` |

---

## Limitations and Future Work

1. **Authentication** — The TLA+ models omit admin/auth checks for brevity.
   A full model would include an `Admins` constant and auth guards on
   `RevokeCredential`, `PauseContract`, etc.

2. **Economic security** — The FBA economic-security model (stake-weighted
   attack cost, Monte Carlo simulation) is not yet formally verified. This is
   tracked as a follow-on to issue #1317.

3. **ZK verification stub** — The `verify_claim` / `zk_verifier` path is a
   non-functional stub (see README warning). Formal verification of ZK proof
   correctness is deferred to issue #ZK-IMPL.

4. **Cross-contract calls** — The TLA+ models treat each contract independently.
   A compositional model covering the
   `quorum_proof → sbt_registry → zk_verifier` call chain is future work.

5. **TLC state explosion** — With the small finite sets used for TLC checking
   (`Attestors ← {A1, A2, A3}`, etc.), TLC exhausts the state space in seconds.
   Larger models may require symmetry reduction or abstraction.
