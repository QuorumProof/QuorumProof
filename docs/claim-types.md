# Claim Type Registry

## Overview

A **claim type** is the specific assertion a zero-knowledge proof makes about
a credential — e.g. "this credential holder has a degree" — without revealing
the credential's underlying metadata. This is distinct from the
[credential type registry](credential-types.md), which classifies what a
*credential itself* is (a degree, a license, an employment record). A single
credential type is typically proved against one or more claim types.

Claim types are consumed by `generate_proof_request` /
`generate_anonymous_proof_request` and `verify_claim` in
`contracts/zk_verifier`, and mirrored in `contracts/quorum_proof` so the two
contracts can pass the same value across the contract boundary (see the
`#[repr(u32)]` note in `contracts/zk_verifier/src/lib.rs` — the two enums
must stay byte-identical or cross-contract calls fail with a
`ConversionError`).

This document defines the canonical, standardized set of claim types, the
proof circuit design behind each, the registry's versioning strategy, and
the process for proposing a new one.

## Canonical Claim Types

`ClaimType` is a fixed, `#[repr(u32)]` enum — **not** an arbitrary string —
defined identically in `contracts/quorum_proof/src/lib.rs` and
`contracts/zk_verifier/src/lib.rs`:

| Variant | Discriminant | Domain-separation index | Status |
|---|---|---|---|
| `HasDegree` | 1 | 0 | Standard |
| `HasLicense` | 2 | 1 | Standard |
| `HasEmploymentHistory` | 3 | 2 | Standard |
| `HasCertification` | 4 | 3 | Standard |
| `HasResearchPublication` | 5 | 4 | Standard |

The "domain-separation index" is the value each claim type maps to
internally (`ClaimType::HasDegree => 0u8`, etc. in `zk_verifier::lib.rs`) and
is mixed into the Fiat-Shamir transcript / public-input encoding so a proof
generated for one claim type cannot be replayed as valid for another. See
[ZK Proof Scheme Specification](zk-proof-scheme-specification.md) and
[PLONK Verification](plonk-verification.md) for the full transcript
construction.

