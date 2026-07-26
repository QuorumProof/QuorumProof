# QuorumProof Interoperability Guide

## Overview

QuorumProof is designed for cross-border credential verification and can integrate with national licensing bodies, professional associations, and other credential issuers. This guide documents the API contracts and integration patterns for connecting external credential systems.

---

## Table of Contents

1. [Integration Architecture](#integration-architecture)
2. [API Contracts](#api-contracts)
3. [Authentication & Authorization](#authentication--authorization)
4. [Credential Data Mapping](#credential-data-mapping)
5. [Integration Patterns](#integration-patterns)
6. [Error Handling](#error-handling)
7. [Testing & Validation](#testing--validation)
8. [Security Considerations](#security-considerations)

---

## Integration Architecture

```
┌──────────────────────────────────────┐
│   National Licensing Body / DB       │
│   (e.g., Medical Board, Bar Assoc.)  │
└────────────────┬─────────────────────┘
                 │
                 ▼
┌──────────────────────────────────────┐
│   Integration Adapter Layer          │
│   (Data Transformation & Mapping)    │
└────────────────┬─────────────────────┘
                 │
                 ▼
┌──────────────────────────────────────┐
│   QuorumProof API Gateway            │
│   (Issue, Verify, Revoke)            │
└────────────────┬─────────────────────┘
                 │
                 ▼
┌──────────────────────────────────────┐
│   Stellar Smart Contract             │
│   (Credential Storage & Verification)│
└──────────────────────────────────────┘
```

---

## API Contracts

### 1. Credential Issuance Interface

**Endpoint:** `POST /credentials/issue`

**Request Body:**
```json
{
  "credential_type": "professional_license",
  "issuer_id": "medical-board-us",
  "subject": {
    "name": "John Doe",
    "email": "john@example.com",
    "identifier": "license_123456",
    "jurisdiction": "US-CA"
  },
  "claims": {
    "license_number": "MD123456",
    "specialization": "Cardiology",
    "issue_date": "2020-01-15",
    "expiry_date": "2025-01-15",
    "status": "active"
  },
  "metadata": {
    "source_system": "california_medical_board",
    "source_record_id": "CMB-20200115-001",
    "verification_url": "https://cmb.ca.gov/verify/MD123456"
  }
}
```

**Response (200 OK):**
```json
{
  "credential_id": "cred_abc123def456",
  "issuer_id": "medical-board-us",
  "subject_address": "GXXXX...",
  "status": "issued",
  "issued_at": "2024-07-25T10:30:00Z",
  "sbt_address": "GXXXX...",
  "verification_hash": "0x1234567890abcdef"
}
```

**Error Responses:**
- `400 Bad Request` — Invalid credential format or missing required fields
- `401 Unauthorized` — Issuer not authenticated
- `409 Conflict` — Credential already exists for this subject

---

### 2. Credential Verification Interface

**Endpoint:** `GET /credentials/{credential_id}/verify`

**Query Parameters:**
```
credential_id  — Credential ID to verify
proof_type     — Optional: "zk_proof" or "standard" (default: standard)
```

**Response (200 OK):**
```json
{
  "credential_id": "cred_abc123def456",
  "valid": true,
  "issuer_id": "medical-board-us",
  "subject_address": "GXXXX...",
  "claims": {
    "license_number": "MD123456",
    "specialization": "Cardiology",
    "status": "active"
  },
  "verification": {
    "verified_at": "2024-07-25T10:35:00Z",
    "verification_method": "quorum_consensus",
    "quorum_slice_size": 5,
    "attestations_received": 4
  }
}
```

---

### 3. Credential Revocation Interface

**Endpoint:** `POST /credentials/{credential_id}/revoke`

**Request Body:**
```json
{
  "revocation_reason": "license_expired",
  "revocation_notes": "Annual renewal not submitted",
  "effective_date": "2024-07-25"
}
```

**Response (200 OK):**
```json
{
  "credential_id": "cred_abc123def456",
  "status": "revoked",
  "revoked_at": "2024-07-25T11:00:00Z",
  "revocation_reason": "license_expired"
}
```

---

### 4. Credential Renewal/Update Interface

**Endpoint:** `PATCH /credentials/{credential_id}`

**Request Body:**
```json
{
  "claims": {
    "expiry_date": "2026-01-15",
    "status": "active"
  },
  "metadata": {
    "renewal_date": "2024-07-25",
    "renewal_source": "california_medical_board"
  }
}
```

**Response (200 OK):**
```json
{
  "credential_id": "cred_abc123def456",
  "status": "renewed",
  "updated_at": "2024-07-25T11:05:00Z"
}
```

---

### 5. Batch Credential Operations

**Endpoint:** `POST /credentials/batch`

**Request Body:**
```json
{
  "operation": "issue",
  "credentials": [
    { /* credential object 1 */ },
    { /* credential object 2 */ },
    { /* credential object N */ }
  ]
}
```

**Response (200 OK):**
```json
{
  "batch_id": "batch_xyz789",
  "operation": "issue",
  "total": 100,
  "succeeded": 98,
  "failed": 2,
  "results": [
    { "credential_id": "cred_abc...", "status": "issued" },
    { "credential_id": "cred_def...", "status": "issued" },
    { "error": "Invalid format", "index": 50 }
  ]
}
```

---

## Authentication & Authorization

### API Key Authentication

All requests must include a valid API key in the header:

```bash
curl -X POST https://api.quorumproof.io/credentials/issue \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{...}'
```

### Rate Limiting

- **Default Limit:** 100 requests per hour per API key
- **Burst Limit:** 10 requests per second
- **Response Header:** `X-RateLimit-Remaining: 42`

### Issuer Registration

Before integration, issuers must register:

```bash
POST /issuers/register
{
  "issuer_name": "California Medical Board",
  "jurisdiction": "US-CA",
  "issuer_address": "GXXXX...",
  "public_key": "0x...",
  "supported_credential_types": ["professional_license"],
  "contact_email": "integration@cmb.ca.gov"
}
```

---

## Credential Data Mapping

### Standard Credential Schema

```json
{
  "credential_type": "string",
  "issuer_id": "string",
  "subject": {
    "name": "string",
    "email": "string",
    "identifier": "string",
    "jurisdiction": "string"
  },
  "claims": {
    "key": "value"
  },
  "metadata": {
    "source_system": "string",
    "source_record_id": "string",
    "verification_url": "string"
  },
  "issued_at": "ISO8601",
  "expires_at": "ISO8601",
  "status": "active | revoked | expired | suspended"
}
```

### Credential Type Registry

| Type | Description | Typical Claims |
|------|-------------|-----------------|
| `professional_license` | Professional qualifications | license_number, specialization, expiry_date |
| `educational_credential` | Degrees and certifications | institution, degree_type, graduation_date |
| `identity_verification` | Government-issued identity | document_type, country, issue_date |
| `business_registration` | Company/business licenses | registration_number, business_type, jurisdiction |
| `criminal_record_clearance` | Absence of criminal record | clearance_level, validity_period |

---

## Integration Patterns

### Pattern 1: Periodic Sync (Pull)

**Use Case:** National licensing body has a database that's periodically synced to QuorumProof.

```bash
#!/bin/bash
# Daily sync script
CREDENTIALS=$(fetch_from_national_database)

for credential in $CREDENTIALS; do
  curl -X POST https://api.quorumproof.io/credentials/issue \
    -H "Authorization: Bearer $API_KEY" \
    -d "$credential"
done
```

### Pattern 2: Real-time Events (Push)

**Use Case:** Licensing body pushes credential updates to QuorumProof via webhooks.

```json
POST /webhooks/credential-events
{
  "event_type": "credential.issued",
  "timestamp": "2024-07-25T10:30:00Z",
  "credential": { /* credential object */ }
}
```

### Pattern 3: Query-on-Demand

**Use Case:** QuorumProof queries national databases in real-time during verification.

```bash
GET /verify/license?license_number=MD123456&issuer=california_medical_board
```

### Pattern 4: Distributed Ledger Bridge

**Use Case:** Cross-chain credential verification between QuorumProof and other blockchain networks.

```rust
pub fn bridge_external_credential(
    external_credential_hash: String,
    chain_id: u32,
) -> Result<CredentialId, Error> {
    // Verify proof from external chain
    // Issue local credential
}
```

---

## Error Handling

### Common Error Codes

| Code | HTTP Status | Description |
|------|-------------|-------------|
| `INVALID_CREDENTIAL` | 400 | Credential format invalid |
| `ISSUER_NOT_FOUND` | 404 | Issuer ID not registered |
| `CREDENTIAL_EXISTS` | 409 | Credential already issued |
| `UNAUTHORIZED` | 401 | API key invalid or expired |
| `RATE_LIMIT_EXCEEDED` | 429 | Too many requests |
| `CONTRACT_PAUSED` | 503 | Contract is paused for maintenance |
| `INSUFFICIENT_ATTESTATIONS` | 422 | Not enough quorum attestations |

### Error Response Format

```json
{
  "error": {
    "code": "INSUFFICIENT_ATTESTATIONS",
    "message": "Credential requires 3 attestations, only 1 received",
    "details": {
      "required": 3,
      "received": 1
    }
  },
  "request_id": "req_abc123"
}
```

---

## Testing & Validation

### Integration Checklist

- [ ] Issuer account registered and API key issued
- [ ] Test credentials issued successfully
- [ ] Verification returns expected claims
- [ ] Revocation processed correctly
- [ ] Error handling validated for all error codes
- [ ] Rate limiting tested
- [ ] Batch operations tested
- [ ] Jurisdiction mapping validated

### Test Credentials

Use these test credentials for development:

```json
{
  "credential_type": "professional_license",
  "issuer_id": "test-issuer",
  "subject": {
    "name": "Test User",
    "email": "test@example.com",
    "identifier": "test_001",
    "jurisdiction": "US-TEST"
  }
}
```

---

## Security Considerations

### 1. API Key Management

- Store API keys securely (use environment variables or secrets manager)
- Rotate keys quarterly
- Immediately revoke compromised keys
- Use different keys for development, staging, and production

### 2. Data Validation

- Always validate credential data on both client and server
- Enforce jurisdiction-specific validation rules
- Verify issuer authorization for credential types

### 3. Transport Security

- All API calls must use HTTPS/TLS 1.3+
- Implement certificate pinning for critical integrations
- Use mutual TLS (mTLS) for high-security partnerships

### 4. Audit Logging

- Log all credential operations (issue, verify, revoke)
- Include issuer, timestamp, and subject identifiers
- Retain audit logs for compliance periods

### 5. Privacy & GDPR

- Implement PII encryption in transit and at rest
- Support credential holder deletion requests
- Enable credential holder consent workflows
- Document data processing agreements

### 6. Compliance

- Validate issuer authorization for each jurisdiction
- Implement compliance checks before credential issuance
- Maintain audit trail for regulatory inspections

---

## Support & Contact

For integration support, contact:
- **Email:** integrations@quorumproof.io
- **Documentation:** https://docs.quorumproof.io
- **Issues:** https://github.com/QuorumProof/QuorumProof/issues
- **Slack:** #integrations channel on QuorumProof Slack workspace
