#!/usr/bin/env bash
# scripts/verify_backup.sh — Verify backup completeness, checksum, and restore dry-run.
#
# Usage:
#   ./scripts/verify_backup.sh <backup.json> [--checksum-file <sha256sums>] [--dry-run-restore]
#
# Exit codes: 0 = all checks passed, 1 = one or more checks failed

set -euo pipefail

BACKUP_FILE="${1:?Usage: verify_backup.sh <backup.json> [--checksum-file <file>] [--dry-run-restore]}"
shift

CHECKSUM_FILE=""
DRY_RUN_RESTORE=false

while [[ $# -gt 0 ]]; do
  case $1 in
    --checksum-file) CHECKSUM_FILE="$2"; shift 2 ;;
    --dry-run-restore) DRY_RUN_RESTORE=true; shift ;;
    *) echo "Unknown option: $1"; exit 1 ;;
  esac
done

PASS=0
FAIL=0

check() {
  local desc="$1" result="$2"
  if [[ "$result" == "true" ]]; then
    echo "  [PASS] $desc"
    PASS=$((PASS + 1))
  else
    echo "  [FAIL] $desc"
    FAIL=$((FAIL + 1))
  fi
}

echo "==> Verifying backup: $BACKUP_FILE"

# ── 1. File exists and is non-empty ──────────────────────────────────────────
[[ -f "$BACKUP_FILE" ]] || { echo "[FAIL] File not found: $BACKUP_FILE"; exit 1; }
[[ -s "$BACKUP_FILE" ]] || { echo "[FAIL] File is empty: $BACKUP_FILE"; exit 1; }

# ── 2. Valid JSON ─────────────────────────────────────────────────────────────
if jq empty "$BACKUP_FILE" 2>/dev/null; then
  check "Valid JSON" "true"
else
  check "Valid JSON" "false"
  echo "==> Cannot continue: backup is not valid JSON"
  exit 1
fi

# ── 3. Required top-level keys ────────────────────────────────────────────────
for key in backup_date network contract_id credential_count slice_count credentials slices; do
  check "Has key: $key" "$(jq --arg k "$key" 'has($k)' "$BACKUP_FILE")"
done

# ── 4. Completeness: array lengths match declared counts ──────────────────────
DECL_CREDS=$(jq '.credential_count' "$BACKUP_FILE")
ACTUAL_CREDS=$(jq '.credentials | length' "$BACKUP_FILE")
check "Credential array length ($ACTUAL_CREDS) matches credential_count ($DECL_CREDS)" \
  "$([[ "$DECL_CREDS" == "$ACTUAL_CREDS" ]] && echo true || echo false)"

DECL_SLICES=$(jq '.slice_count' "$BACKUP_FILE")
ACTUAL_SLICES=$(jq '.slices | length' "$BACKUP_FILE")
check "Slice array length ($ACTUAL_SLICES) matches slice_count ($DECL_SLICES)" \
  "$([[ "$DECL_SLICES" == "$ACTUAL_SLICES" ]] && echo true || echo false)"

# ── 5. No null entries ────────────────────────────────────────────────────────
NULL_CREDS=$(jq '[.credentials[] | select(. == null)] | length' "$BACKUP_FILE")
check "No null credentials" "$([[ "$NULL_CREDS" == "0" ]] && echo true || echo false)"

NULL_SLICES=$(jq '[.slices[] | select(. == null)] | length' "$BACKUP_FILE")
check "No null slices" "$([[ "$NULL_SLICES" == "0" ]] && echo true || echo false)"

