# BBS+ Selective Disclosure Tutorial

## Who this is for

Developers integrating with `contracts/bbs_plus_v1` who need to issue BBS+-signed credentials, or build a holder/verifier flow around selective disclosure, but don't yet have a working mental model of what BBS+ actually does. For the design rationale (why BBS+ over alternatives), see [ADR-007](./adr/adr-007-bbs-plus-selective-disclosure.md). For the raw API surface, read `contracts/bbs_plus_v1/README.md` and the module source directly — this tutorial explains the *flow*, not every parameter.

## 1. Mental Model

A BBS+ signature is over a **vector of messages**, not one blob:

```
messages = [m1, m2, m3, ..., mL]     // e.g. [name, dob, institution, degree, grad_year]
signature = Sign(issuer_secret_key, messages)
```

Three roles:
- **Issuer** — holds a `SigningKey` (secret scalar) and a corresponding `VerifyingKey`/public key (a G2 point plus circuit metadata such as `message_count`), and signs the full message vector once at credential-issuance time.
- **Holder** — receives the `Signature` and the messages, and later derives a `PresentationProof` that discloses only a chosen subset of the messages, blinding the rest and re-randomizing the signature so it cannot be linked to prior presentations.
- **Verifier** — receives the `PresentationProof` plus the disclosed messages, and calls verification against the issuer's `VerifyingKey`. It learns nothing about undisclosed messages beyond what the disclosed ones and the proof imply.

The key property: the holder does not need to go back to the issuer to produce a new presentation. Every presentation is derived locally and is unlinkable to every other presentation of the same underlying signature.

## 2. Signature Creation and Verification

### 2.1 Issuer: key generation

```rust
use bbs_plus_v1::signature::SigningKey;

let mut rng = rand::thread_rng();
let signing_key = SigningKey::generate(&mut rng);
let verifying_key_point = signing_key.public_key(); // G2 point published to holders/verifiers
```

In production, `SigningKey::generate` should be called inside an HSM or a secure enclave — the raw `Fr` scalar returned by `signing_key.scalar()` is the entire security of every credential this key ever signs. Never log or serialize the signing key scalar outside of a secured issuance service.

### 2.2 Issuer: deriving a verifying key for a credential schema

Each credential type (e.g. "Engineering Degree v1") fixes a message count and a domain-separation context:

```rust
use bbs_plus_v1::signature::VerifyingKey;

let verifying_key = VerifyingKey::derive(
    verifying_key_point,
    b"quorumproof:credential:engineering-degree:v1", // context_id — schema domain separator
    5,                                                 // message_count: name, dob, institution, degree, grad_year
)?;
```

The `context_id` matters: it prevents a signature valid for one credential schema from being reinterpreted as valid for a different schema that happens to share a message count.

### 2.3 Issuer: signing the message vector

```rust
use bbs_plus_v1::signature::BbsSignature;

let messages: [Fr; 5] = [
    hash_to_scalar(b"Jane Engineer"),
    hash_to_scalar(b"1998-04-12"),
    hash_to_scalar(b"Acme Institute of Technology"),
    hash_to_scalar(b"BSc Civil Engineering"),
    hash_to_scalar(b"2021"),
];

let signature = BbsSignature::sign(&mut rng, &signing_key, &messages)?;
let signature_bytes: [u8; 112] = signature.to_bytes(); // stored alongside the credential record
```

Attributes are hashed to `Fr` scalars before signing (BBS+ signs field elements, not raw bytes) — use a fixed, documented hash-to-scalar function per credential schema so issuer and holder never disagree on encoding.

### 2.4 Holder: verifying the raw issuer signature (sanity check)

Before deriving any presentation, the holder should confirm the issuer's signature verifies against the full message vector:

```rust
let is_valid = BbsSignature::verify(&verifying_key, &signature, &messages)?;
assert!(is_valid, "issuer signature does not verify — do not accept this credential");
```

## 3. Disclosure Patterns

### 3.1 Full disclosure (baseline)

Disclosing every message is the degenerate case — equivalent in information content to a plain signature, but still gets unlinkability across presentations for free.

```rust
use bbs_plus_v1::presentation::BbsPresentation;

let disclosed_indices = [0, 1, 2, 3, 4]; // all five attributes
let proof = BbsPresentation::create_presentation(
    &mut rng,
    &verifying_key,
    &signature,
    &messages,
    &disclosed_indices,
)?;
```

### 3.2 Selective disclosure — prove licensure without revealing personal data

The common case: a verifier only needs to know the holder is a licensed civil engineer in a jurisdiction, not their name or date of birth.

```rust
// Disclose only "degree" (index 3); keep name, dob, institution, grad_year hidden.
let disclosed_indices = [3];
let proof = BbsPresentation::create_presentation(
    &mut rng,
    &verifying_key,
    &signature,
    &messages,
    &disclosed_indices,
)?;

// The holder sends `proof.to_bytes()` plus the cleartext value of messages[3]
// ("BSc Civil Engineering") to the verifier. Nothing else about the credential
// is transmitted or derivable.
```

### 3.3 Multi-credential disclosure

A holder can independently derive presentations from *different* credentials for the same verifier interaction (e.g. "degree" from one BBS+-signed credential and "license active" from another) — each presentation is derived and verified independently; there is no built-in cross-credential linking, which is a deliberate anti-correlation property. If a use case genuinely needs to prove two disclosed attributes come from the *same* holder, that requires an explicit binding mechanism (e.g. a shared holder-committed pseudonym) layered on top — it is not automatic.

