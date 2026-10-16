#!/usr/bin/env bash
# scripts/check_backup_integrity.sh — Issue #1649: Periodic integrity check of
# all retained backups.
#
# automated_backup.sh verifies each backup at creation time. This script
# re-validates the whole retained set afterwards, catching bit-rot, tampering,
# accidental deletion, and gaps in the backup schedule.
#
# Checks:
#   1. Every "verified" manifest entry still has its file on disk (or in S3
#      with --remote) and its SHA-256 still matches the manifest.
#   2. Every backup file on disk has a manifest entry (no unaccounted files).
#   3. The newest verified backup per network is younger than --max-age-hours.
#   4. With --deep, the newest backup is decrypted and re-run through
#      verify_backup.sh --dry-run-restore.
#
# Usage:
#   ./scripts/check_backup_integrity.sh [--remote <bucket>] [--deep] [--max-age-hours N]
#
# Exit codes: 0 = all checks passed, 1 = one or more checks failed

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"
BACKUP_DIR="$ROOT_DIR/backups/daily"
MANIFEST="$ROOT_DIR/backups/manifest.json"

REMOTE_BUCKET=""
DEEP=false
MAX_AGE_HOURS=26

while [[ $# -gt 0 ]]; do
  case $1 in
    --remote)        REMOTE_BUCKET="$2"; shift 2 ;;
    --deep)          DEEP=true; shift ;;
    --max-age-hours) MAX_AGE_HOURS="$2"; shift 2 ;;
    *) echo "Unknown option: $1"; exit 1 ;;
  esac
done

PASS=0
FAIL=0
check() {
  if [[ "$2" == "true" ]]; then echo "  [PASS] $1"; PASS=$((PASS + 1))
  else echo "  [FAIL] $1"; FAIL=$((FAIL + 1)); fi
}

TEMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TEMP_DIR"' EXIT

[[ -f "$MANIFEST" ]] || { echo "[FAIL] Manifest not found: $MANIFEST"; exit 1; }

echo "==> Checking backup integrity against $MANIFEST"

# ── 1. Manifest entries → files + checksums ─────────────────────────────────
while IFS=$'\t' read -r file sha network s3_uri; do
  [[ -z "$file" ]] && continue
  local_path="$BACKUP_DIR/$file"
  if [[ -f "$local_path" ]]; then
    actual="$(sha256sum "$local_path" | awk '{print $1}')"
    check "$file: local checksum matches manifest" "$([[ "$actual" == "$sha" ]] && echo true || echo false)"
  elif [[ -n "$REMOTE_BUCKET" && -n "$s3_uri" ]]; then
    if aws s3 cp "$s3_uri" "$TEMP_DIR/$file" --only-show-errors 2>/dev/null; then
      actual="$(sha256sum "$TEMP_DIR/$file" | awk '{print $1}')"
      check "$file: remote checksum matches manifest" "$([[ "$actual" == "$sha" ]] && echo true || echo false)"
      rm -f "$TEMP_DIR/$file"
    else
      check "$file: present in S3 ($s3_uri)" "false"
    fi
  else
    # Pruned by retention locally and no remote check requested — not a failure.
    echo "  [SKIP] $file: not on disk (pruned by retention?)"
  fi
done < <(jq -r '.backups[] | select(.status == "verified") | [.file, .sha256, .network, .s3_uri] | @tsv' "$MANIFEST")

# ── 2. Files on disk → manifest entries ─────────────────────────────────────
if [[ -d "$BACKUP_DIR" ]]; then
  for f in "$BACKUP_DIR"/quorumproof-*.json "$BACKUP_DIR"/quorumproof-*.json.enc; do
    [[ -f "$f" ]] || continue
    name="$(basename "$f")"
    known="$(jq --arg f "$name" '[.backups[] | select(.file == $f and .status == "verified")] | length > 0' "$MANIFEST")"
    check "$name: has a verified manifest entry" "$known"
  done
fi

# ── 3. Freshness per network ────────────────────────────────────────────────
NOW_EPOCH="$(date +%s)"
for network in $(jq -r '[.backups[].network] | unique | .[]' "$MANIFEST"); do
  latest="$(jq -r --arg n "$network" \
    '[.backups[] | select(.network == $n and .status == "verified")] | sort_by(.verified_at) | last | .verified_at // empty' \
    "$MANIFEST")"
  if [[ -z "$latest" ]]; then
    check "$network: has at least one verified backup" "false"
    continue
  fi
  latest_epoch="$(date -d "$latest" +%s 2>/dev/null || echo 0)"
  age_h=$(( (NOW_EPOCH - latest_epoch) / 3600 ))
  check "$network: newest verified backup is ${age_h}h old (limit ${MAX_AGE_HOURS}h)" \
    "$([[ "$age_h" -le "$MAX_AGE_HOURS" ]] && echo true || echo false)"
done

# ── 4. Deep check of newest backup ──────────────────────────────────────────
if [[ "$DEEP" == true ]]; then
  newest="$(jq -r '[.backups[] | select(.status == "verified")] | sort_by(.verified_at) | last | .file // empty' "$MANIFEST")"
  if [[ -n "$newest" && -f "$BACKUP_DIR/$newest" ]]; then
    plaintext="$BACKUP_DIR/$newest"
    if [[ "$newest" == *.enc ]]; then
      KEY="${BACKUP_ENCRYPTION_KEY:?BACKUP_ENCRYPTION_KEY must be set for --deep on encrypted backups}"
      plaintext="$TEMP_DIR/${newest%.enc}"
      if ! openssl enc -d -aes-256-cbc -in "$BACKUP_DIR/$newest" -out "$plaintext" -k "$KEY" -md sha256 2>/dev/null; then
        check "$newest: decrypts with current key" "false"
        plaintext=""
      else
        check "$newest: decrypts with current key" "true"
      fi
    fi
    if [[ -n "$plaintext" ]]; then
      if "$SCRIPT_DIR/verify_backup.sh" "$plaintext" --dry-run-restore >"$TEMP_DIR/verify.log" 2>&1; then
        check "$newest: restore dry-run passes" "true"
      else
        check "$newest: restore dry-run passes" "false"
        sed 's/^/      /' "$TEMP_DIR/verify.log"
      fi
    fi
  else
    echo "  [SKIP] --deep: newest verified backup not available locally"
  fi
fi

echo ""
echo "==> Results: $PASS passed, $FAIL failed"
[[ "$FAIL" -eq 0 ]] || { echo "==> Backup integrity check FAILED"; exit 1; }
echo "==> All retained backups are intact"
