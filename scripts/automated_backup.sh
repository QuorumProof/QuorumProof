#!/usr/bin/env bash
# scripts/automated_backup.sh — Issue #1649: Automated backup with verification.
#
# Wraps scripts/backup.sh so that every backup is *proven* recoverable before
# it is considered complete. A backup is only marked VERIFIED once all of the
# following succeed:
#
#   1. Export     — scripts/backup.sh produces the (optionally encrypted) file.
#   2. Checksum   — a SHA-256 manifest entry is written for the artifact.
#   3. Decrypt    — for encrypted backups, the file is decrypted into a temp
#                   dir with the production key (proves the key + cipher
#                   parameters still round-trip).
#   4. Content    — scripts/verify_backup.sh runs against the plaintext with
#                   --dry-run-restore (schema, counts, required fields, age).
#   5. Remote     — when uploaded, the object is downloaded back from S3 and
#                   its SHA-256 must match the local manifest entry.
#   6. Retention  — old local backups beyond BACKUP_RETENTION_DAYS are pruned
#                   (only after the new backup has verified).
#
# Results are recorded in backups/manifest.json (one entry per backup) so that
# scripts/check_backup_integrity.sh can later re-validate the whole set.
#
# Usage:
#   ./scripts/automated_backup.sh [--network testnet|mainnet] [--encrypt] \
#                                 [--upload <bucket>] [--retention-days N] \
#                                 [--skip-export <existing-backup-file>]
#
# Environment:
#   CONTRACT_QUORUM_PROOF   — contract to back up (required unless --skip-export)
#   BACKUP_ENCRYPTION_KEY   — required with --encrypt
#   BACKUP_RETENTION_DAYS   — local retention (default: 30)
#   BACKUP_NOTIFY_WEBHOOK   — optional Slack/Teams webhook for failures
#
# Exit codes: 0 = backup created and verified, 1 = backup or verification failed

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"

if [[ -f "$ROOT_DIR/.env" ]]; then
  # shellcheck disable=SC1091
  source "$ROOT_DIR/.env"
fi

NETWORK="${STELLAR_NETWORK:-testnet}"
ENCRYPT=false
UPLOAD_BUCKET=""
RETENTION_DAYS="${BACKUP_RETENTION_DAYS:-30}"
EXISTING_BACKUP=""
BACKUP_DIR="$ROOT_DIR/backups/daily"
MANIFEST="$ROOT_DIR/backups/manifest.json"
NOTIFY_WEBHOOK="${BACKUP_NOTIFY_WEBHOOK:-}"

while [[ $# -gt 0 ]]; do
  case $1 in
    --network)        NETWORK="$2"; shift 2 ;;
    --encrypt)        ENCRYPT=true; shift ;;
    --upload)         UPLOAD_BUCKET="$2"; shift 2 ;;
    --retention-days) RETENTION_DAYS="$2"; shift 2 ;;
    --skip-export)    EXISTING_BACKUP="$2"; shift 2 ;;
    *) echo "Unknown option: $1"; exit 1 ;;
  esac
done

log()    { echo "[$(date -u +%H:%M:%SZ)] $*"; }
notify() {
  [[ -z "$NOTIFY_WEBHOOK" ]] && return 0
  curl -sf -X POST -H 'Content-Type: application/json' \
    -d "$(jq -n --arg t "$1" '{text: $t}')" "$NOTIFY_WEBHOOK" >/dev/null || true
}
fail() {
  log "ERROR: $*"
  notify "QuorumProof backup FAILED ($NETWORK): $*"
  record_manifest "failed" "$*"
  exit 1
}

TEMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TEMP_DIR"' EXIT

ARTIFACT=""
SHA256=""
S3_URI=""

# Append one entry to backups/manifest.json. The manifest is the source of
# truth for check_backup_integrity.sh and for picking a restore candidate.
record_manifest() {
  local status="$1" detail="${2:-}"
  mkdir -p "$(dirname "$MANIFEST")"
  [[ -f "$MANIFEST" ]] || echo '{"backups": []}' > "$MANIFEST"
  local tmp="$TEMP_DIR/manifest.json"
  jq --arg file "${ARTIFACT:+$(basename "$ARTIFACT")}" \
     --arg sha "$SHA256" \
     --arg network "$NETWORK" \
     --arg status "$status" \
     --arg detail "$detail" \
     --arg s3 "$S3_URI" \
     --argjson encrypted "$ENCRYPT" \
     --arg at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
     '.backups += [{
        file: $file, sha256: $sha, network: $network, encrypted: $encrypted,
        s3_uri: $s3, status: $status, detail: $detail, verified_at: $at
      }]' "$MANIFEST" > "$tmp" && mv "$tmp" "$MANIFEST"
}

