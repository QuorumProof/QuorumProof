# ADR-009: Quorum Slice Attestor Independence

## Status
Accepted

## Context

QuorumProof models trust through *quorum slices* — a set of independent third-party attestors whose
combined weight must meet a threshold before a credential is considered verified. The security
argument relies on every attestor being **independent**: they have no financial, organisational, or
identity conflict with the credential being attested.

Issue [#1510](https://github.com/cryptonautt/QuorumProof/issues/1510) identified a gap: nothing in
the contract prevented the **credential subject** (the person the credential is about) or the
**credential issuer** (the party that created it) from also acting as an attestor in a slice used
to attest that very credential. Such an arrangement would allow self-serving attestations:

- An issuer could mint a credential and immediately attest it themselves, with no independent
  verification.
- A subject could attest their own credential, defeating the purpose of the quorum.

Because the FBA trust model described in ADR-001 depends entirely on attestors being independent
third parties, allowing subject/issuer self-attestation is a **protocol-level security flaw**, not
merely a policy concern.

## Problem Statement

Should on-chain logic prevent the credential subject and/or issuer from acting as attestors in a
slice used to attest their own credential?

Constraints:
1. The fix must not break existing deployed slices where the enforcement was never required.
2. The flag must be operator-controllable so it can be rolled out gradually and rolled back in an
   emergency.
3. Error signalling must be unambiguous — callers must be able to distinguish "subject tried to
   attest themselves" from "issuer tried to attest their own credential".

## Alternatives Considered

### 1. No enforcement — documentation only
- **Description**: Document the expectation that subjects and issuers must not be in their own
  attesting slices. Leave enforcement to off-chain processes or front-end validation.
- **Pros**:
  - Zero code change risk.
  - Maximum flexibility for edge cases (e.g., an issuer who is also a legitimate peer reviewer).
- **Cons**:
  - Provides **no on-chain guarantee**. Any party can bypass front-end rules by calling the
    contract directly.
  - Contradicts the trustless design goal — "trustless" means the invariant is enforced by code,
    not by policy.
  - Does not address the security flaw identified in #1510.

### 2. Hard-coded, always-on enforcement
- **Description**: Unconditionally reject any `attest()` call where the attestor equals the
  credential's subject or issuer.
- **Pros**:
  - Simplest implementation; no flag to manage.
  - Maximum security guarantee.
- **Cons**:
  - Breaking change for any deployment that currently has a subject or issuer as an attestor (even
    if that was intentional or inconsequential).
  - No rollback path if the restriction turns out to be overly broad for a specific use case.

### 3. Admin-gated opt-in flag ✓ **CHOSEN**
- **Description**: Introduce a boolean `AttestorIndependenceEnabled` flag (default `false`).
  Admin can call `enable_attestor_independence` to activate enforcement. When active, `attest()`
  panics with `SubjectIsAttestor` or `IssuerIsAttestor` as appropriate. Admin can call
  `disable_attestor_independence` to revert.
- **Pros**:
  - No breaking change: existing deployments default to the old permissive behaviour.
  - Operators can enable enforcement on their own schedule.
  - Provides a clear rollback path (disable the flag).
  - Distinct error codes give integrators precise feedback.
- **Cons**:
  - Requires operators to actively enable the flag; it is not secure-by-default.
  - Two admin calls (enable/disable) add surface area compared to always-on.

### 4. Per-slice opt-in flag
- **Description**: Each slice could carry its own independence requirement, set at creation time.
- **Pros**: Fine-grained control per slice.
- **Cons**:
  - Significantly more complex: every slice creation and add-attestor call needs extra parameters.
  - Slices are created before they are associated with credentials, so it is unclear what
    "subject" and "issuer" mean at slice-creation time.
  - Verification at attest time already has the credential in scope; a single global flag is
    sufficient.

## Decision

**Implement admin-gated opt-in flag (Alternative 3).**

Changes introduced in this PR:

| Artefact | Change |
|---|---|
| `ContractError` | Added `SubjectIsAttestor = 96` and `IssuerIsAttestor = 97` |
| `DataKey10` | Added `AttestorIndependenceEnabled` variant |
| `QuorumProofContract` | Added `enable_attestor_independence(admin)`, `disable_attestor_independence(admin)`, `is_attestor_independence_enabled()` public functions |
| `QuorumProofContract` | Added private `require_attestor_independence(env, attestor, credential)` helper |
| `attest()` | Calls `require_attestor_independence` immediately after credential validity checks |
| `docs/error-codes.md` | Documents new error codes 96 and 97 |
| Tests | Five new unit tests covering the default-off, blocked-subject, blocked-issuer, allowed-third-party, and disable-reverts scenarios |

## Rationale

1. **Trustless by default requires code enforcement.** A credential verification network in which
   the subject can self-attest is not trustless — it is a single-party signature with extra steps.
   The FBA model (ADR-001) only provides safety guarantees when attestors are truly independent.

2. **Opt-in flag preserves backwards compatibility.** Existing live contracts are unaffected
   until an operator decides to enable the flag. This matches how other security flags
   (`CircuitBreaker`, `MaxAttestorsPerSlice`) were rolled out.

3. **Enforcement at `attest()` is the correct chokepoint.** Slices are created independently of
   credentials; a slice may legitimately contain the future subject as a member for other
   credentials. The subject/issuer identity is only knowable when `attest()` is called with a
   specific `credential_id`.

4. **Distinct error codes improve debuggability.** `SubjectIsAttestor (96)` and
   `IssuerIsAttestor (97)` let callers distinguish the two independence violations without
   parsing error messages.

## Consequences

- **Positive**: When the flag is enabled, the protocol enforces the independence invariant
  on-chain, eliminating the self-attestation attack vector.
- **Negative**: Operators must remember to enable the flag; it is not secure-by-default. This
  is intentional to avoid a surprise breaking change for existing deployments.
- **Neutral**: The flag can be toggled at any time. Enabling it does not retroactively invalidate
  existing attestation records — it only gates future `attest()` calls.

## References

- Issue [#1510](https://github.com/cryptonautt/QuorumProof/issues/1510) — original issue report
- ADR-001 — Federated Byzantine Agreement Trust Model
- ADR-006 — Economic Security Model
- `contracts/quorum_proof/src/lib.rs` — implementation
