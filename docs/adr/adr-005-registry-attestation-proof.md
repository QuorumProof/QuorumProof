# ADR-005: Registry Attestation Proof for Licensing Body Integrations

## Status
Accepted

## Context
[government-licensing-integration.md](../government-licensing-integration.md) lets a government licensing body issue an on-chain credential after checking a candidate's permit against its own off-chain registry. The reference implementation for that check is a plain HTTPS `fetch()`: the issuer's backend calls the registry API, reads the JSON response, and moves on. Nothing about that fetch survives past the function call.

The document nonetheless tells third-party verifiers that they are trusting "both the QuorumProof attestation quorum **and** the backing official record." That second half of the claim is currently unbacked. A dishonest or compromised issuer can call `issue_credential` with a `metadata_hash` that commits to whatever permit fields it wants — there is no artifact proving the registry ever returned that data, or that it was fetched recently enough to still be true. The on-chain quorum (ADR-001) protects against a single rogue *signer*; it does nothing to protect against a signer set that colludes, or is fed fabricated registry data by a compromised issuer backend.

We need a mechanism that lets a verifier — potentially months later, with no access to the issuer's infrastructure — confirm that a specific HTTPS response was actually returned by a specific registry endpoint at a specific time, and that the credential's on-chain commitment is bound to that exact response.

## Problem Statement
How do we prove, in a way independently re-checkable after the fact, that:
1. A specific registry endpoint returned a specific response body.
2. That response was fresh enough to be trustworthy at issuance time.
3. The `issue_credential` call in question is bound to that exact response, not a substituted one.
4. Registries that cannot support the chosen mechanism are handled without silently degrading the trust claim made to verifiers.

## Alternatives Considered

### 1. Full zkTLS / TLSNotary-style MPC-TLS proof
- **Description**: Run the TLS session to the registry through a two/three-party MPC protocol (as in TLSNotary, DECO, or zkTLS proving systems) so a proof can be produced that a given plaintext was exchanged with a given TLS server, without any party unilaterally controlling the transcript.
- **Pros**: No trust in any single fetcher — the proof is cryptographically sound evidence of the TLS session itself, including server identity.
- **Cons**: Requires a notary/MPC-TLS infrastructure component we do not operate today, adds a heavyweight dependency and protocol surface, and most government registries were not evaluated against this requirement. Building and auditing this from scratch is out of scope for this change.
- **Verdict**: Adopted as the **Tier 1 / future** target. The proof envelope defined below (`proofTier`, versioned proof object) is designed so a `zktls-v1` tier can be added later without changing the binding mechanism or the document schema.

### 2. Trust the issuer's own signature over the fetch (status quo, implicit)
- **Description**: What the document effectively describes today — the issuer's backend fetches and signs nothing beyond the final `issue_credential` transaction.
- **Cons**: A single compromised or dishonest issuer backend can fabricate the registry response with nothing to contradict it. Fails the problem statement entirely.
- **Verdict**: Rejected — this is the gap this ADR closes.

### 3. Signed Registry-Attestation Oracle Committee (RAOC) ✓ **CHOSEN (Tier 2, default)**
- **Description**: A quorum of *independent* oracle nodes (operated by different parties — e.g. the licensing body, a QuorumProof-operated witness, and a third-party auditor) each independently fetch the same registry endpoint, hash the response, and sign a structured attestation. An `m`-of-`n` threshold of attestations that agree on the response hash forms a Registry Attestation Quorum (RAQ), mirroring the existing FBA quorum-slice trust model from ADR-001 rather than introducing a new one.
- **Pros**: Reuses cryptography and operational patterns already in this codebase (Ed25519 signing, threshold quorums, independent re-verification). No new infrastructure dependency — implementable with Node's built-in `crypto` module. Collusion requires compromising `m` independently-operated parties, not just the issuer.
- **Cons**: Weaker than Tier 1 — a majority-colluding oracle set can still forge a quorum. Requires recruiting independent oracle operators per registry.
- **Verdict**: Adopted as the default, implemented tier.

