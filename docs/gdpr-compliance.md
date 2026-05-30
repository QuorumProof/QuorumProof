# GDPR Compliance Checklist

## Overview

This document outlines QuorumProof's approach to GDPR compliance, including data retention policies, the right to be forgotten, and data export functionality.

## Data Retention Policies

### Credential Data

- **Active Credentials**: Retained indefinitely while the credential is valid and not revoked
- **Revoked Credentials**: Retained for 90 days after revocation for audit purposes, then deleted
- **Expired Credentials**: Retained for 30 days after expiration, then deleted
- **Metadata**: Associated metadata is retained with the credential

### User Data

- **Account Information**: Retained while the account is active
- **Transaction History**: Retained for 7 years for compliance and audit purposes
- **Attestation Records**: Retained for the lifetime of the credential
- **Access Logs**: Retained for 90 days for security purposes

### Temporary Data

- **Proof Requests**: Retained for 24 hours after generation
- **Session Data**: Retained for the duration of the session (max 24 hours)
- **Cache Data**: Cleared automatically based on TTL (Time To Live)

## Right to Be Forgotten (Data Deletion)

### Scope

Users can request deletion of their personal data, subject to legal and contractual obligations.

### Deletion Process

1. **Request Submission**: User submits a deletion request through the API
2. **Verification**: System verifies user identity and authorization
3. **Validation**: System checks for legal holds or compliance requirements
4. **Deletion**: Personal data is deleted from all systems
5. **Confirmation**: User receives confirmation of deletion

### Data That Cannot Be Deleted

- **Blockchain Records**: Immutable on-chain data cannot be deleted (by design)
- **Audit Logs**: Required for compliance and cannot be deleted
- **Legal Holds**: Data subject to legal proceedings cannot be deleted
- **Contractual Obligations**: Data required by contract cannot be deleted

### Implementation

```rust
// Request deletion of user data
pub fn request_data_deletion(user_id: &Address) -> Result<(), Error> {
    // Verify user identity
    verify_user_authorization(user_id)?;
    
    // Check for legal holds
    if has_legal_hold(user_id) {
        return Err(Error::LegalHoldActive);
    }
    
    // Schedule deletion (not immediate)
    schedule_deletion(user_id, DELETION_DELAY_DAYS)?;
    
    // Log deletion request
    log_deletion_request(user_id);
    
    Ok(())
}

// Verify deletion eligibility
fn verify_deletion_eligibility(user_id: &Address) -> Result<(), Error> {
    // Check for active credentials
    if has_active_credentials(user_id) {
        return Err(Error::ActiveCredentialsExist);
    }
    
    // Check for pending transactions
    if has_pending_transactions(user_id) {
        return Err(Error::PendingTransactionsExist);
    }
    
    Ok(())
}
```

### Deletion Delay

- **Delay Period**: 30 days from request submission
- **Reason**: Allows for cancellation and ensures data integrity
- **Notification**: User is notified of pending deletion

## Data Export Functionality

### Export Scope

Users can export their personal data in a machine-readable format (JSON).

### Exportable Data

- **Credentials**: All issued credentials
- **Attestations**: All attestations received
- **Quorum Slices**: All quorum slice configurations
- **Transaction History**: All transactions involving the user
- **Profile Information**: User account details

### Export Format

```json
{
  "export_date": "2026-05-29T11:30:23Z",
  "user_id": "GXXXXXX...",
  "credentials": [
    {
      "id": 1,
      "type": 1001,
      "issuer": "GXXXXXX...",
      "issued_at": "2026-01-15T10:00:00Z",
      "metadata_hash": "0x..."
    }
  ],
  "attestations": [
    {
      "credential_id": 1,
      "attestor": "GXXXXXX...",
      "attested_at": "2026-01-16T10:00:00Z"
    }
  ],
  "quorum_slices": [
    {
      "id": 1,
      "threshold": 2,
      "attestors": ["GXXXXXX...", "GXXXXXX..."]
    }
  ],
  "transaction_history": [
    {
      "tx_hash": "0x...",
      "operation": "issue_credential",
      "timestamp": "2026-01-15T10:00:00Z",
      "status": "success"
    }
  ]
}
```

