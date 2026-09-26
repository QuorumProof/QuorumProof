# Log Retention and Archival Policy (Issue #1653)

Logs used to be kept indefinitely on the log volume and in Loki. This policy
defines how long each class of log is kept, where it lives at each stage, how
archived logs are retrieved, and how the policy maps to compliance
requirements.

## Log classes and retention

| Class | Examples | Hot (queryable) | Archive (cold) | Total |
|---|---|---|---|---|
| Debug | `level=debug` api-server lines | 7 days (Loki) | not archived from Loki; file copies follow *Application* | 7 days hot |
| Application | info / warn api-server logs, ECS task logs | 30 days (Loki / CloudWatch) | 7 years | 7 years |
| Error | `level=error|fatal` | 90 days (Loki) | 7 years | 7 years |
| Audit / security | modules `audit`, `auth-audit`, `credential-audit`, `gdpr`, `privilege-escalation`, `region-failover` | 90 days (Loki) | 7 years, **WORM** (Object Lock) | 7 years |
| System | host syslog | 14 days (Loki) | — | 14 days |
| Infrastructure | VPC flow logs | 30 days (CloudWatch) | — | 30 days |
| On-chain events | contract events | permanent (Stellar ledger) | n/a | permanent |

Metrics (Prometheus) are retained 30 days (`--storage.tsdb.retention.time`)
and are out of scope for archival.

## Storage tiers

```
 write ──► hot ───────────────► archive (S3) ───────────────────────────────► delete
          Loki / CloudWatch     STANDARD → STANDARD_IA → GLACIER_IR → DEEP_ARCHIVE
          7–90 days             0 d        30 d          90 d         365 d    2555 d
```

| Tier | Retrieval time | Relative cost |
|---|---|---|
| Loki / CloudWatch | seconds (LogQL / Logs Insights) | highest |
| S3 STANDARD / STANDARD_IA | immediate | medium |
| S3 GLACIER_IR | milliseconds | low |
| S3 DEEP_ARCHIVE | ~12 h (Standard) / ~48 h (Bulk) | lowest (~$1/TB-month) |

## Implementation

### AWS (production / staging)

`infra/terraform/modules/log-archive`:

* CloudWatch log groups (api-server, created by `modules/compute`) have
  `retention_in_days = 30`; before expiry every event is streamed through a
  **subscription filter → Kinesis Data Firehose → S3** under
  `cloudwatch/YYYY/MM/DD/`.
* The archive bucket's **lifecycle rule** performs the tier transitions and
  deletes objects after 2555 days (7 years). Terraform validation refuses
  `expire_after_days < 365`.
* **S3 Object Lock** (`COMPLIANCE` in production, 365-day default retention)
  makes archived logs immutable; a bucket policy additionally denies manual
  deletes except for the break-glass role.
* Archives are encrypted with the environment KMS key and accessible only over
  TLS.

### Docker Compose / self-hosted

* **Loki** (`monitoring/loki/loki.yml`) enforces the hot retention with
  `retention_period` (30 d default) and per-stream `retention_stream`
  overrides; the compactor applies deletions. Promtail
  (`monitoring/loki/promtail.yml`) labels each line with `level` and `audit`
  so the overrides can match.
* The **`log-archiver`** service (`monitoring/docker-compose.yml`) runs
  `scripts/log_archive.sh --loop 3600`, which hourly:
  1. rotates `/var/log/quorumproof/*.log` (copy-truncate at 100 MB or daily) and gzips,
  2. archives rotated files to `s3://$LOG_ARCHIVE_BUCKET/logs/<host>/YYYY/MM/DD/`
     (`GLACIER_IR`) — or to the `quorumproof-log-archive` volume when no bucket
     is configured — recording a SHA-256 manifest,
  3. deletes local rotated files older than 7 days **only if archived**,
  4. expires local-volume archives older than 7 years, honouring `LEGAL_HOLD`.

Configure via `LOG_ARCHIVE_BUCKET`, `LOG_LOCAL_RETENTION_DAYS`,
`LOG_ARCHIVE_RETENTION_DAYS`, `LOG_ROTATE_MAX_MB` (see the script header).
When archiving to S3, apply the same lifecycle rule as the Terraform module
to the bucket.

## Retrieval

```bash
scripts/log_retrieve.sh --from 2026-03-01 --to 2026-03-03 \
  --reason "INC-482 credential revocation investigation" \
  --grep '"credential_id":1234'
```

* Objects in `DEEP_ARCHIVE` are restored first (`--tier Standard|Bulk`); the
  script exits `3` while restores are pending — re-run it later with the same
  arguments to download.
* Checksums are verified against the manifest (local archive) or the
  `sha256` object metadata (S3).
* `--source cloudwatch` retrieves the Firehose archives from AWS deployments.
* Every retrieval is recorded with user, date range and mandatory `--reason`
  in `<output>/retrievals.log`; S3 data events in CloudTrail provide the
  tamper-proof record.
* For SQL queries over large ranges, restore to STANDARD and use the Athena
  workgroup created by the module (`terraform output regions` →
  `athena_workgroup`).

## Legal hold

* **S3**: `aws s3api put-object-legal-hold --bucket <archive> --key <key> --legal-hold Status=ON`.
  Objects under legal hold are neither transitioned-to-delete nor deletable
  until the hold is removed.
* **Local archive**: add the file name to `$LOG_ARCHIVE_DIR/LEGAL_HOLD`.

## Compliance mapping

| Requirement | How this policy satisfies it |
|---|---|
| **SOC 2 CC7.2 / CC7.3** — monitor and retain security event logs | Audit/security logs hot for 90 days, archived 7 years, alerting on failover and critical events |
| **ISO 27001 A.8.15 (A.12.4.1-3)** — event logging, protection of log information | Encryption at rest (KMS) and in transit (TLS-only policy), Object Lock (WORM), deny-delete bucket policy, retrieval audit trail |
| **PCI DSS 10.5.1** — retain audit trail ≥ 12 months, 3 months immediately available | 90 days hot for audit logs; 7-year archive; GLACIER_IR within the first year keeps retrieval immediate |
| **GDPR Art. 5(1)(c)/(e)** — data minimisation, storage limitation | Debug logs (most likely to contain incidental personal data) expire after 7 days; fixed, documented maximum of 7 years; api-server logs must not contain credential payloads (see [gdpr-compliance.md](./gdpr-compliance.md)) |
| **GDPR Art. 17** — erasure | Personal data is not written to logs by design; where an erasure request requires it, the break-glass role may delete specific archived objects (Governance-mode Object Lock in staging; Compliance mode in production requires waiting for lock expiry — record the request and justification) |
| **Legal hold / e-discovery** | S3 legal hold and local `LEGAL_HOLD` list suspend deletion |

### Review

This policy is reviewed annually by the security owner, and whenever a new
log source or regulation applies. Changes to retention periods must be made in
code (Terraform variables, `loki.yml`, script defaults) **and** in this
document in the same PR.
