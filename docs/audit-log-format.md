# Audit Log Format & Documentation

## Overview

QuorumProof maintains an immutable audit trail of all credential and attestation events on the Stellar blockchain. This document describes the audit log format, event types, parsing examples, and retention policy.

All events are emitted as Stellar contract events and indexed by the Prometheus exporter for monitoring and alerting.

---

## Audit Events

### 1. CredentialIssued

Emitted when a new credential is issued.

**Event Structure:**
```json
{
  "event_type": "CredentialIssued",
  "timestamp": 1716033600,
  "credential_id": 1,
  "subject": "GXXXXXX...",
  "issuer": "GXXXXXX...",
  "credential_type": "MechanicalEngineeringDegree",
  "metadata_hash": "0x1234...",
  "expires_at": 1747569600
}
```

**Fields:**
- `credential_id` (u64): Unique credential identifier
- `subject` (Address): Credential holder's Stellar address
- `issuer` (Address): Issuing institution's address
- `credential_type` (String): Type of credential (e.g., "MechanicalEngineeringDegree", "ProfessionalLicense")
- `metadata_hash` (Bytes): Hash of credential metadata (IPFS CID or similar)
- `expires_at` (u64): Unix timestamp of expiration (0 = no expiration)

**Metrics Updated:**
- `quorumproof_credentials_issued_total` (counter +1)

---

### 2. CredentialRevoked

Emitted when a credential is revoked by the issuer.

**Event Structure:**
```json
{
  "event_type": "CredentialRevoked",
  "timestamp": 1716034200,
  "credential_id": 1,
  "revoked_by": "GXXXXXX...",
  "reason": "Fraud detected"
}
```

**Fields:**
- `credential_id` (u64): ID of revoked credential
- `revoked_by` (Address): Address that initiated revocation (issuer or admin)
- `reason` (String): Optional reason for revocation

**Metrics Updated:**
- `quorumproof_credentials_revoked_total` (counter +1)

---

### 3. QuorumSliceCreated

Emitted when a new quorum slice is created.

**Event Structure:**
```json
{
  "event_type": "QuorumSliceCreated",
  "timestamp": 1716034800,
  "slice_id": 1,
  "creator": "GXXXXXX...",
  "attestors": ["GXXXXXX...", "GXXXXXX...", "GXXXXXX..."],
  "threshold": 2
}
```

**Fields:**
- `slice_id` (u64): Unique slice identifier
- `creator` (Address): Address that created the slice
- `attestors` (Vec<Address>): List of attestor addresses
- `threshold` (u32): Minimum number of attestations required

**Metrics Updated:**
- `quorumproof_active_slices_total` (gauge +1)

---

### 4. AttestorAdded

Emitted when an attestor is added to a quorum slice.

**Event Structure:**
```json
{
  "event_type": "AttestorAdded",
  "timestamp": 1716035400,
  "slice_id": 1,
  "attestor": "GXXXXXX...",
  "weight": 1
}
```

**Fields:**
- `slice_id` (u64): ID of the slice
- `attestor` (Address): Address of the new attestor
- `weight` (u32): Voting weight of the attestor

---

### 5. AttestationCreated

Emitted when an attestor signs a credential.

**Event Structure:**
```json
{
  "event_type": "AttestationCreated",
  "timestamp": 1716036000,
  "credential_id": 1,
  "slice_id": 1,
  "attestor": "GXXXXXX...",
  "signature": "0xabcd..."
}
```

**Fields:**
- `credential_id` (u64): ID of attested credential
- `slice_id` (u64): ID of the quorum slice
- `attestor` (Address): Address of the attestor
- `signature` (Bytes): Cryptographic signature

**Metrics Updated:**
- `quorumproof_attestations_total` (counter +1)
- `quorumproof_attestation_success_rate` (gauge recalculated)

---

### 6. ProofRequested

Emitted when a ZK proof is requested for conditional verification.

**Event Structure:**
```json
{
  "event_type": "ProofRequested",
  "timestamp": 1716036600,
  "credential_id": 1,
  "claim_type": "HasMechanicalEngineeringDegree",
  "requester": "GXXXXXX..."
}
```

**Fields:**
- `credential_id` (u64): ID of credential being verified
- `claim_type` (String): Type of claim (e.g., "HasMechanicalEngineeringDegree")
- `requester` (Address): Address requesting the proof

**Metrics Updated:**
- `quorumproof_proof_requests_total` (counter +1)

---

### 7. ProofVerified