### 4. Single-attester signed fetch (no committee)
- **Description**: One party (the issuer or a designated proxy) fetches and signs the response. No independent corroboration.
- **Cons**: Only marginally better than alternative 2 — proves *a* signer said so, not that multiple independent parties saw the same thing.
- **Verdict**: Adopted, but **only** as an explicitly-labeled fallback (Tier 3) for registries that structurally cannot support multi-party fetching (e.g. IP-allowlisted or mTLS-restricted APIs bound to a single client identity). Every proof object carries a `proofTier` field so this downgrade is always visible to verifiers, never silent.

## Decision
**Implement a tiered, versioned registry-proof envelope, bound into the credential's content-addressed metadata document, with Tier 2 (oracle committee) as the implemented default:**

- **Tier 1 — `zktls-v1`** (reserved, not yet implemented): MPC-TLS proof of the raw TLS session. The envelope format reserves this tier so it can be added later without a breaking change.
- **Tier 2 — `oracle-committee`** (implemented, default): `m`-of-`n` independently-signed `RegistryFetchAttestation`s, aggregated into a `RegistryAttestationQuorum`, requiring agreement on `registryUrl` and a canonical response-body hash.
- **Tier 3 — `single-attester`** (implemented, explicit fallback): one signed attestation, for registries that cannot support Tier 2. Always tagged `proofTier: 'single-attester'` and surfaced as reduced-assurance by `describeTrustLevel()` — never coerced to look like a quorum result.

The proof is bound to the credential by embedding it inside the same content-addressed metadata document that `metadata_hash` already points to (the contract's own doc comment describes `metadata_hash` as an "IPFS or content-addressed hash of credential metadata" — this decision uses that existing extension point rather than changing the `quorum_proof` contract). `buildMetadataDocumentV2()` produces `{ schemaVersion: 2, permitNumber, registryUrl, issuedDate, registryProof }`; its canonical SHA-256 is what goes on-chain as `metadata_hash`. Anyone holding the document later can recompute the hash, confirm it matches chain state, and independently re-verify every oracle signature and the freshness policy — no access to issuer infrastructure required.

Freshness is enforced via `fetchedAt` timestamps in each attestation and a `FreshnessPolicy.maxAgeSeconds`, checked against the *oldest* attestation in the quorum (the true data-currency bound), not the quorum-formation time.

Legacy issuers using the pre-existing v1 metadata hash (`sha256({permitNumber, registryUrl, issuedDate})`, no proof) continue to verify under `buildMetadataHashV1`/schema-version detection, but are surfaced to verifiers as `proofTier: 'legacy-unproven'`. See the migration path in [government-licensing-integration.md](../government-licensing-integration.md#migration-path-for-legacy-issuers).

## Consequences

### Positive
- Verifiers can independently re-verify, at any later time, that a specific TLS-backed response was actually returned by the registry and is bound to the specific `issue_credential` call.
- No silent trust downgrade: `proofTier` is a required, always-visible field on every proof object.
- No new runtime dependency — built on Node's native Ed25519 support and the existing quorum-threshold mental model already used elsewhere in QuorumProof.
- Forward-compatible with a genuine zkTLS tier without another breaking migration.

### Negative
- Tier 2 requires recruiting and operating independent oracle nodes per registry — an operational cost, not just a code change.
- Tier 2/3 do not reach the trust-minimization of true MPC-TLS; a colluding oracle majority (Tier 2) or a single dishonest attester (Tier 3) can still forge a proof.
- Adds a document schema version (`schemaVersion: 2`) that verifiers must branch on during the legacy migration window.

## Implementation Notes
See `api-server/src/services/registryAttestation.ts` for the reference implementation: attestation construction/signing, quorum formation with tamper and disagreement detection, independent re-verification, freshness checks, and the single-attester fallback. Tests in `api-server/tests/registryAttestation.test.ts` cover tamper detection, staleness rejection, and a full worked end-to-end example.

## References
- [ADR-001: FBA Trust Model](./adr-001-fba-trust-model.md) — the existing quorum-threshold trust model this proof's Tier 2 mirrors.
- [government-licensing-integration.md](../government-licensing-integration.md) — the integration protocol this ADR extends.
- [TLSNotary](https://tlsnotary.org/) / [DECO](https://arxiv.org/abs/1909.00938) — MPC-TLS approaches reserved as the future Tier 1.