# ── 1. Export ────────────────────────────────────────────────────────────────
if [[ -n "$EXISTING_BACKUP" ]]; then
  [[ -f "$EXISTING_BACKUP" ]] || fail "Backup file not found: $EXISTING_BACKUP"
  ARTIFACT="$EXISTING_BACKUP"
  [[ "$ARTIFACT" == *.enc ]] && ENCRYPT=true
  log "Step 1/6: using existing backup $ARTIFACT"
else
  log "Step 1/6: exporting contract state ($NETWORK)"
  BACKUP_ARGS=(--network "$NETWORK")
  [[ "$ENCRYPT" == true ]] && BACKUP_ARGS+=(--encrypt)
  [[ -n "$UPLOAD_BUCKET" ]] && BACKUP_ARGS+=(--upload "$UPLOAD_BUCKET")
  "$SCRIPT_DIR/backup.sh" "${BACKUP_ARGS[@]}" || fail "backup.sh exited non-zero"

  if [[ "$ENCRYPT" == true ]]; then
    ARTIFACT="$(ls -t "$BACKUP_DIR"/*.json.enc 2>/dev/null | head -n1 || true)"
  else
    ARTIFACT="$(ls -t "$BACKUP_DIR"/*.json 2>/dev/null | head -n1 || true)"
  fi
  [[ -n "$ARTIFACT" ]] || fail "backup.sh reported success but no artifact was found in $BACKUP_DIR"
fi

# ── 2. Checksum ──────────────────────────────────────────────────────────────
log "Step 2/6: computing SHA-256"
SHA256="$(sha256sum "$ARTIFACT" | awk '{print $1}')"
echo "$SHA256  $(basename "$ARTIFACT")" > "$ARTIFACT.sha256"
log "  sha256=$SHA256"

# ── 3. Decrypt round-trip ────────────────────────────────────────────────────
PLAINTEXT="$ARTIFACT"
if [[ "$ENCRYPT" == true ]]; then
  log "Step 3/6: decrypt round-trip"
  KEY="${BACKUP_ENCRYPTION_KEY:?BACKUP_ENCRYPTION_KEY must be set to verify an encrypted backup}"
  PLAINTEXT="$TEMP_DIR/$(basename "${ARTIFACT%.enc}")"
  # Parameters must match scripts/backup.sh and scripts/restore_from_backup.sh.
  openssl enc -d -aes-256-cbc -in "$ARTIFACT" -out "$PLAINTEXT" -k "$KEY" -md sha256 \
    || fail "Decryption failed — key mismatch or corrupted ciphertext"
else
  log "Step 3/6: decrypt round-trip skipped (backup is not encrypted)"
fi

# ── 4. Content verification ──────────────────────────────────────────────────
log "Step 4/6: content verification (schema, counts, restore dry-run)"
"$SCRIPT_DIR/verify_backup.sh" "$PLAINTEXT" --dry-run-restore \
  || fail "verify_backup.sh reported failures"

# ── 5. Remote integrity ──────────────────────────────────────────────────────
if [[ -n "$UPLOAD_BUCKET" ]]; then
  log "Step 5/6: remote integrity (re-download from S3)"
  S3_URI="s3://$UPLOAD_BUCKET/quorumproof/$NETWORK/$(basename "$ARTIFACT")"
  aws s3 cp "$S3_URI" "$TEMP_DIR/remote-copy" --only-show-errors \
    || fail "Could not download $S3_URI for verification"
  REMOTE_SHA="$(sha256sum "$TEMP_DIR/remote-copy" | awk '{print $1}')"
  [[ "$REMOTE_SHA" == "$SHA256" ]] \
    || fail "Remote checksum mismatch: local=$SHA256 remote=$REMOTE_SHA"
  aws s3 cp "$ARTIFACT.sha256" "$S3_URI.sha256" --only-show-errors \
    || fail "Could not upload checksum sidecar"
  log "  remote copy matches local checksum"
else
  log "Step 5/6: remote integrity skipped (no --upload)"
fi

record_manifest "verified"

# ── 6. Retention ─────────────────────────────────────────────────────────────
# Prune only after the new backup has verified, so there is always at least
# one known-good backup on disk.
log "Step 6/6: pruning local backups older than ${RETENTION_DAYS} days"
find "$BACKUP_DIR" -maxdepth 1 -type f \
  \( -name 'quorumproof-*.json' -o -name 'quorumproof-*.json.enc' -o -name 'quorumproof-*.sha256' \) \
  -mtime +"$RETENTION_DAYS" -print -delete || true

log "Backup VERIFIED: $(basename "$ARTIFACT")"
