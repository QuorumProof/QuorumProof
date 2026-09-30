# Secrets Management

**Issue #1656** — Secrets are hardcoded. This document describes the secrets
management architecture for QuorumProof: how secrets are stored, rotated, audited,
and consumed by application services.

## Problem

Prior to this change, secrets (Stellar deploy keys, database URLs, JWT signing
keys) were stored in plaintext environment files, CI variables, or Kubernetes
`Secret` objects with no rotation, no access audit trail, and no central
inventory. This is a high-severity security finding.

## Solution

QuorumProof secrets are managed via **AWS Secrets Manager** using a
**HashiCorp Vault-compatible path convention**. The architecture supports a
future migration to a self-hosted Vault cluster with minimal application changes.

---

## Secret Path Convention

All secrets follow the Vault KV-v2 path structure:

```
quorumproof/<environment>/<service>/<key>
```

| Path | Contents |
|------|----------|
| `quorumproof/<env>/stellar/deploy-key` | Stellar account secret key for contract deployments |
| `quorumproof/<env>/database/url` | PostgreSQL connection URL |
| `quorumproof/<env>/api-server/jwt-secret` | HS256 JWT signing secret |
| `quorumproof/<env>/api-server/webhook-signing-key` | HMAC-SHA256 webhook signing key |
| `quorumproof/<env>/monitoring/pagerduty-routing-key` | PagerDuty Events API v2 routing key |
| `quorumproof/<env>/monitoring/slack-webhook-url` | Slack incoming webhook URL |

---

## Tooling

### `scripts/secrets_manager.sh`

A single script for all secrets operations. Supports both AWS Secrets Manager
(default) and HashiCorp Vault (set `VAULT_ADDR` + `VAULT_TOKEN`).

```bash
# Check all required secrets exist
ENVIRONMENT=production ./scripts/secrets_manager.sh check

# Get a secret value
./scripts/secrets_manager.sh get quorumproof/production/stellar/deploy-key

# Set (create or update) a secret
./scripts/secrets_manager.sh set \
  quorumproof/production/api-server/jwt-secret \
  "$(openssl rand -hex 32)"

# Trigger immediate rotation
./scripts/secrets_manager.sh rotate quorumproof/production/database/url

# List all secrets in an environment
./scripts/secrets_manager.sh list quorumproof/production

# View audit log (last 24h)
./scripts/secrets_manager.sh audit --since 24h
```

### `infra/terraform/modules/secrets/`

Terraform module that creates all secret objects in AWS Secrets Manager,
configures KMS encryption, sets up automatic rotation, and applies
resource-based access policies.

```hcl
module "secrets" {
  source = "../../modules/secrets"

  environment            = var.environment
  kms_key_arn            = module.kms.key_arn
  rotation_lambda_arn    = module.rotation_lambda.arn
  rotation_days          = 30
  allowed_principal_arns = [module.ecs_task_role.arn]
}
```

---

## Secret Rotation

### Automatic rotation

The `secrets` Terraform module configures automatic rotation for credential secrets
(`stellar/deploy-key`, `database/url`, `api-server/jwt-secret`) when
`rotation_lambda_arn` is provided.

Rotation intervals:
- Stellar deploy key: 30 days (configurable via `rotation_days`)
- Database URL (password rotation): 30 days
- JWT signing secret: 30 days

### Manual rotation

```bash
# Immediately rotate a specific secret
./scripts/secrets_manager.sh rotate quorumproof/production/stellar/deploy-key
```

### Zero-downtime JWT rotation

JWT secret rotation requires dual-key support during the transition window.
The API server reads the current and previous versions from Secrets Manager
and accepts tokens signed with either key during a 15-minute overlap window:

```bash
# 1. Generate new secret and store as next version
NEW_SECRET=$(openssl rand -hex 32)
./scripts/secrets_manager.sh set quorumproof/production/api-server/jwt-secret-next "$NEW_SECRET"

# 2. Deploy the new API server version that reads both keys
# 3. Wait for old tokens to expire (≥ JWT max TTL)
# 4. Promote: rename next → current
./scripts/secrets_manager.sh set quorumproof/production/api-server/jwt-secret "$NEW_SECRET"
```

---

## Audit Logging

Every secrets operation (`get`, `set`, `rotate`, `list`) is appended as a JSON
Line to `$AUDIT_LOG_FILE` (default: `/tmp/quorumproof-secrets-audit.log`).

### Log format

