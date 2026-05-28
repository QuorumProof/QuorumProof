#!/usr/bin/env bash
# scripts/verify_snapshot.sh — Verify integrity of a QuorumProof state snapshot.
#
# Usage:
#   ./scripts/verify_snapshot.sh <snapshot.json>
#
# Exit codes: 0 = all checks passed, 1 = one or more checks failed

set -euo pipefail

SNAPSHOT="${1:?Usage: verify_snapshot.sh <snapshot.json>}"

PASS=0
FAIL=0

check() {
  local desc="$1"
  local result="$2"
  if [[ "$result" == "true" ]]; then
    echo "  [PASS] $desc"
    PASS=$((PASS + 1))
  else
    echo "  [FAIL] $desc"
    FAIL=$((FAIL + 1))
  fi
}

echo "==> Verifying snapshot: $SNAPSHOT"

# Check 1: file exists and is non-empty
[[ -f "$SNAPSHOT" ]] || { echo "[FAIL] File not found: $SNAPSHOT"; exit 1; }
[[ -s "$SNAPSHOT" ]] || { echo "[FAIL] File is empty: $SNAPSHOT"; exit 1; }

# Check 2: valid JSON
if jq empty "$SNAPSHOT" 2>/dev/null; then
  check "Valid JSON" "true"
else
  check "Valid JSON" "false"
fi

# Check 3: required top-level keys present
for key in snapshot_date network contract_id credential_count slice_count credentials slices; do
  HAS=$(jq --arg k "$key" 'has($k)' "$SNAPSHOT")
  check "Has key: $key" "$HAS"
done

# Check 4: credential array length matches credential_count
DECLARED=$(jq '.credential_count' "$SNAPSHOT")
ACTUAL=$(jq '.credentials | length' "$SNAPSHOT")
if [[ "$DECLARED" == "$ACTUAL" ]]; then
  check "Credential array length matches credential_count ($DECLARED)" "true"
else
  check "Credential array length ($ACTUAL) matches credential_count ($DECLARED)" "false"
fi

# Check 5: slice array length matches slice_count
DECLARED_S=$(jq '.slice_count' "$SNAPSHOT")
ACTUAL_S=$(jq '.slices | length' "$SNAPSHOT")
if [[ "$DECLARED_S" == "$ACTUAL_S" ]]; then
  check "Slice array length matches slice_count ($DECLARED_S)" "true"
else
  check "Slice array length ($ACTUAL_S) matches slice_count ($DECLARED_S)" "false"
fi

# Check 6: no null credentials in array
NULL_CREDS=$(jq '[.credentials[] | select(. == null)] | length' "$SNAPSHOT")
check "No null credentials" "$([[ "$NULL_CREDS" == "0" ]] && echo true || echo false)"

echo ""
echo "==> Results: $PASS passed, $FAIL failed"

[[ "$FAIL" -eq 0 ]] && exit 0 || exit 1
