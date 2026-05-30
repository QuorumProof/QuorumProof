# Automated Backup System

## Overview

QuorumProof includes an automated backup system that creates daily encrypted snapshots of contract state and stores them in S3 for disaster recovery.

---

## Architecture

```
Daily Cron (2 AM UTC)
        │
        ▼
GitHub Actions Workflow
        │
        ├─→ Backup Script (backup.sh)
        │   ├─→ Fetch contract state
        │   ├─→ Encrypt with AES-256
        │   └─→ Upload to S3
        │
        └─→ Verification Script (verify_snapshot.sh)
            └─→ Validate backup integrity
```

---

## Quick Start

### 1. Configure AWS Credentials

Store these as GitHub secrets:

```bash
# GitHub Settings → Secrets and variables → Actions

BACKUP_S3_BUCKET=quorumproof-backups
BACKUP_ENCRYPTION_KEY=<strong-random-key>
CONTRACT_QUORUM_PROOF_TESTNET=<testnet-contract-id>
CONTRACT_QUORUM_PROOF_MAINNET=<mainnet-contract-id>
```

### 2. Manual Backup

```bash
# Backup without encryption
./scripts/backup.sh

# Backup with encryption
export BACKUP_ENCRYPTION_KEY="your-encryption-key"
./scripts/backup.sh --encrypt

# Backup and upload to S3
./scripts/backup.sh --encrypt --upload quorumproof-backups
```

### 3. Verify Backup

```bash
./scripts/verify_snapshot.sh backups/daily/quorumproof-2026-05-29_14-30-00.json
```

---

## Backup Contents

Each backup includes:

```json
{
  "backup_date": "2026-05-29_14-30-00",
  "network": "testnet",
  "contract_id": "CAAAAAAA...",
  "credential_count": 42,
  "slice_count": 5,
  "credentials": [
    {
      "id": 1,
      "subject": "GXXXXXX...",
      "issuer": "GXXXXXX...",
      "credential_type": "MechanicalEngineeringDegree",
      "metadata_hash": "0x1234...",
      "revoked": false,
      "expires_at": 1747569600
    }
  ],
  "slices": [
    {
      "id": 1,
      "creator": "GXXXXXX...",
      "attestors": ["GXXXXXX...", "GXXXXXX..."],
      "threshold": 2
    }
  ]
}
```

---

## Encryption

### Key Management

- **Algorithm**: AES-256-CBC with PBKDF2 key derivation
- **Storage**: GitHub Secrets (encrypted at rest)
- **Rotation**: Every 90 days or after suspected compromise

### Encrypt Backup

```bash
export BACKUP_ENCRYPTION_KEY="your-strong-key"
./scripts/backup.sh --encrypt
```

### Decrypt Backup

```bash
export BACKUP_ENCRYPTION_KEY="your-strong-key"
./scripts/restore_from_backup.sh --backup backups/daily/quorumproof-2026-05-29.json.enc
```

---

## S3 Storage

### Bucket Configuration

```bash
# Create bucket
aws s3 mb s3://quorumproof-backups

# Enable versioning
aws s3api put-bucket-versioning \
  --bucket quorumproof-backups \
  --versioning-configuration Status=Enabled

# Enable encryption
aws s3api put-bucket-encryption \
  --bucket quorumproof-backups \
  --server-side-encryption-configuration '{
    "Rules": [{
      "ApplyServerSideEncryptionByDefault": {
        "SSEAlgorithm": "AES256"
      }
    }]
  }'

# Set lifecycle policy (retain 90 days)
aws s3api put-bucket-lifecycle-configuration \
  --bucket quorumproof-backups \
  --lifecycle-configuration '{
    "Rules": [{
      "Id": "DeleteOldBackups",
      "Status": "Enabled",
      "Expiration": {"Days": 90},
      "Filter": {"Prefix": "quorumproof/"}
    }]
  }'
```

### List Backups

```bash
# List all backups
aws s3 ls s3://quorumproof-backups/quorumproof/ --recursive

# List testnet backups
aws s3 ls s3://quorumproof-backups/quorumproof/testnet/

# Download a backup
aws s3 cp s3://quorumproof-backups/quorumproof/testnet/quorumproof-2026-05-29.json.enc .
```

---

## Restore Procedure

### From Local Backup

```bash
# Restore from encrypted backup
export BACKUP_ENCRYPTION_KEY="your-encryption-key"
./scripts/restore_from_backup.sh \
  --backup backups/daily/quorumproof-2026-05-29.json.enc \
  --contract CAAAAAAA... \
  --network testnet
```

### From S3 Backup

