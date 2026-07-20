# Government Licensing Body Integration

This document describes the protocol for government licensing bodies — engineering councils, medical boards, bar associations, and similar registries — to integrate with QuorumProof as verified issuers.

---

## Overview

A licensing body that integrates with QuorumProof can:

1. Register its Stellar address as an issuer of type `LicensingBody`.
2. Verify a candidate against its **official registry** before issuing an on-chain credential.
3. Attach a registry reference (permit number, licence ID) to the credential metadata so verifiers can cross-check.

The on-chain credential is only issued after the off-chain registry check succeeds. Third-party verifiers trust two things: the QuorumProof attestation quorum (Step 4 below), **and** the backing official record. That second half of the trust claim is backed by a **registry attestation proof** — see [ADR-005](./adr/adr-005-registry-attestation-proof.md) for the full design rationale. A plain, unproven HTTPS fetch is no longer sufficient: without a proof, nothing stops a dishonest or compromised issuer backend from issuing a credential the real registry would never support.

> **Terminology note:** this document uses "attestation" for two distinct things. A **registry fetch attestation** (Step 2) is an oracle's signed record of one HTTPS fetch against a licensing registry. An **on-chain credential attestation** (Step 4) is a government quorum member co-signing the issued credential itself. They are unrelated cryptographic artifacts serving different parts of the trust chain — don't conflate them.

---

## Integration Architecture

```
Candidate ──► Licensing Body Portal ──► Off-chain Registry Check
                                              │
                                    ┌─────────┴─────────┐
                                    │  Independent Oracle │
                                    │  Committee Fetch     │  (Tier 2, default)
                                    │  m-of-n signed        │
                                    │  attestations          │
                                    └─────────┬─────────┘
                                              │ forms Registry Attestation
                                              │ Quorum (RAQ), bound to a
                                              │ content-addressed metadata doc
                                              ▼ pass + fresh + tier check
                              QuorumProof Issuer Wallet
                                    │ issue_credential(metadata_hash = doc content hash)
                                    ▼
                           Soroban Ledger (immutable)
                                    │
                                    ▼
                          Third-party Verifier reads credential,
                          fetches the metadata doc by content hash,
                          independently re-verifies the registry proof
                          (signatures, agreement, freshness) and
                          cross-checks the permit number
```

---

## Step 1 — Register as a Licensing Issuer

The licensing body admin calls `register_issuer` on the `quorum_proof` contract, setting `issuer_type` to `LicensingBody` (type code `3`).

**Soroban CLI**
```bash
soroban contract invoke \
  --id $CONTRACT_QUORUM_PROOF \
  --network mainnet \
  --source-account admin_key.json \
  -- register_issuer \
  --admin $ADMIN_ADDRESS \
  --issuer $LICENSING_BODY_STELLAR_ADDRESS \
  --issuer-type LicensingBody
```

**JavaScript**
```javascript
const tx = buildTx(contract.call(
  'register_issuer',
  StellarSdk.nativeToScVal(adminAddress,          { type: 'address' }),
  StellarSdk.nativeToScVal(licensingBodyAddress,  { type: 'address' }),
  StellarSdk.nativeToScVal('LicensingBody',       { type: 'symbol' })
));
await submitSigned(tx, adminKeypair);
```

---

## Step 2 — Pre-issuance Registry Verification & Proof

Before calling `issue_credential`, the licensing body's system must verify the candidate's permit exists in the official registry **and produce a registry attestation proof** that a verifier can independently re-check later. This replaces the old "just `fetch()` it" approach — a bare fetch proves nothing to anyone outside the issuer's own process.

The reference implementation lives in [`api-server/src/services/registryAttestation.ts`](../api-server/src/services/registryAttestation.ts) (tests: [`api-server/tests/registryAttestation.test.ts`](../api-server/tests/registryAttestation.test.ts)).

### Proof Tiers

Every proof object carries an explicit `proofTier`. A verifier always sees the real tier — a lower tier is never relabeled to look like a stronger one (`describeTrustLevel()` enforces this).

