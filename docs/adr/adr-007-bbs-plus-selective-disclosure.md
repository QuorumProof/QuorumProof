# ADR-007: BBS+ Signatures for Selective Disclosure

## Status
Accepted

## Context
QuorumProof issues verifiable credentials (degrees, licenses, employment history) that engineers present to third parties (employers, licensing boards, immigration authorities) to prove professional standing. A single credential typically bundles many attributes: full name, date of birth, institution, graduation year, GPA, license number, jurisdiction, etc.

Presenting a credential today, with a conventional digital signature (ECDSA/Ed25519), means presenting the entire signed payload — the verifier receives every attribute even when only one or two are relevant (e.g. "is this person licensed in this jurisdiction?" does not require revealing their date of birth or GPA). This is a data minimization problem: engineers are forced to over-share personal data to prove a narrow claim, and every verifier who receives a full credential becomes a copy of the individual's complete professional record sitting in a third party's database.

## Problem Statement
How should QuorumProof let a credential holder prove a subset of attested claims to a verifier while:
1. Not revealing the other attributes contained in the credential
2. Preserving unforgeability — the verifier must be convinced the disclosed attributes were signed by a legitimate issuer, without contacting the issuer
3. Preventing the presentation itself from becoming a new tracking identifier (unlinkability across multiple presentations of the same credential)
4. Remaining feasible to verify inside a Soroban smart contract, which has tight CPU-instruction and memory budgets

## Alternatives Considered

### 1. Plain Signatures + Redaction
- **Description**: Sign the full attribute set with Ed25519/ECDSA; holder redacts fields before sending, verifier only checks the signature over the *original, unredacted* bytes (which it never sees) — i.e. this doesn't actually work without a Merkle structure.
- **Pros**: No new cryptography, reuses existing Soroban primitives
- **Cons**: A plain signature is over one fixed byte string. Removing any byte invalidates it. Cannot support selective disclosure at all without an auxiliary structure.

### 2. Merkle-Tree Credentials (Hash-Based Selective Disclosure)
- **Description**: Each attribute is hashed into a leaf of a Merkle tree; the issuer signs the root. Holder discloses a subset of leaves plus the Merkle proof path.
- **Pros**: Simple, uses only hash functions (cheap on-chain), no exotic curve arithmetic
- **Cons**: Reveals the *number* and *tree position* of undisclosed attributes (a fixed-shape tree leaks schema information), presentations of the same credential to different verifiers are trivially linkable (same root, same undisclosed-leaf hashes reappear), and does not support proving predicates over hidden values (e.g. "age > 18") without revealing the value itself.

### 3. zk-SNARK over a Generic Signature (Groth16-wrapped Ed25519)
- **Description**: Sign attributes normally, then have the holder prove in zero-knowledge "I know a valid signature over a superset of attributes that includes these disclosed ones."
- **Pros**: Maximum flexibility, can prove arbitrary predicates
- **Cons**: Requires a full R1CS circuit for Ed25519/ECDSA verification, which is expensive to prove client-side (seconds, not milliseconds) and requires a trusted setup per circuit. Massive overkill for the common case of "just reveal a subset of fields."

### 4. BBS+ Signatures ✓ **CHOSEN**
- **Description**: A pairing-based multi-message signature scheme (Au, Susilo, Mu; standardized in the IETF `draft-irtf-cfrg-bbs-signatures`) where the issuer signs a *vector* of messages under one signature. The holder can later derive a zero-knowledge proof of knowledge of a valid signature that discloses an arbitrary subset of the messages while keeping the rest, and the signature itself, hidden.
- **Pros**:
  - Native selective disclosure — no auxiliary Merkle structure or generic circuit needed
  - Proof size and disclosed message count are independent of the number of hidden messages (constant-size core proof)
  - Presentations are unlinkable: each derived proof is randomized, so two presentations of the same credential to two verifiers (or the same verifier twice) cannot be correlated by the signature material itself
  - Supports proof-of-knowledge extensions (range proofs, predicates) built on the same pairing group, which QuorumProof already uses for its other ZK circuits
  - Well-studied security proofs under the q-SDH / DDH assumption in the pairing setting
- **Cons**:
  - Requires pairing-friendly curve arithmetic (BLS12-381) inside the Soroban contract, which is more expensive per operation than a hash-based check
  - Newer standard (still in IETF draft) than plain signatures; smaller ecosystem of audited implementations
  - Issuer must commit to the maximum message vector length at signing time (schema must be fixed per credential type)