# ── 6. Required credential fields present ────────────────────────────────────
if [[ "$ACTUAL_CREDS" -gt 0 ]]; then
  MISSING_CRED_FIELDS=$(jq '
    [.credentials[] |
      select(
        (.subject == null or .subject == "") or
        (.credential_type == null or .credential_type == "") or
        (.metadata_hash == null or .metadata_hash == "")
      )
    ] | length' "$BACKUP_FILE")
  check "All credentials have required fields" \
    "$([[ "$MISSING_CRED_FIELDS" == "0" ]] && echo true || echo false)"
fi

# ── 7. Checksum verification ──────────────────────────────────────────────────
if [[ -n "$CHECKSUM_FILE" ]]; then
  if [[ -f "$CHECKSUM_FILE" ]]; then
    if sha256sum --check --status "$CHECKSUM_FILE" 2>/dev/null; then
      check "SHA-256 checksum matches" "true"
    else
      check "SHA-256 checksum matches" "false"
    fi
  else
    # Generate checksum file if it doesn't exist yet
    sha256sum "$BACKUP_FILE" > "$CHECKSUM_FILE"
    check "SHA-256 checksum generated: $CHECKSUM_FILE" "true"
  fi
else
  # Always compute and display the checksum for audit purposes
  COMPUTED=$(sha256sum "$BACKUP_FILE" | awk '{print $1}')
  echo "  [INFO] SHA-256: $COMPUTED"
fi

# ── 8. Backup age check (warn if older than 25 hours) ────────────────────────
BACKUP_DATE=$(jq -r '.backup_date' "$BACKUP_FILE")
if [[ "$BACKUP_DATE" != "null" ]]; then
  # Parse timestamp from backup_date field (format: YYYY-MM-DD_HH-MM-SS)
  NORMALIZED="${BACKUP_DATE//_/ }"
  NORMALIZED="${NORMALIZED//-/:}"
  # Restore the date separator
  NORMALIZED="$(echo "$NORMALIZED" | sed 's/\([0-9]\{4\}\):\([0-9]\{2\}\):\([0-9]\{2\}\)/\1-\2-\3/')"
  BACKUP_EPOCH=$(date -d "$NORMALIZED" +%s 2>/dev/null || echo 0)
  NOW_EPOCH=$(date +%s)
  AGE_HOURS=$(( (NOW_EPOCH - BACKUP_EPOCH) / 3600 ))
  if [[ "$BACKUP_EPOCH" -gt 0 && "$AGE_HOURS" -le 25 ]]; then
    check "Backup age is within 25 hours (${AGE_HOURS}h old)" "true"
  elif [[ "$BACKUP_EPOCH" -gt 0 ]]; then
    check "Backup age is within 25 hours (${AGE_HOURS}h old — STALE)" "false"
  fi
fi

# ── 9. Restore dry-run ────────────────────────────────────────────────────────
if [[ "$DRY_RUN_RESTORE" == true ]]; then
  echo "  [INFO] Running restore dry-run (no contract calls made)..."
  RESTORE_ERRORS=0

  # Validate each credential has the fields restore_from_backup.sh needs
  for i in $(seq 0 $((ACTUAL_CREDS - 1))); do
    CRED=$(jq ".credentials[$i]" "$BACKUP_FILE")
    for field in subject credential_type metadata_hash; do
      VAL=$(echo "$CRED" | jq -r ".$field")
      if [[ -z "$VAL" || "$VAL" == "null" ]]; then
        echo "    [WARN] credentials[$i] missing field: $field"
        RESTORE_ERRORS=$((RESTORE_ERRORS + 1))
      fi
    done
  done

  # Validate each slice has the fields restore_from_backup.sh needs
  for i in $(seq 0 $((ACTUAL_SLICES - 1))); do
    SLICE=$(jq ".slices[$i]" "$BACKUP_FILE")
    for field in creator threshold attestors; do
      VAL=$(echo "$SLICE" | jq -r ".$field")
      if [[ -z "$VAL" || "$VAL" == "null" ]]; then
        echo "    [WARN] slices[$i] missing field: $field"
        RESTORE_ERRORS=$((RESTORE_ERRORS + 1))
      fi
    done
  done

  check "Restore dry-run: all records have required fields ($RESTORE_ERRORS issues)" \
    "$([[ "$RESTORE_ERRORS" == "0" ]] && echo true || echo false)"
fi

# ── Summary ───────────────────────────────────────────────────────────────────
echo ""
echo "==> Results: $PASS passed, $FAIL failed"

if [[ "$FAIL" -eq 0 ]]; then
  echo "==> Backup is valid"
  exit 0
else
  echo "==> Backup verification FAILED"
  exit 1
fi
