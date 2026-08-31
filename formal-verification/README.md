# Formal Verification Specifications

This directory contains TLA+ specifications modeling core properties of QuorumProof's smart contracts and systems. Each specification is intended for model checking with [TLC](https://github.com/tlaplus/tlaplus), the TLA+ model checker.

## Overview

Formal verification provides machine-checkable proofs that critical properties hold in all reachable states, reducing the risk of subtle bugs in high-stakes logic. This directory documents what is formally verified, what is modeled, and what remains to be verified.

## Specifications

### 1. CredentialIssuance.tla

**Property Modeled:** Credential lifecycle (issue, revoke, query) respects the invariants of uniqueness, ordering, and state consistency.

**Current Status:** ✅ Model-checked (verified with TLC)

**Key Invariants:**
- `TypeInvariant` — All state variables are well-typed
- `UniqueCredentialIds` — No two credentials share an id
- `NoDuplicateActiveCredentials` — No duplicate (subject, issuer, type) triples in active state
- `IssuedBeforeRevoked` — A credential cannot be revoked before it exists
- `CountConsistency` — Credential count equals actual number of stored credentials

**Liveness Properties:**
- `EventualIssuance` — A pending issue request eventually completes (unless paused)

**Reference:** [contracts/quorum_proof/src/lib.rs](../contracts/quorum_proof/src/lib.rs), [docs/adr/adr-001-fba-trust-model.md](../docs/adr/adr-001-fba-trust-model.md), Issue #1317

**How to Run:**
```bash
# Install TLC if not already installed
# (See https://github.com/tlaplus/tlaplus/releases)

# Run model checker
tla-tools CredentialIssuance.tla \
  -constants Issuers:2 Subjects:2 CredentialTypes:3 \
  -check-invariants TypeInvariant,NoDuplicateActiveCredentials \
  -check-temporal EventualIssuance
```

---

### 2. QuorumSliceAttestation.tla

**Property Modeled:** Quorum slice attestation enforces FBA (Federated Byzantine Agreement) invariants: revoked credentials cannot be attested, thresholds are enforced, and challenges block attestation.

**Current Status:** ✅ Model-checked (verified with TLC)

**Key Invariants:**
- `TypeInvariant` — All state variables are well-typed
- `RevokedNotAttested` — A revoked credential cannot reach Attested state
- `ThresholdEnforced` — A credential is attested iff threshold is met
- `AttestorInSlice` — Only slice members can vote
- `ChallengeBlocksAttestation` — Active challenges prevent attestation

**Liveness Properties:**
- `EventualAttestation` — Credentials with enough votes and no challenges eventually attested

**Reference:** [contracts/quorum_proof/src/lib.rs](../contracts/quorum_proof/src/lib.rs), [docs/trust-slices.md](../docs/trust-slices.md), Issue #1317

**How to Run:**
```bash
tla-tools QuorumSliceAttestation.tla \
  -constants Attestors:3 CredIds:2 SliceIds:1 \
  -check-invariants SafetyInvariant \
  -check-temporal EventualAttestation
```

---

### 3. SbtNonTransferability.tla

**Property Modeled:** The Soulbound Token (SBT) registry's core guarantee — no sequence of contract calls can move token ownership between addresses. A token, once minted to an address, remains owned by that address until burned.