| Tier | `proofTier` value | Status | Assurance |
|------|--------------------|--------|-----------|
| 1 | `zktls-v1` | Reserved, not yet implemented | MPC-TLS proof of the raw TLS session (TLSNotary/DECO-style). No party unilaterally controls the transcript. |
| 2 | `oracle-committee` | **Implemented, default** | `m`-of-`n` independently-operated oracles each fetch the registry and sign what they saw; a threshold must agree. |
| 3 | `single-attester` | Implemented, **explicit fallback only** | One signed fetch, no independent corroboration. For registries that structurally cannot support multi-party fetching (IP-allowlisted or mTLS-restricted to one client identity). |
| — | `legacy-unproven` | Deprecated, migration window only | No registry proof at all — the pre-existing plain-fetch behavior. See [Migration Path](#migration-path-for-legacy-issuers). |

Tier 3 exists so that a registry with real technical constraints doesn't get silently downgraded to "unproven" — but it is never presented to a verifier as equivalent to Tier 2. Use Tier 3 only when Tier 2 is genuinely impossible for that registry, and prefer negotiating additional oracle access (e.g. an IP-allowlist entry for a second, independently-operated fetcher) over defaulting to it.

### Reference Implementation — Tier 2 (oracle committee)

Each independent oracle runs this against the same registry endpoint:

```typescript
import {
  signRegistryFetchAttestation,
  type RegistryFetchAttestationInput,
} from '../api-server/src/services/registryAttestation.js';

async function oracleFetchAndSign(
  permitNumber: string,
  oracleId: string,
  oraclePrivateKeyPem: string
) {
  const registryUrl = `https://registry.example.gov/api/permits/${encodeURIComponent(permitNumber)}`;
  const response = await fetch(registryUrl, {
    headers: { Authorization: `Bearer ${process.env.REGISTRY_API_KEY}` },
  });
  const responseBody = await response.text();

  if (!response.ok) {
    throw new Error(`Registry lookup failed: ${response.status} ${response.statusText}`);
  }

  const record = JSON.parse(responseBody);
  if (record.status !== 'active') {
    throw new Error(`Permit ${permitNumber} is not active (status: ${record.status})`);
  }

  const input: RegistryFetchAttestationInput = {
    oracleId,
    registryUrl,
    requestMethod: 'GET',
    requestHeaders: { Accept: 'application/json' }, // never include the bearer token
    responseStatus: response.status,
    responseBody,
    tlsCertFingerprint: getPeerCertificateFingerprint(response), // sha256 of the leaf cert DER
    tlsCertNotAfter: getPeerCertificateExpiry(response),
    fetchedAt: new Date().toISOString(),
  };

  return signRegistryFetchAttestation(input, oraclePrivateKeyPem);
}
```

The issuer's backend collects attestations from the registered oracle set and forms a quorum:

```typescript
import {
  formRegistryAttestationQuorum,
  checkProofFreshness,
  assertMinimumTier,
  type OracleIdentity,
} from '../api-server/src/services/registryAttestation.js';

const ORACLE_REGISTRY: OracleIdentity[] = [
  { oracleId: 'gov-registrar', publicKeyPem: GOV_ORACLE_PUBKEY_PEM },
  { oracleId: 'quorumproof-witness', publicKeyPem: QP_ORACLE_PUBKEY_PEM },
  { oracleId: 'third-party-auditor', publicKeyPem: AUDIT_ORACLE_PUBKEY_PEM },
];
const QUORUM_THRESHOLD = 2; // 2-of-3

const attestations = await Promise.all(
  ORACLE_REGISTRY.map((o) => requestAttestationFromOracle(o.oracleId, permitNumber))
);

const quorum = formRegistryAttestationQuorum(attestations, ORACLE_REGISTRY, QUORUM_THRESHOLD);
const proof = { proofTier: 'oracle-committee' as const, quorum };

// Freshness policy: refuse to issue against a stale registry read.
checkProofFreshness(proof, { maxAgeSeconds: 300 });