Emitted when a ZK proof is successfully verified.

**Event Structure:**
```json
{
  "event_type": "ProofVerified",
  "timestamp": 1716037200,
  "credential_id": 1,
  "claim_type": "HasMechanicalEngineeringDegree",
  "verifier": "GXXXXXX..."
}
```

**Fields:**
- `credential_id` (u64): ID of verified credential
- `claim_type` (String): Type of claim verified
- `verifier` (Address): Address that verified the proof

---

### 8. ContractPaused

Emitted when the contract is paused by an admin.

**Event Structure:**
```json
{
  "event_type": "ContractPaused",
  "timestamp": 1716037800,
  "paused_by": "GXXXXXX...",
  "reason": "Security audit in progress"
}
```

**Fields:**
- `paused_by` (Address): Admin address that paused the contract
- `reason` (String): Reason for pause

**Metrics Updated:**
- `quorumproof_contract_paused` (gauge = 1)

---

### 9. ContractUnpaused

Emitted when the contract is unpaused.

**Event Structure:**
```json
{
  "event_type": "ContractUnpaused",
  "timestamp": 1716038400,
  "unpaused_by": "GXXXXXX..."
}
```

**Fields:**
- `unpaused_by` (Address): Admin address that unpaused the contract

**Metrics Updated:**
- `quorumproof_contract_paused` (gauge = 0)

---

### 10. RateLimitExceeded

Emitted when a rate limit is exceeded for an address.

**Event Structure:**
```json
{
  "event_type": "RateLimitExceeded",
  "timestamp": 1716039000,
  "address": "GXXXXXX...",
  "operation": "issue_credential",
  "limit": 100,
  "window_seconds": 3600
}
```

**Fields:**
- `address` (Address): Address that exceeded the limit
- `operation` (String): Operation that was rate-limited
- `limit` (u32): Rate limit threshold
- `window_seconds` (u32): Time window for the limit

**Metrics Updated:**
- `quorumproof_rate_limit_hits_total` (counter +1, labelled by `address`)

---

## Log Parsing Examples

### Example 1: Parse Credential Issuance Events

**Bash + jq:**
```bash
# Extract all CredentialIssued events from Prometheus metrics
curl -s http://localhost:9090/api/v1/query \
  'quorumproof_credentials_issued_total' | \
  jq '.data.result[] | {timestamp: .timestamp, value: .value}'
```

**Python:**
```python
import json
from datetime import datetime

# Parse audit log JSON export
with open('audit_log.json') as f:
    events = json.load(f)

# Filter credential issuance events
issued = [e for e in events if e['event_type'] == 'CredentialIssued']

for event in issued:
    print(f"Credential {event['credential_id']} issued to {event['subject']}")
    print(f"  Issuer: {event['issuer']}")
    print(f"  Type: {event['credential_type']}")
    print(f"  Expires: {datetime.fromtimestamp(event['expires_at'])}")
```

### Example 2: Audit Trail for a Specific Credential

**Bash:**
```bash
# Get all events related to credential ID 42
CRED_ID=42

curl -s http://localhost:9090/api/v1/query \
  "quorumproof_credential_events{credential_id=\"$CRED_ID\"}" | \
  jq '.data.result[] | {event: .metric.event_type, timestamp: .timestamp}'
```

**Python:**
```python
import json

def audit_trail(credential_id, events):
    """Return all events for a credential in chronological order."""
    trail = [e for e in events if e.get('credential_id') == credential_id]
    return sorted(trail, key=lambda x: x['timestamp'])

# Example usage
with open('audit_log.json') as f:
    events = json.load(f)

trail = audit_trail(42, events)
for event in trail:
    print(f"{event['timestamp']}: {event['event_type']}")
```

### Example 3: Detect Revocation Patterns

**Python:**
```python
import json
from collections import defaultdict

def revocation_analysis(events):
    """Analyze revocation patterns."""
    revocations = defaultdict(list)
    
    for event in events:
        if event['event_type'] == 'CredentialRevoked':
            issuer = event['revoked_by']
            revocations[issuer].append({
                'credential_id': event['credential_id'],
                'reason': event.get('reason', 'Unknown'),
                'timestamp': event['timestamp']
            })
    
    return revocations

# Example usage
with open('audit_log.json') as f:
    events = json.load(f)

revocations = revocation_analysis(events)
for issuer, revoked_creds in revocations.items():
    print(f"{issuer}: {len(revoked_creds)} revocations")
    for cred in revoked_creds:
        print(f"  - Credential {cred['credential_id']}: {cred['reason']}")
```