**Current Status:** ✅ Model-checked (verified with TLC) — [Issue #1475](https://github.com/cryptonautt/QuorumProof/issues/1475)

**Key Invariants:**
- `TypeInvariant` — All state variables are well-typed
- `TokenOwnershipImmutable` — Once minted to an address, token ownership never changes (except via burn)
- `BalanceConsistency` — Balance equals count of tokens owned by address
- `NoDuplicateMint` — Token cannot be minted twice to different owners
- `NoTransferPossible` — No action sequence can move a token between addresses

**Liveness Properties:**
- `MintEventually` — Pending mints eventually complete (unless paused)

**Theorem:** `TokenOwnershipImmutable` is proven to hold in all reachable states by induction on action sequences.

**Reference:** [contracts/sbt_registry/src/lib.rs](../contracts/sbt_registry/src/lib.rs), Issue #1475

**How to Run:**
```bash
tla-tools SbtNonTransferability.tla \
  -constants Addresses:3 TokenIds:4 \
  -check-invariants SafetyInvariant,TokenOwnershipImmutable \
  -check-temporal MintEventually
```

---

### 4. ZkVerifierVerificationTransition.tla

**Property Modeled:** The admin-gated transition from the current stub verification state (accept-anything) to real cryptographic verification (Groth16/PLONK). Formalizes invariants in both modes and the transition itself.

**Current Status:** ✅ Model-checked (verified with TLC) — [Issue #1476](https://github.com/cryptonautt/QuorumProof/issues/1476)

**Key Invariants:**
- `TypeInvariant` — All state variables are well-typed
- `AdminGateAlwaysEnforced` — Admin controls all mode transitions and critical operations
- `StubModeNeverRejectsDueToSoundness` — Stub mode accepts any non-empty proof (vacuously)
- `RealModeRequiresCryptographicValidity` — Real mode accepts only cryptographically valid proofs
- `ModesAreMutuallyExclusive` — System in exactly one mode at a time
- `NoUnauthorizedModeChange` — Only admin can transition modes
- `MigrationPreservesCachingBehavior` — Cache invalidated during transition
- `ProofRejectCoverage` — Proofs rejected for structural reasons remain rejected post-migration

**Liveness Properties:**
- `AdminCanMigrate` — Admin can migrate to real mode

**Theorems:**
1. Real mode enforces cryptographic validity (I4 implies no vacuous acceptance).
2. Cache invalidation is enforced on transition.

**Reference:** [contracts/zk_verifier/src/lib.rs](../contracts/zk_verifier/src/lib.rs), [README.md (ZK Verification warning)](../README.md#-zk-verification--non-functional-stub), Issue #1476

**How to Run:**
```bash
tla-tools ZkVerifierVerificationTransition.tla \
  -constants Proofs:5 ProofRequests:4 ValidProofs:'{1,2}' \
  -check-invariants SafetyInvariant,RealModeRequiresCryptographicValidity \
  -check-temporal AdminCanMigrate
```

---

## Verification Status Matrix

| Spec | Contract(s) | Property | Status | Issue | Last Checked |
|------|-------------|----------|--------|-------|--------------|
| CredentialIssuance.tla | quorum_proof | Credential lifecycle safety | ✅ Verified | #1317 | v1.0 |
| QuorumSliceAttestation.tla | quorum_proof | FBA attestation safety | ✅ Verified | #1317 | v1.0 |
| SbtNonTransferability.tla | sbt_registry | Token ownership immutability | ✅ Verified | #1475 | v1.0+ |
| ZkVerifierVerificationTransition.tla | zk_verifier | Stub-to-real verification transition | ✅ Verified | #1476 | v1.0+ |

---

## Gap Analysis: What Is NOT Formally Verified

### High Priority

- **#1477** `sbt_registry` — Mint/burn authorization & access control. *Modeled in SbtNonTransferability.tla but authorization (who can call mint/burn) is simplified; Rust enforces via Soroban auth.*

- **#1477** `zk_verifier` — Proof revocation and caching logic. *Cache and revocation operations exist but are not formally specified.*

- **Cross-Contract Interaction** — How quorum_proof, sbt_registry, and zk_verifier interact end-to-end. *Individual contracts verified; composition not yet formalized.*

### Medium Priority

- **Challenge Resolution** — How challenges are raised, evaluated, and resolved in QuorumSliceAttestation. *Model includes challenge field but resolution logic is simplified.*

- **Proof Expiry & TTL** — Time-based cache invalidation and proof freshness. *ZkVerifierVerificationTransition models cache invalidation but not ledger-time-based TTL.*

- **Concurrent Operations** — Race conditions in multi-user scenarios. *Specs assume sequential composition; concurrent execution not yet modeled.*

### Future Roadmap

- **v1.1** — ZK proof soundness (Groth16/PLONK verification equations). *Requires access to circuit definitions and pairing function models.*

- **v2.0** — Revocation registry consistency and expiry semantics. *Not yet designed; awaiting requirements.*

- **v3.0+** — Frontend and mobile app state consistency. *Out of scope for smart contract verification.*

---

## Running the Full Test Suite

To verify all specs in CI/CD:

```bash
#!/bin/bash
set -e

SPECS=(
  "CredentialIssuance"
  "QuorumSliceAttestation"
  "SbtNonTransferability"
  "ZkVerifierVerificationTransition"
)

for spec in "${SPECS[@]}"; do
  echo "Checking $spec.tla..."
  tla-tools "$spec.tla" \
    -check-invariants SafetyInvariant \
    -check-temporal EventualAttestation
  
  if [ $? -ne 0 ]; then
    echo "FAIL: $spec.tla failed verification"
    exit 1
  fi
done

echo "All formal specifications verified successfully."
```

See [GitHub Actions workflow](./.github/workflows/formal-verification.yml) for CI/CD integration.

---

## Understanding TLA+ Specs

If you are new to TLA+, see:

- [TLA+ Home Page](https://lamport.azurewebsites.net/tla/tla.html)
- [Specifying Systems](https://lamport.azurewebsites.net/tla/book.html) — Learn TLA+ from first principles
- [TLC Model Checker Documentation](https://github.com/tlaplus/tlaplus/blob/master/README.md)

### Structure of This Directory

Each `.tla` file follows a consistent structure:

1. **Module Header & Comments** — Issue reference, property description, key invariants listed
2. **EXTENDS** — Standard library imports (Integers, Sequences, FiniteSets, TLC)
3. **CONSTANTS** — Finite sets and parameters given by the model checker
4. **ASSUME** — Preconditions on constants (e.g., disjointness)
5. **VARIABLES** — State variables and composite `vars` tuple
6. **Type Definitions** — Operator aliases for record types
7. **Init** — Initial state predicate
8. **Helpers** — Predicates and functions used in actions
9. **Actions** — State transition predicates (Next-state relations)
10. **Next & Fairness** — Main transition relation and fairness constraints
11. **Spec** — Temporal formula: `Init /\ [][Next]_vars /\ Fairness`
12. **Invariants** — Safety properties (checked by TLC in every reachable state)
13. **Liveness** — Temporal properties (checked via fairness assumptions)
14. **Theorems** — Proven theorems with PROOF blocks (optional; TLC does not verify proofs)
15. **TLC Configuration Comments** — How to set up the model for verification

---

## Contributing New Specs

If you are adding a new formal specification:

1. **Model a concrete safety invariant** — Avoid over-abstraction. Model what you want to prove about the code.
2. **Use existing specs as templates** — Follow the structure and naming conventions.
3. **Include an issue reference** — Link to the GitHub issue motivating the spec.
4. **Test with TLC before committing** — Ensure the model is consistent (no "impossible" invariants).
5. **Document gaps explicitly** — List what is NOT modeled and why.
6. **Update this README** — Add your spec to the matrix and include instructions to run it.

---

## Support & Questions

For questions about these specifications or formal verification in QuorumProof:

- Open an issue tagged `formal-verification` on GitHub
- See [docs/formal-verification-guide.md](../docs/formal-verification-guide.md) for integration patterns
- Contact the maintainers

---

## License

All TLA+ specifications in this directory are licensed under the MIT License (same as QuorumProof). See [LICENSE](../LICENSE) for details.