// Refuse silent downgrade: this licence type requires at least Tier 2.
assertMinimumTier(proof, 'oracle-committee');
```

`formRegistryAttestationQuorum` rejects unregistered oracles, duplicate attestations from the same oracle, and attestations with invalid signatures; if fewer than `threshold` valid, agreeing attestations remain, it throws `RegistryQuorumError` rather than forming a weakened quorum silently.

### Reference Implementation — Tier 3 (single-attester fallback)

Only for registries where Tier 2 is not achievable:

```typescript
import { buildSingleAttesterProof } from '../api-server/src/services/registryAttestation.js';

const proof = buildSingleAttesterProof(
  fetchInput, // same shape as the oracle input above
  'registrar-solo',
  registrarPrivateKeyPem
);
// proof.proofTier === 'single-attester' — always visible to downstream verifiers.
```

### Binding the Proof to the Credential

The proof is bound to the credential by embedding it in the same content-addressed document `metadata_hash` already points to (the `quorum_proof` contract's own doc comment describes `metadata_hash` as an "IPFS or content-addressed hash of credential metadata" — this uses that existing extension point rather than changing the contract):

```typescript
import {
  buildMetadataDocumentV2,
  hashMetadataDocument,
  RegistryProofStore,
} from '../api-server/src/services/registryAttestation.js';

const document = buildMetadataDocumentV2(
  { permitNumber: record.permitNumber, registryUrl, issuedDate: record.issuedDate },
  proof
);

// Publish off-chain (content-addressed store, IPFS, or any retrievable location
// keyed by the document's own hash) so verifiers can fetch it later.
const store = new RegistryProofStore(); // production: a durable, publicly-fetchable store
const contentHash = store.publish(document);
const metadataHash = Buffer.from(contentHash, 'hex'); // this is what goes on-chain
```

---

## Step 3 — Issue the Credential

After the registry check, proof quorum, freshness check, and tier check all pass, issue the credential on-chain using the content hash computed above as `metadata_hash`:

```typescript
async function issueGovernmentCredential(
  permitNumber: string,
  candidateStellarAddress: string,
  licenceType: number  // e.g. 6 = Professional Engineering Licence
) {
  const record = await verifyAgainstRegistry(permitNumber);
  const proof = await buildOracleCommitteeProof(record, permitNumber); // Step 2
  const document = buildMetadataDocumentV2(
    { permitNumber: record.permitNumber, registryUrl, issuedDate: record.issuedDate },
    proof
  );
  const contentHash = registryProofStore.publish(document);
  const metadataHash = Buffer.from(contentHash, 'hex');

  const tx = buildTx(contract.call(
    'issue_credential',
    StellarSdk.nativeToScVal(licensingBodyAddress,       { type: 'address' }),
    StellarSdk.nativeToScVal(candidateStellarAddress,    { type: 'address' }),
    StellarSdk.nativeToScVal(licenceType,                { type: 'u32' }),
    StellarSdk.nativeToScVal(metadataHash,               { type: 'bytes' })
  ));

  const credentialId = await submitSigned(tx, licensingBodyKeypair);
  console.log(`Issued credential #${credentialId} for permit ${permitNumber}, proof tier: ${proof.proofTier}`);
  return credentialId;
}
```

---

## Step 4 — Attestation by Government Quorum Members

Credentials issued by licensing bodies should be attested by at least two independent government signatories to form a quorum slice. This prevents a single compromised key from issuing fraudulent credentials. This is a separate mechanism from the registry fetch attestations in Step 2 (see the terminology note above) — it attests to the on-chain credential itself, not to the registry response.

```bash
# 1 — Create a quorum slice for the licensing body (one-time setup)
soroban contract invoke \
  --id $CONTRACT_QUORUM_PROOF --network mainnet \
  --source-account licensing_admin.json \
  -- create_quorum_slice \
  --issuer $LICENSING_BODY_STELLAR_ADDRESS \
  --threshold 2 \
  --members "[\"$REGISTRAR_1\",\"$REGISTRAR_2\",\"$REGISTRAR_3\"]"

# 2 — Each registrar attests after verifying the permit independently
soroban contract invoke \
  --id $CONTRACT_QUORUM_PROOF --network mainnet \
  --source-account registrar_1.json \
  -- attest_credential \
  --attestor $REGISTRAR_1 \
  --credential-id <CREDENTIAL_ID> \
  --slice-id <SLICE_ID>