```bash
# Download backup from S3
aws s3 cp s3://quorumproof-backups/quorumproof/testnet/quorumproof-2026-05-29.json.enc .

# Restore
export BACKUP_ENCRYPTION_KEY="your-encryption-key"
./scripts/restore_from_backup.sh \
  --backup quorumproof-2026-05-29.json.enc \
  --contract CAAAAAAA... \
  --network testnet
```

---

## Verification

### Backup Integrity

```bash
# Verify backup structure
./scripts/verify_snapshot.sh backups/daily/quorumproof-2026-05-29.json

# Output:
# ✓ JSON is well-formed
# ✓ Credential count matches on-chain (42 == 42)
# ✓ Slice count matches on-chain (5 == 5)
# ✓ No missing credential IDs
```

### Restore Verification

After restore, verify the contract state:

```bash
# Check credential count
soroban contract invoke \
  --id CAAAAAAA... \
  --network testnet \
  -- get_credential_count

# Check slice count
soroban contract invoke \
  --id CAAAAAAA... \
  --network testnet \
  -- get_slice_count

# Spot-check a credential
soroban contract invoke \
  --id CAAAAAAA... \
  --network testnet \
  -- get_credential --credential-id 1
```

---

## Automated Workflow

### Daily Backup Schedule

The `.github/workflows/backup.yml` workflow runs daily at 2 AM UTC:

1. Backs up testnet contract
2. Backs up mainnet contract
3. Encrypts both backups
4. Uploads to S3
5. Verifies integrity
6. Stores artifacts (90-day retention)

### Manual Trigger

```bash
# Trigger backup workflow manually
gh workflow run backup.yml
```

### Monitoring

Check backup status in GitHub Actions:

```bash
# List recent backup runs
gh run list --workflow backup.yml --limit 10

# View latest backup logs
gh run view --log $(gh run list --workflow backup.yml --limit 1 --json databaseId -q '.[0].databaseId')
```

---

## Disaster Recovery

### Scenario: Contract State Corruption

1. **Pause the contract** (if still accessible)
   ```bash
   soroban contract invoke --id CAAAAAAA... -- pause --admin <ADMIN>
   ```

2. **Redeploy contract** (if necessary)
   ```bash
   ./scripts/deploy_testnet.sh
   ```

3. **Restore from backup**
   ```bash
   export BACKUP_ENCRYPTION_KEY="your-key"
   ./scripts/restore_from_backup.sh \
     --backup backups/daily/quorumproof-2026-05-29.json.enc \
     --contract <NEW_CONTRACT_ID> \
     --network testnet
   ```

4. **Verify restoration**
   ```bash
   cargo test
   ```

5. **Unpause contract**
   ```bash
   soroban contract invoke --id <NEW_CONTRACT_ID> -- unpause --admin <ADMIN>
   ```

---

## Retention Policy

| Backup Type | Retention | Storage | Frequency |
|---|---|---|---|
| Local backups | 7 days | `backups/daily/` | Daily |
| S3 backups | 90 days | AWS S3 | Daily |
| GitHub artifacts | 90 days | GitHub Actions | Daily |
| Snapshots | Permanent | Blockchain | Continuous |

---

## Troubleshooting

### Backup fails with "CONTRACT_QUORUM_PROOF not set"

```bash
# Set environment variable
export CONTRACT_QUORUM_PROOF=CAAAAAAA...
./scripts/backup.sh
```

### Encryption fails with "BACKUP_ENCRYPTION_KEY not set"

```bash
# Set encryption key
export BACKUP_ENCRYPTION_KEY="your-strong-key"
./scripts/backup.sh --encrypt
```

### S3 upload fails with "Access Denied"

1. Verify AWS credentials are configured
2. Check S3 bucket permissions
3. Verify IAM user has `s3:PutObject` permission

### Restore fails with "Invalid backup file"

1. Verify backup file is not corrupted
2. Check encryption key is correct
3. Verify backup was created with same contract

---

## Best Practices

1. **Test restores regularly** — Run restore drills monthly on testnet
2. **Rotate encryption keys** — Every 90 days or after suspected compromise
3. **Monitor backup status** — Check GitHub Actions workflow runs daily
4. **Verify S3 backups** — Spot-check S3 backups monthly
5. **Document procedures** — Keep runbook updated with current contract IDs
6. **Secure encryption keys** — Store in GitHub Secrets, never in code
7. **Test failover** — Verify RPC failover endpoint works

---

## Related Documentation

- [Disaster Recovery](disaster-recovery.md) — Full recovery procedures
- [Audit Log Format](audit-log-format.md) — Backup contents reference
- [Deployment Guide](deployment-guide.md) — Contract deployment