> **Note on scope vs. the original proposal**: this issue's brief called for
> `has_degree`, `has_license`, `experience_years`, and
> `employer_verification`. Two of those (`HasDegree`, `HasLicense`) already
> exist as-is. `experience_years` and `employer_verification` do not exist
> as separate variants today — the closest existing type is
> `HasEmploymentHistory`, which proves *that* an employment credential
> exists and is valid, not a minimum-years threshold or a specific-employer
> match. Adding either as a true standard type requires a new circuit (see
> [Custom / Proposed Claim Types](#custom--proposed-claim-types) below) and
> is not implemented in this change — this document defines the process so
> that work can proceed as its own scoped task.

## Proof Circuit Design Per Claim Type

All standard claim types share one circuit *shape* — a membership /
validity proof over a committed credential — differing only in which fields
of the credential's metadata commitment are constrained. `verify_claim`
takes `(admin, quorum_proof_contract, credential_id, claim_type, proof)`;
`claim_type` selects the constraint set applied to `proof` against the
on-chain credential commitment. See
[ZK API Reference](zk-api-reference.md) for the full parameter reference and
[Groth16 → PLONK Migration](groth16-migration.md) for the current backend.

### `HasDegree` (1)

- **Statement**: the subject holds a valid, non-revoked credential of type
  `Degree` (or a descendant in the
  [credential type hierarchy](credential-types.md#credential-type-hierarchy))
  issued by an authorized issuer.
- **Public inputs**: credential type root ID, issuer commitment, revocation
  root, nonce.
- **Private witness**: full credential metadata (institution, field of
  study, graduation date), Merkle path to the credential commitment.
- **What is *not* revealed**: institution name, GPA, exact graduation date.

### `HasLicense` (2)

- **Statement**: the subject holds a valid, non-expired professional license
  credential, optionally scoped to a specific `license_type`
  (see [credential-types.md](credential-types.md), Professional License
  hierarchy) passed as an additional circuit parameter.
- **Public inputs**: as above, plus `current_ledger_timestamp` so expiry can
  be checked without revealing the exact `expiry_date`.
- **Private witness**: license number, jurisdiction, discipline, issuing
  authority, expiry date.
- **What is *not* revealed**: license number, exact jurisdiction/discipline
  unless the verifier explicitly requested a scoped proof.

### `HasEmploymentHistory` (3)

- **Statement**: the subject holds at least one valid Employment History
  credential from an attested employer.
- **Public inputs**: credential type root ID, issuer (employer) commitment.
- **Private witness**: employer identity, role, dates of employment.
- **What is *not* revealed**: employer identity, role, or duration — this is
  existence-only. It does **not** prove a minimum tenure or a specific
  employer; see `experience_years` / `employer_verification` below for how
  those stronger statements would extend this circuit.

### `HasCertification` (4)

- **Statement**: the subject holds a valid, non-revoked Certificate-type
  credential.
- **Public inputs / witness**: same shape as `HasDegree`, scoped to the
  Certificate branch of the credential type hierarchy.

### `HasResearchPublication` (5)

- **Statement**: the subject holds a valid credential attesting authorship
  or co-authorship of a research publication.
- **Public inputs / witness**: same shape as `HasDegree`, scoped to a
  research-publication credential type.

## Registry Versioning Strategy

`ClaimType` is a compiled `#[repr(u32)]` Rust enum shared by two contracts,
**not** a runtime-registrable value like the credential type registry — so
its versioning rules are stricter:

1. **Additive only, in-place.** New claim types are added as new enum
   variants with the next unused discriminant (currently `6` is next).
   Existing discriminants are never reused or renumbered — a `verify_claim`
   call with a stale discriminant must always resolve to the same claim
   type it did when issued, indefinitely.
2. **No removals.** A claim type is never deleted, only marked `Deprecated`
   in this document, to preserve verifiability of proofs generated against
   it in the past.
3. **Both contracts move together.** Because `quorum_proof` and
   `zk_verifier` mirror this enum for cross-contract ABI compatibility
   (see the safety comment at the top of the enum in
   `contracts/zk_verifier/src/lib.rs`), a new variant must be added to
   *both* files in the same change and deployed together. A mismatch
   between the two is a deploy-time correctness bug, not just a docs gap.
4. **Circuit changes require a new type, not a mutation.** If a claim's
   constraint set changes in a way that alters what a proof attests to,
   ship it as a new variant rather than changing what an existing
   discriminant means — old proofs must keep verifying against the
   semantics they were generated under.
5. **This document is the source of truth for semantics.** The enum defines
   the wire values; this file defines what each one *means*. Update this
   table in the same PR that adds a variant.

| Registry version | Change |
|---|---|
| 1.0 (current) | `HasDegree`, `HasLicense`, `HasEmploymentHistory`, `HasCertification`, `HasResearchPublication` |

## Custom / Proposed Claim Type Process

To propose a new standard claim type (e.g. `experience_years`,
`employer_verification`):

1. **Open an issue** describing the statement the claim should prove, and
   explicitly what it must *not* reveal.
2. **Design the circuit**: define public inputs, private witness, and how
   the statement is constrained (e.g. `experience_years` needs a range
   proof over a computed `end_date - start_date`, which is a materially
   different circuit from the existence-only proofs above; a threshold
   parameter such as "at least 5 years" becomes an additional public
   input). Cross-reference against
   [ZK Proof Scheme Specification](zk-proof-scheme-specification.md) for
   the constraint primitives already available in the circuit.
3. **Security review**: run the new circuit design past
   [Threat Model & Security Analysis](threat-model.md) and
   [Security Audit Checklist](security-audit-checklist.md) — a new proof
   circuit is new attack surface (soundness/completeness of the
   constraints, information leakage through public inputs).
4. **Implement as a new discriminant** in both `quorum_proof::ClaimType`
   and `zk_verifier::ClaimType` per the versioning rules above, with tests
   in both contracts and in `contracts/integration_tests`.
5. **Update this document** with the new type's row in the canonical table
   and a full "Proof Circuit Design" subsection, and bump the registry
   version above.

Until a proposed type completes this process and lands as a real enum
variant, it is **not** a valid `claim_type` value — `generate_proof_request`
only accepts the five standard types listed above.
