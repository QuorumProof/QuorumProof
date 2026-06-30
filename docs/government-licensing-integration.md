# Government Licensing Body Integration

This document describes the protocol for government licensing bodies — engineering councils, medical boards, bar associations, and similar registries — to integrate with QuorumProof as verified issuers.

---

## Overview

A licensing body that integrates with QuorumProof can:

1. Register its Stellar address as an issuer of type `LicensingBody`.
2. Verify a candidate against its **official registry** before issuing an on-chain credential.
3. Attach a registry reference (permit number, licence ID) to the credential metadata so verifiers can cross-check.

The on-chain credential is only issued after the off-chain registry check succeeds. This means third-party verifiers trust both the QuorumProof attestation quorum **and** the backing official record.

---

## Integration Architecture

```
Candidate ──► Licensing Body Portal ──► Off-chain Registry Check
                                              │ pass
                                              ▼
                              QuorumProof Issuer Wallet
                                    │ issue_credential()
                                    ▼
                           Soroban Ledger (immutable)
                                    │
                                    ▼
                          Third-party Verifier reads credential
                          and cross-checks permit number in registry
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

## Step 2 — Pre-issuance Registry Verification

Before calling `issue_credential`, the licensing body's system must verify the candidate's permit exists in the official registry. This check happens off-chain using the registry's own API.

### Reference Implementation

```typescript
interface RegistryRecord {
  permitNumber: string;
  holderName: string;
  licenceType: string;
  issuedDate: string;
  expiryDate: string | null;
  status: 'active' | 'suspended' | 'revoked';
}

async function verifyAgainstRegistry(
  permitNumber: string,
  stellarAddress: string
): Promise<RegistryRecord> {
  // Replace with your licensing body's actual API endpoint
  const response = await fetch(
    `https://registry.example.gov/api/permits/${encodeURIComponent(permitNumber)}`,
    { headers: { Authorization: `Bearer ${process.env.REGISTRY_API_KEY}` } }
  );

  if (!response.ok) {
    throw new Error(`Registry lookup failed: ${response.status} ${response.statusText}`);
  }

  const record: RegistryRecord = await response.json();

  if (record.status !== 'active') {
    throw new Error(`Permit ${permitNumber} is not active (status: ${record.status})`);
  }

  return record;
}
```

### Metadata Hash Construction

The credential's `metadata_hash` must commit to the registry reference so the link is tamper-evident:

```typescript
import { createHash } from 'crypto';

function buildMetadataHash(permitNumber: string, registryUrl: string, issuedDate: string): Buffer {
  const payload = JSON.stringify({ permitNumber, registryUrl, issuedDate });
  return createHash('sha256').update(payload).digest();
}
```

---

## Step 3 — Issue the Credential

After the registry check passes, issue the credential on-chain:

```typescript
async function issueGovernmentCredential(
  permitNumber: string,
  candidateStellarAddress: string,
  licenceType: number  // e.g. 6 = Professional Engineering Licence
) {
  const record = await verifyAgainstRegistry(permitNumber, candidateStellarAddress);
  const metadataHash = buildMetadataHash(
    record.permitNumber,
    'https://registry.example.gov',
    record.issuedDate
  );

  const tx = buildTx(contract.call(
    'issue_credential',
    StellarSdk.nativeToScVal(licensingBodyAddress,       { type: 'address' }),
    StellarSdk.nativeToScVal(candidateStellarAddress,    { type: 'address' }),
    StellarSdk.nativeToScVal(licenceType,                { type: 'u32' }),
    StellarSdk.nativeToScVal(metadataHash,               { type: 'bytes' })
  ));

  const credentialId = await submitSigned(tx, licensingBodyKeypair);
  console.log(`Issued credential #${credentialId} for permit ${permitNumber}`);
  return credentialId;
}
```

---

## Step 4 — Attestation by Government Quorum Members

Credentials issued by licensing bodies should be attested by at least two independent government signatories to form a quorum slice. This prevents a single compromised key from issuing fraudulent credentials.

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

Verifiers check two things:

1. **On-chain:** Call `get_credential` and confirm `revoked == false` and quorum is reached.
2. **Off-chain:** Decode `metadata_hash`, extract the permit number, and query the public registry to confirm the permit is still active.

```typescript
async function verifyLicence(credentialId: bigint): Promise<boolean> {
  // 1. On-chain check
  const credential = await simulateCall('get_credential', [credentialId]);
  if (credential.revoked) return false;
  const quorumOk = await simulateCall('is_quorum_reached', [credentialId, SLICE_ID]);
  if (!quorumOk) return false;

  // 2. Off-chain registry cross-check (optional but recommended)
  // Verifier reconstructs permit number from their out-of-band channel or
  // from the credential holder presenting their permit PDF.
  // Compare SHA-256(permit + registry url + issued date) against metadata_hash.

  return true;
}
```

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

- **Registry API key** must be stored server-side and never exposed to frontend clients.
- **Issuer keypair** must be stored in HSM or equivalent secure key management. Never in environment variables on shared infrastructure.
- The `metadata_hash` links the on-chain credential to the off-chain permit, but verifiers must independently query the registry — the hash alone does not prove the permit is still active at query time.
- Rotate the licensing body's Stellar keypair via `update_issuer` if it is ever compromised, and re-issue all affected credentials.

---

## References

- [api-endpoint-examples.md](./api-endpoint-examples.md) — concrete curl/JS examples for all contract calls
- [contract-upgrade-guide.md](./contract-upgrade-guide.md) — how to handle breaking changes in future versions
- [error-codes.md](./error-codes.md) — full list of `ContractError` codes
- [deployment-guide.md](./deployment-guide.md) — deploying to testnet and mainnet
