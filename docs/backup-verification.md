# Automated Backup Verification

> Issue #1649. Extends the backup system described in
> [backup-system.md](./backup-system.md). Recovery procedures that consume
> these backups are in [disaster-recovery.md](./disaster-recovery.md).

A backup that has never been restored is a hope, not a backup. Before this
change the daily workflow exported and encrypted contract state, but the
verification step only looked for plaintext `*.json` files — encrypted
`*.json.enc` backups (the production default) were never actually checked.
This document describes the automated pipeline that now proves every backup is
recoverable before it counts.

---

## Components

| Script | Role |
|---|---|
| `scripts/backup.sh` | Exports contract state, optionally encrypts (AES-256-CBC) and uploads to S3. Unchanged. |
| `scripts/verify_backup.sh` | Content checks on a plaintext backup: JSON validity, required keys, counts, required fields, age, restore dry-run. Unchanged. |
| `scripts/automated_backup.sh` | **New.** Orchestrates export → checksum → decrypt → verify → remote re-download → retention, and records the result in `backups/manifest.json`. |
| `scripts/check_backup_integrity.sh` | **New.** Re-validates every retained backup against the manifest, detects stale schedules and unaccounted files, optional deep restore dry-run. |
| `.github/workflows/backup.yml` | Runs `automated_backup.sh` then `check_backup_integrity.sh --deep` daily at 02:00 UTC per network. |

---

## Automated backup pipeline

```
automated_backup.sh
  1. Export       backup.sh --network N [--encrypt] [--upload bucket]
  2. Checksum     sha256 → <artifact>.sha256
  3. Decrypt      openssl enc -d (same params as restore_from_backup.sh)
  4. Content      verify_backup.sh <plaintext> --dry-run-restore
  5. Remote       aws s3 cp back down, sha256 must match step 2;
                  upload <artifact>.sha256 sidecar next to the object
  6. Retention    prune local backups older than BACKUP_RETENTION_DAYS
  → manifest.json entry { status: "verified" | "failed", sha256, s3_uri, ... }
```

Any failing step aborts the run, writes a `failed` manifest entry with the
reason, posts to `BACKUP_NOTIFY_WEBHOOK` if configured, and exits 1 (which
fails the workflow). Retention runs **only after** the new backup has
verified, so a bad run never deletes the last good backup.

### Usage

```bash
# Local, unencrypted
CONTRACT_QUORUM_PROOF=<id> ./scripts/automated_backup.sh --network testnet

# Production-equivalent
export BACKUP_ENCRYPTION_KEY=...
./scripts/automated_backup.sh --network mainnet --encrypt --upload quorumproof-backups

# Verify a backup you already have (no export)
./scripts/automated_backup.sh --skip-export backups/daily/quorumproof-2026-09-01_02-00-00.json.enc
```

| Variable | Default | Purpose |
|---|---|---|
| `CONTRACT_QUORUM_PROOF` | — | Contract to export (not needed with `--skip-export`). |
| `BACKUP_ENCRYPTION_KEY` | — | Required for `--encrypt` and to verify `.enc` files. |
| `BACKUP_RETENTION_DAYS` | `30` | Local retention window (`--retention-days` overrides). |
| `BACKUP_NOTIFY_WEBHOOK` | — | Slack/Teams webhook for failure notifications. |

---

## Integrity checks

`check_backup_integrity.sh` is the long-term guard against bit-rot, tampering,
silent deletion, and a schedule that has quietly stopped running.

| Check | Fails when |
|---|---|
| Checksum | A verified manifest entry's file (local, or S3 with `--remote`) no longer hashes to the recorded SHA-256. |
| Accounting | A `quorumproof-*` file exists on disk with no verified manifest entry. |
| Freshness | A network's newest verified backup is older than `--max-age-hours` (default 26h). |
| Deep (`--deep`) | The newest backup no longer decrypts with the current key, or fails `verify_backup.sh --dry-run-restore`. |

```bash
./scripts/check_backup_integrity.sh                       # local set
./scripts/check_backup_integrity.sh --remote quorumproof-backups   # also check S3
./scripts/check_backup_integrity.sh --deep                # plus restore dry-run on newest
```

Run `--deep` after any **encryption key rotation**: a backup encrypted with a
retired key is only recoverable while that key is still available.

### The manifest

`backups/manifest.json` is append-only:

```json
{
  "backups": [
    {
      "file": "quorumproof-2026-09-01_02-00-00.json.enc",
      "sha256": "9f2c…",
      "network": "mainnet",
      "encrypted": true,
      "s3_uri": "s3://quorumproof-backups/quorumproof/mainnet/quorumproof-2026-09-01_02-00-00.json.enc",
      "status": "verified",
      "detail": "",
      "verified_at": "2026-09-01T02:03:12Z"
    }
  ]
}
```

It is uploaded alongside the backups as a GitHub Actions artifact.

---

## Restoring from a verified backup

1. **Pick a candidate** — the newest `verified` entry for the network:

   ```bash
   jq -r '[.backups[] | select(.network=="mainnet" and .status=="verified")]
          | sort_by(.verified_at) | last' backups/manifest.json
   ```

2. **Fetch it and its checksum** (skip if already local):

   ```bash
   aws s3 cp "$S3_URI" backups/daily/
   aws s3 cp "$S3_URI.sha256" backups/daily/
   (cd backups/daily && sha256sum --check "$(basename "$S3_URI").sha256")
   ```

3. **Re-verify before touching the chain:**

   ```bash
   ./scripts/automated_backup.sh --skip-export backups/daily/<file>
   ```

4. **Restore** — follow the pause/restore steps in
   [disaster-recovery.md](./disaster-recovery.md), then:

   ```bash
   ./scripts/restore_from_backup.sh --backup backups/daily/<file> --network mainnet
   ```

5. **Confirm** — re-export with `backup.sh` and compare `credential_count` /
   `slice_count` with the restored backup.

If the newest backup fails step 2 or 3, move to the next-newest `verified`
entry and record the failed one in the incident log.

---

## Operational cadence

| When | Action |
|---|---|
| Daily 02:00 UTC | `backup.yml` runs `automated_backup.sh` + `check_backup_integrity.sh --deep` per network. |
| Weekly | Run `check_backup_integrity.sh --remote <bucket>` to confirm S3 copies. |
| Quarterly | Full restore drill onto a fresh testnet deployment (see [disaster-recovery.md](./disaster-recovery.md)). |
| After key rotation | `check_backup_integrity.sh --deep`, and keep the retired key until all backups encrypted with it have aged out. |