```

---

## Step 5 — Verification by Third Parties

Verifiers check three things: the on-chain state, the registry proof binding, and freshness.

```typescript
import {
  verifyMetadataHashBinding,
  verifyRegistryProof,
  checkProofFreshness,
  describeTrustLevel,
  assertMinimumTier,
} from '../api-server/src/services/registryAttestation.js';

async function verifyLicence(
  credentialId: bigint,
  registryProofStore: RegistryProofStore, // or a fetch against wherever the issuer published it
  oracleRegistry: OracleIdentity[]
): Promise<boolean> {
  // 1. On-chain check
  const credential = await simulateCall('get_credential', [credentialId]);
  if (credential.revoked) return false;
  const quorumOk = await simulateCall('is_quorum_reached', [credentialId, SLICE_ID]);
  if (!quorumOk) return false;

  // 2. Fetch the metadata document the on-chain metadata_hash points to, and
  //    confirm it actually hashes to that value (detects a substituted document).
  const document = registryProofStore.fetch(Buffer.from(credential.metadata_hash).toString('hex'));
  if (!document || !verifyMetadataHashBinding(Buffer.from(credential.metadata_hash), document)) {
    return false;
  }

  // 3. Legacy credentials (no registry proof) are handled per the migration
  //    policy below rather than treated as a hard failure or silently trusted.
  if (!('registryProof' in document)) {
    return handleLegacyUnprovenCredential(credential, document);
  }

  // 4. Independently re-verify the proof itself — signatures, oracle
  //    agreement, and threshold — from scratch. Throws on any tamper.
  try {
    verifyRegistryProof(document.registryProof, oracleRegistry);
    checkProofFreshness(document.registryProof, { maxAgeSeconds: MAX_PROOF_AGE_SECONDS });
    assertMinimumTier(document.registryProof, REQUIRED_TIER_FOR_THIS_LICENCE_TYPE);
  } catch {
    return false;
  }

  // 5. Surface the real trust tier to the caller/UI — never hide a
  //    single-attester or legacy result behind a generic "verified" badge.
  const trust = describeTrustLevel(document.registryProof);
  if (trust.reducedAssurance) {
    console.warn(`Credential ${credentialId} proof tier: ${trust.label}`);
  }

  return true;
}
```

---

## Migration Path for Legacy Issuers

Issuers integrated before this proof mechanism existed used a plain `fetch()` and a v1 metadata hash (`sha256({permitNumber, registryUrl, issuedDate})`, no proof attached — see `buildMetadataHashV1` in `registryAttestation.ts`). Those credentials remain on-chain and verifiable as `legacy-unproven`; this section defines how issuers move off that state.

| Phase | Window | Requirement | Verifier behavior |
|-------|--------|-------------|--------------------|
| 1 — Compatibility | Now – T+90 days | No change required. Existing v1-hash issuers continue operating. | `verifyLicence` treats missing `registryProof` as `legacy-unproven`: on-chain checks still run, but the UI/API must surface a visible "registry fetch unproven" warning — never a plain "verified" result. |
| 2 — Minimum bar | T+90 – T+180 days | New issuer registrations must produce at least a **Tier 3** (`single-attester`) proof. Existing issuers must migrate at least one credential type to Tier 2 or Tier 3. | Newly-issued legacy-tier credentials are rejected by `assertMinimumTier` at verification time for licence types that have opted into enforcement. |
| 3 — Enforced | T+180+ days | Tier 3 is the minimum for all licence types; **Tier 2 is required** for the high-assurance types (Professional Engineering, Medical, Legal — codes 6–8 below). | Verifiers call `assertMinimumTier(proof, requiredTierForLicenceType)` unconditionally; failing it is a hard verification failure, not a warning. |

Migrating an existing issuer is additive, not a breaking cutover: keep issuing v1-hash credentials for already-open workflows while switching new `issue_credential` calls to `buildMetadataDocumentV2`. Nothing about the on-chain contract changes — `metadata_hash` remains an opaque content address in both schemes, so old and new credentials coexist on the same ledger. Verifiers distinguish them by attempting to resolve the fetched document's `schemaVersion` field (absent/legacy vs. `2`).

---

## Credential Types for Licensing Bodies

Use the following reserved type codes for government-issued credentials:

| Code | Credential Type |
|------|----------------|
| 6 | Professional Engineering Licence |
| 7 | Medical Practitioner Registration |
| 8 | Legal Practitioner (Bar) Admission |
| 9 | Financial Services Provider Licence |
| 10 | Pharmacy Practice Certificate |

Additional codes can be requested from the QuorumProof admin.

---

## Revocation Protocol

When a permit is revoked or suspended by the licensing body:

```bash
soroban contract invoke \
  --id $CONTRACT_QUORUM_PROOF --network mainnet \
  --source-account licensing_admin.json \
  -- revoke_credential \
  --issuer $LICENSING_BODY_STELLAR_ADDRESS \
  --credential-id <CREDENTIAL_ID>