### Export Implementation

```typescript
// Request data export
async function requestDataExport(userId: string): Promise<string> {
  // Verify user identity
  await verifyUserIdentity(userId);
  
  // Collect all user data
  const credentials = await fetchUserCredentials(userId);
  const attestations = await fetchUserAttestations(userId);
  const slices = await fetchUserQuorumSlices(userId);
  const transactions = await fetchUserTransactions(userId);
  
  // Compile export
  const exportData = {
    export_date: new Date().toISOString(),
    user_id: userId,
    credentials,
    attestations,
    quorum_slices: slices,
    transaction_history: transactions
  };
  
  // Generate downloadable file
  const exportJson = JSON.stringify(exportData, null, 2);
  const blob = new Blob([exportJson], { type: 'application/json' });
  
  // Log export request
  await logDataExport(userId);
  
  return URL.createObjectURL(blob);
}

// Fetch user credentials
async function fetchUserCredentials(userId: string): Promise<Credential[]> {
  const credentials = await db.query(
    'SELECT * FROM credentials WHERE subject = $1',
    [userId]
  );
  return credentials;
}

// Fetch user attestations
async function fetchUserAttestations(userId: string): Promise<Attestation[]> {
  const attestations = await db.query(
    'SELECT * FROM attestations WHERE attestor = $1 OR credential_id IN (SELECT id FROM credentials WHERE subject = $1)',
    [userId, userId]
  );
  return attestations;
}
```

## Compliance Checklist

### Data Collection

- [ ] Obtain explicit consent before collecting personal data
- [ ] Provide clear privacy notices
- [ ] Document legal basis for data processing
- [ ] Implement data minimization principles

### Data Processing

- [ ] Implement access controls
- [ ] Encrypt sensitive data in transit and at rest
- [ ] Maintain audit logs of data access
- [ ] Implement data retention policies
- [ ] Conduct regular security assessments

### Data Subject Rights

- [ ] Implement right to access
- [ ] Implement right to rectification
- [ ] Implement right to erasure (right to be forgotten)
- [ ] Implement right to restrict processing
- [ ] Implement right to data portability
- [ ] Implement right to object
- [ ] Implement rights related to automated decision-making

### Data Protection

- [ ] Implement data protection by design
- [ ] Implement data protection by default
- [ ] Conduct Data Protection Impact Assessments (DPIA)
- [ ] Implement breach notification procedures
- [ ] Maintain Data Processing Agreements (DPA)

### Accountability

- [ ] Maintain records of processing activities
- [ ] Document compliance measures
- [ ] Conduct regular compliance audits
- [ ] Train staff on GDPR requirements
- [ ] Designate a Data Protection Officer (DPO) if required

## API Endpoints

### Request Data Export

```
GET /api/v1/user/data-export
Authorization: Bearer <token>

Response:
{
  "export_url": "https://...",
  "expires_at": "2026-05-30T11:30:23Z"
}
```

### Request Data Deletion

```
POST /api/v1/user/data-deletion
Authorization: Bearer <token>

Request:
{
  "reason": "User requested deletion"
}

Response:
{
  "deletion_scheduled": true,
  "deletion_date": "2026-06-28T11:30:23Z"
}
```

### Cancel Data Deletion

```
DELETE /api/v1/user/data-deletion
Authorization: Bearer <token>

Response:
{
  "deletion_cancelled": true
}
```

## Monitoring and Auditing

- **Deletion Requests**: Monitor all deletion requests and completions
- **Export Requests**: Track all data export requests
- **Access Logs**: Maintain logs of all data access
- **Compliance Reports**: Generate monthly compliance reports

## References

- [GDPR Official Text](https://gdpr-info.eu/)
- [GDPR Article 17 - Right to Erasure](https://gdpr-info.eu/art-17-gdpr/)
- [GDPR Article 20 - Right to Data Portability](https://gdpr-info.eu/art-20-gdpr/)
- [Data Protection Impact Assessment (DPIA)](https://gdpr-info.eu/art-35-gdpr/)