### 3.4 Predicate disclosure (range/equality proofs)

Beyond revealing a raw attribute value, BBS+ presentations can carry zero-knowledge predicate proofs over hidden messages (e.g. "graduation year is before 2015" without revealing the exact year). This is exposed as an extension of `PresentationProof` — check `contracts/bbs_plus_v1/src/presentation.rs` for the current predicate support surface before relying on a specific predicate type, since this module is still being built out (see the Phase 1 status table in `contracts/bbs_plus_v1/README.md`).

## 4. Verifier: Checking a Presentation

```rust
use bbs_plus_v1::presentation::BbsPresentation;

let disclosed_messages: &[(usize, Fr)] = &[(3, hash_to_scalar(b"BSc Civil Engineering"))];

let ok = BbsPresentation::verify_presentation(
    &verifying_key,
    &proof,
    disclosed_messages,
)?;

if !ok {
    // Reject: either the proof is malformed, was not derived from a valid
    // issuer signature, or the disclosed message does not match what the
    // holder committed to inside the proof.
}
```

The verifier only ever needs the issuer's `VerifyingKey` and the disclosed messages — it never contacts the issuer and never sees the hidden attributes.

## 5. Privacy Guarantees

| Property | What it means in practice |
|---|---|
| **Selective disclosure** | Only attributes the holder explicitly includes in `disclosed_indices` are visible to the verifier, in cleartext or as a predicate proof. Everything else stays computationally hidden inside the proof. |
| **Unlinkability** | Each call to `create_presentation` re-randomizes the underlying signature commitment. Two presentations derived from the *same* signature and disclosing the *same* attributes are still cryptographically unlinkable to each other — an issuer or verifier colluding across sessions cannot tell they came from the same credential. |
| **Unforgeability (EUF-CMA)** | No one without the issuer's `SigningKey` can produce a signature (or a presentation that verifies) over a message vector the issuer never signed. |
| **Honest-verifier zero-knowledge (HVZK)** | The presentation proof reveals nothing about hidden messages beyond what is logically implied by the disclosed ones — a verifier following the protocol learns no extra bits. |
| **Non-transitive trust** | A verifier's ability to check a presentation does not give it the ability to *forge* new presentations or impersonate the holder to a third party. |

**What BBS+ does *not* protect against:**
- **Metadata correlation outside the proof** — if the holder always presents from the same network IP, wallet address, or timing pattern, that's a linkability channel BBS+ has no control over.
- **Issuer collusion at issuance time** — the issuer sees the full message vector when signing; BBS+ protects disclosure to *verifiers*, not from the issuer itself.
- **Revocation checks leaking information** — naive revocation lookups (e.g. checking a public revocation list by credential ID) can reintroduce linkability. QuorumProof addresses this with the cryptographic accumulator in `contracts/bbs_plus_v1/src/accumulator.rs`, which supports non-membership proofs without revealing which specific credential is being checked.

## 6. Code Samples in Multiple Languages

The Rust examples above use the actual contract crate. The following show the same *conceptual* flow — message vector in, presentation proof out — via a generic client SDK shape. Treat these as illustrative pseudocode until the corresponding JS/Python SDK bindings ship; check `docs/sdk-methods-reference.md` for what is currently available.

### JavaScript / TypeScript (holder-side presentation derivation)

```typescript
import { BbsPresentation, hashToScalar } from "@quorumproof/bbs-plus-sdk";

const messages = [
  hashToScalar("Jane Engineer"),
  hashToScalar("1998-04-12"),
  hashToScalar("Acme Institute of Technology"),
  hashToScalar("BSc Civil Engineering"),
  hashToScalar("2021"),
];

const proof = await BbsPresentation.createPresentation({
  verifyingKey,
  signature,
  messages,
  disclosedIndices: [3], // reveal only "degree"
});

await sendToVerifier({ proofBytes: proof.toBytes(), disclosed: { degree: "BSc Civil Engineering" } });
```

### Python (verifier-side check)

```python
from quorumproof_bbs import BbsPresentation, VerifyingKey

verifying_key = VerifyingKey.from_bytes(issuer_vk_bytes)
proof = BbsPresentation.from_bytes(proof_bytes)

ok = BbsPresentation.verify_presentation(
    verifying_key,
    proof,
    disclosed_messages=[(3, hash_to_scalar("BSc Civil Engineering"))],
)

if not ok:
    raise ValueError("presentation failed verification")
```

### Soroban CLI (invoking the deployed contract directly)

```bash
soroban contract invoke \
  --id $BBS_PLUS_CONTRACT_ID \
  --source verifier-account \
  --network mainnet \
  -- \
  verify_presentation \
  --verifying_key_hash $VK_HASH \
  --proof_bytes $PROOF_HEX \
  --disclosed_messages '[{"index":3,"value":"BSc Civil Engineering"}]'
```

## References
- [ADR-007: BBS+ Signatures for Selective Disclosure](./adr/adr-007-bbs-plus-selective-disclosure.md)
- `contracts/bbs_plus_v1/README.md`
- `contracts/bbs_plus_v1/src/signature.rs`, `presentation.rs`, `accumulator.rs`
- [IETF CFRG BBS Signatures draft](https://datatracker.ietf.org/doc/draft-irtf-cfrg-bbs-signatures/)
- [`docs/privacy-guide.md`](./privacy-guide.md) — broader privacy model this fits into