### Example 4: Attestation Coverage Report

**Python:**
```python
import json
from collections import defaultdict

def attestation_coverage(events):
    """Calculate attestation coverage per credential."""
    credentials = {}
    attestations = defaultdict(list)
    
    for event in events:
        if event['event_type'] == 'CredentialIssued':
            credentials[event['credential_id']] = event
        elif event['event_type'] == 'AttestationCreated':
            attestations[event['credential_id']].append(event['attestor'])
    
    coverage = {}
    for cred_id, cred in credentials.items():
        coverage[cred_id] = {
            'subject': cred['subject'],
            'attestations': len(attestations.get(cred_id, [])),
            'attestors': attestations.get(cred_id, [])
        }
    
    return coverage

# Example usage
with open('audit_log.json') as f:
    events = json.load(f)

coverage = attestation_coverage(events)
for cred_id, info in coverage.items():
    print(f"Credential {cred_id}: {info['attestations']} attestations")
    for attestor in info['attestors']:
        print(f"  - {attestor}")
```

---

## Retention Policy

### On-Chain Events (Stellar Blockchain)

- **Retention**: Permanent (immutable ledger)
- **Access**: Via Stellar RPC / Horizon API
- **Query**: `soroban contract invoke -- get_events --contract <ID>`

### Prometheus Metrics

- **Retention**: 30 days (configurable in `monitoring/docker-compose.yml`)
- **Storage**: Local time-series database
- **Backup**: Export via Prometheus API before expiration

### Snapshot Backups

- **Retention**: 90 days (configurable in CI/CD)
- **Storage**: GitHub Actions artifacts + off-chain S3/GCS
- **Frequency**: Daily via cron job

### Audit Log Exports

- **Retention**: As configured by operator
- **Storage**: Off-chain (S3, GCS, or local filesystem)
- **Format**: JSON (see examples above)

---

## Exporting Audit Logs

### Export from Prometheus

```bash
# Export all metrics for a time range
curl -s 'http://localhost:9090/api/v1/query_range' \
  --data-urlencode 'query=quorumproof_*' \
  --data-urlencode 'start=1716000000' \
  --data-urlencode 'end=1716086400' \
  --data-urlencode 'step=60s' | jq . > audit_export.json
```

### Export from Stellar RPC

```bash
# Get all contract events
soroban contract invoke \
  --id <CONTRACT_ID> \
  --network testnet \
  -- get_events \
  --start-ledger 0 \
  --limit 10000 > events.json
```

### Export from Snapshots

```bash
# Snapshots are already in JSON format
cat backups/snapshots/quorumproof-2026-05-29.json | jq . > audit_export.json
```

---

## Compliance & Auditing

### Regulatory Requirements

QuorumProof audit logs support compliance with:
- **SOC 2 Type II**: Complete audit trail of all state changes
- **GDPR**: Credential holder can request audit trail for their credentials
- **ISO 27001**: Immutable event log for security incident investigation

### Audit Queries

**Who issued a credential?**
```bash
jq '.[] | select(.event_type == "CredentialIssued" and .credential_id == 42)' audit_log.json
```

**When was a credential revoked?**
```bash
jq '.[] | select(.event_type == "CredentialRevoked" and .credential_id == 42)' audit_log.json
```

**How many attestations does a credential have?**
```bash
jq '[.[] | select(.event_type == "AttestationCreated" and .credential_id == 42)] | length' audit_log.json
```

**What is the full audit trail for a credential?**
```bash
jq '[.[] | select(.credential_id == 42)] | sort_by(.timestamp)' audit_log.json
```

---

## Troubleshooting

| Issue | Cause | Solution |
|---|---|---|
| No events in Prometheus | Exporter not running | Check `docker compose ps` and restart if needed |
| Events missing from snapshot | Snapshot taken during contract pause | Unpause contract and re-run snapshot |
| Audit trail gaps | RPC endpoint downtime | Check RPC logs; use fallback endpoint |
| Metrics not updating | Prometheus scrape interval too long | Reduce `SCRAPE_INTERVAL_SECONDS` in exporter config |

---

## Related Documentation

- [Monitoring Guide](monitoring-guide.md) — Prometheus & Grafana setup
- [Disaster Recovery](disaster-recovery.md) — Backup and restore procedures
- [Threat Model](threat-model.md) — Security considerations for audit logs