```json
{
  "timestamp": "2026-09-28T08:00:00Z",
  "action": "get",
  "secret_path": "quorumproof/production/stellar/deploy-key",
  "status": "ok",
  "actor": "arn:aws:iam::123456789012:role/quorumproof-ci",
  "environment": "production",
  "hostname": "ci-runner-abc123"
}
```

### Viewing the audit log

```bash
# All entries
./scripts/secrets_manager.sh audit

# Last 24 hours
./scripts/secrets_manager.sh audit --since 24h

# Last 7 days
./scripts/secrets_manager.sh audit --since 7d
```

### CloudTrail integration

AWS CloudTrail automatically records all `GetSecretValue`, `PutSecretValue`,
and `RotateSecret` API calls for Secrets Manager. Combined with the script-level
audit log, this provides two independent audit trails.

To query CloudTrail for secrets access:

```bash
aws cloudtrail lookup-events \
  --lookup-attributes AttributeKey=EventSource,AttributeValue=secretsmanager.amazonaws.com \
  --start-time "$(date -u -d '24 hours ago' +%Y-%m-%dT%H:%M:%SZ)" \
  --query 'Events[].{Time:EventTime,Who:Username,What:EventName,Resource:Resources[0].ResourceName}' \
  --output table
```

---

## Kubernetes Integration

Secrets are injected into pods via the AWS Secrets Manager CSI driver or by the
CI pipeline creating Kubernetes `Secret` objects at deploy time (never stored in
Git).

### External Secrets Operator (recommended)

```yaml
# k8s/external-secret.yaml
apiVersion: external-secrets.io/v1beta1
kind: ExternalSecret
metadata:
  name: quorumproof-api-server-env
  namespace: quorumproof
spec:
  refreshInterval: 1h
  secretStoreRef:
    name: aws-secrets-manager
    kind: SecretStore
  target:
    name: quorumproof-api-server-env
  data:
    - secretKey: STELLAR_SECRET_KEY
      remoteRef:
        key: quorumproof/production/stellar/deploy-key
    - secretKey: DATABASE_URL
      remoteRef:
        key: quorumproof/production/database/url
    - secretKey: JWT_SECRET
      remoteRef:
        key: quorumproof/production/api-server/jwt-secret
```

### CI/CD pipeline injection

In GitHub Actions, retrieve secrets immediately before use and never store them
in environment files:

```yaml
- name: Inject secrets
  run: |
    STELLAR_KEY=$(aws secretsmanager get-secret-value \
      --secret-id quorumproof/production/stellar/deploy-key \
      --query SecretString --output text)
    echo "::add-mask::$STELLAR_KEY"
    echo "STELLAR_SECRET_KEY=$STELLAR_KEY" >> "$GITHUB_ENV"
```

---

## Security Controls

| Control | Implementation |
|---------|----------------|
| Encryption at rest | AWS KMS (customer-managed key via `kms_key_arn`) |
| Encryption in transit | TLS enforced by AWS Secrets Manager API |
| Access control | IAM resource-based policies on each secret |
| Audit trail | CloudTrail + script-level JSON audit log |
| Rotation | Automatic via Lambda + immediate via `rotate` command |
| Secret recovery | 7-day recovery window before permanent deletion |
| No plaintext in Git | All secret values stored in Secrets Manager only |
| Masking in CI | `::add-mask::` annotation on retrieved values |

---

## Migration from Hardcoded Secrets

1. Identify all hardcoded secrets: `grep -r "STELLAR_SECRET\|DATABASE_URL\|JWT_SECRET" .env* scripts/ k8s/`
2. For each secret, run: `./scripts/secrets_manager.sh set quorumproof/<env>/<service>/<key> "<value>"`
3. Remove from `.env` files and replace with Secrets Manager lookups.
4. Update Kubernetes `Secret` manifests to use External Secrets Operator.
5. Rotate all migrated secrets immediately to invalidate the old values.
6. Verify with: `ENVIRONMENT=production ./scripts/secrets_manager.sh check`

---

## See Also

- [`infra/terraform/modules/secrets/`](../infra/terraform/modules/secrets/) — Terraform module
- [`scripts/secrets_manager.sh`](../scripts/secrets_manager.sh) — CLI operations tool
- [`docs/security-best-practices.md`](security-best-practices.md) — broader security guide
- [`docs/issuer-security-checklist.md`](issuer-security-checklist.md) — secrets checklist for issuers