## Decision
**Adopt BBS+ signatures as the credential signing and presentation scheme for selective disclosure in QuorumProof**, implemented in `contracts/bbs_plus_v1`.

Each credential is signed as a vector of messages (one per attribute). Holders derive presentation proofs off-chain (or via a helper contract call) that disclose only the attributes required by a given verifier; the `bbs_plus_v1` contract verifies the resulting proof of knowledge on-chain without ever learning the hidden attribute values.

## Rationale

1. **Purpose-built for the problem**: Unlike Merkle redaction or generic SNARK wrapping, BBS+ was designed specifically for multi-message selective disclosure, so it directly minimizes the amount of new cryptographic machinery QuorumProof has to build and audit.
2. **Unlinkability by default**: Each derived proof re-randomizes the signature commitment, so verifiers and issuers cannot correlate separate presentations of the same underlying credential — a requirement for cross-border credential use where an engineer may present to dozens of independent verifiers.
3. **Reuses existing pairing infrastructure**: QuorumProof already implements pairing operations (`primitives::pairing`, `G1`/`G2`/`Gt` arithmetic) for its ZK verifier stack (see [ADR-003](./adr-003-zk-verification.md)); BBS+ shares this arithmetic base, avoiding a second, unrelated curve library.
4. **Standardization trajectory**: The IETF CFRG draft gives a reviewed, versioned specification to track, reducing the risk of inventing an ad hoc scheme.

## Consequences

### Positive
- Engineers disclose the minimum data necessary per verifier, directly reducing data-breach blast radius
- Verifiers get cryptographic assurance without contacting the issuer or seeing hidden attributes
- Presentations do not create a new linkable identifier across verifiers
- Shares pairing primitives with the existing ZK verifier contract, reducing audit surface

### Negative
- On-chain pairing checks are more compute-expensive than hash checks; contract CPU budgets must be monitored (see `contracts/bbs_plus_v1/src/primitives.rs`)
- Credential schemas (attribute count/order) must be fixed at issuance time; adding an attribute to an existing credential type requires a new schema version
- Requires holders to run proof-derivation logic client-side; SDKs must ship this capability (see [BBS+ tutorial](../bbs-plus-tutorial.md))

## Implementation Notes

1. **Signature structure**: `contracts/bbs_plus_v1/src/signature.rs` implements issuer signing over a message vector using the primitives in `primitives.rs` (`Fr`, `G1`, `G2`, `Gt`, `pairing`).
2. **Presentation/proof derivation**: `contracts/bbs_plus_v1/src/presentation.rs` implements the holder-side derivation of a selective-disclosure proof of knowledge, using `transcript.rs` for Fiat-Shamir challenge generation.
3. **Revocation**: `contracts/bbs_plus_v1/src/accumulator.rs` provides a cryptographic accumulator so individual credentials can be revoked without breaking unlinkability of unrevoked ones.
4. **Verification path**: The on-chain contract entry point verifies the proof of knowledge against the issuer's public key and the set of disclosed messages; hidden messages never appear on-chain or in call arguments.
5. **Epoch staleness enforcement**: `contracts/bbs_plus_v1/src/accumulator.rs` defines `MAX_WITNESS_EPOCH_AGE = 2` epochs. All verifiers MUST call `is_witness_stale(witness_epoch, current_epoch)` and reject witnesses whose epoch age exceeds this bound. The `AccumulatorEpoch::rebuild` method returns an `EpochRolloverEvent` on every rollover — indexers listening for this event allow verifiers to track the current epoch without maintaining independent state. A stale witness still passes `Witness::verify` cryptographically (the signature remains valid), so the staleness check is the **only** defense against accepting a revoked holder's outdated witness.

## References
- [BBS+ Signatures — IETF CFRG Draft](https://datatracker.ietf.org/doc/draft-irtf-cfrg-bbs-signatures/)
- Au, Susilo, Mu, "Constant-Size Dynamic k-TAA" (origin of the BBS+ construction)
- [ADR-003: Zero-Knowledge Verification Approach](./adr-003-zk-verification.md)
- [BBS+ Tutorial and Developer Guide](../bbs-plus-tutorial.md)
- `contracts/bbs_plus_v1/README.md`