```

The licensing body should also call `revoke_proof` on the `zk_verifier` contract to invalidate any cached ZK claims:

```bash
soroban contract invoke \
  --id $CONTRACT_ZK_VERIFIER --network mainnet \
  --source-account admin_key.json \
  -- revoke_proof \
  --admin $ADMIN_ADDRESS \
  --credential-id <CREDENTIAL_ID> \
  --reason "Permit revoked by licensing board — misconduct finding"
```

---

## Security Considerations

- **Registry API key** must be stored server-side and never exposed to frontend clients, and must never appear in a signed `RegistryFetchAttestation` (only non-secret request headers like `Accept` are hashed into the attestation).
- **Issuer keypair** must be stored in HSM or equivalent secure key management. Never in environment variables on shared infrastructure. The same applies to each oracle's Ed25519 signing key in the Tier 2 committee.
- **Oracle independence** is what Tier 2's security rests on: oracles must be operated by genuinely separate parties (different infrastructure, different operators) or the "threshold of independent fetchers" guarantee collapses to a single point of failure. A single operator running all `n` oracles provides no more assurance than Tier 3.
- **`metadata_hash` binding**: the hash commits to the entire metadata document (permit fields + registry proof), and `verifyMetadataHashBinding` recomputes it in constant time — this closes the gap where a verifier previously had no way to confirm the off-chain permit reference actually matched what was fetched.
- **Freshness**: a valid signature only proves the registry said something at `fetchedAt`, not that it's still true. Always call `checkProofFreshness` with a policy appropriate to the licence type before trusting a proof — a permit that was active five minutes ago at fetch time may already be suspended.
- **No silent downgrade**: `describeTrustLevel` and `proofTier` must always be surfaced to whatever consumes the verification result (UI, API response, audit log). Treating a `single-attester` or `legacy-unproven` result identically to `oracle-committee` in downstream code is itself a security regression this design is meant to prevent.
- Rotate the licensing body's Stellar keypair via `update_issuer` if it is ever compromised, and re-issue all affected credentials. Rotate individual oracle keys the same way — `formRegistryAttestationQuorum`/`verifyRegistryAttestationQuorum` take the current `OracleIdentity[]` as an explicit argument, so key rotation is just updating that registry, not a contract change.

---

## References

- [ADR-005: Registry Attestation Proof for Licensing Body Integrations](./adr/adr-005-registry-attestation-proof.md) — design rationale, alternatives considered, and tier definitions.
- [`api-server/src/services/registryAttestation.ts`](../api-server/src/services/registryAttestation.ts) — reference implementation of attestation signing, quorum formation/verification, freshness checks, and the metadata document binding.
- [`api-server/tests/registryAttestation.test.ts`](../api-server/tests/registryAttestation.test.ts) — tamper detection, staleness rejection, and a full worked end-to-end example.
- [api-endpoint-examples.md](./api-endpoint-examples.md) — concrete curl/JS examples for all contract calls
- [contract-upgrade-guide.md](./contract-upgrade-guide.md) — how to handle breaking changes in future versions
- [error-codes.md](./error-codes.md) — full list of `ContractError` codes
- [deployment-guide.md](./deployment-guide.md) — deploying to testnet and mainnet
