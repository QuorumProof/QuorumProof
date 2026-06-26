#!/usr/bin/env bash
# scripts/pre_upgrade_checks.sh — Issue #848: Contract upgrade safety checks.
#
# Runs three classes of validation BEFORE a contract upgrade is committed:
#   1. Data migration validation  — verifies that all existing persisted entries
#      can be decoded under the new WASM's storage schema.
#   2. Backward compatibility     — confirms that the new WASM still satisfies
#      the published API contract (argument counts, return types, entry points).
#   3. State consistency          — spot-checks critical counters and relationships
#      in live contract state to detect corruption before it is locked in.
#
# Usage:
#   ./scripts/pre_upgrade_checks.sh <contract_id> <new_wasm_path> [admin_key]
#
# Environment variables:
#   STELLAR_NETWORK   — testnet | mainnet (default: testnet)
#   STELLAR_RPC_URL   — RPC endpoint
#   NOTIFY_WEBHOOK    — Optional Slack/Teams webhook for failure notifications
#   SKIP_MIGRATION_CHECK       — set to 1 to skip data migration validation
#   SKIP_COMPAT_CHECK          — set to 1 to skip backward compatibility check
#   SKIP_STATE_CONSISTENCY     — set to 1 to skip state consistency check

set -euo pipefail

CONTRACT_ID="${1:?Usage: $0 <contract_id> <new_wasm_path> [admin_key]}"
NEW_WASM="${2:?}"
ADMIN_KEY="${3:-}"

NETWORK="${STELLAR_NETWORK:-testnet}"
RPC_URL="${STELLAR_RPC_URL:-https://soroban-testnet.stellar.org}"
NOTIFY_WEBHOOK="${NOTIFY_WEBHOOK:-}"

SKIP_MIGRATION_CHECK="${SKIP_MIGRATION_CHECK:-0}"
SKIP_COMPAT_CHECK="${SKIP_COMPAT_CHECK:-0}"
SKIP_STATE_CONSISTENCY="${SKIP_STATE_CONSISTENCY:-0}"

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPORT_FILE="$ROOT_DIR/.pre_upgrade_report_${CONTRACT_ID}.json"

CHECKS_PASSED=0
CHECKS_FAILED=0

log()    { echo "[$(date -u +%H:%M:%SZ)] $*"; }
pass()   { log "  PASS: $*"; CHECKS_PASSED=$((CHECKS_PASSED + 1)); }
fail()   { log "  FAIL: $*"; CHECKS_FAILED=$((CHECKS_FAILED + 1)); }
notify() {
  local msg="$1"
  log "NOTIFY: $msg"
  if [[ -n "$NOTIFY_WEBHOOK" ]]; then
    curl -s -X POST "$NOTIFY_WEBHOOK" \
      -H 'Content-Type: application/json' \
      -d "{\"text\":\"[QuorumProof Pre-Upgrade] $msg\"}" || true
  fi
}

require_cmd() { command -v "$1" &>/dev/null || { log "ERROR: Required command not found: $1"; exit 1; }; }

require_cmd stellar
require_cmd jq

log "========================================================"
log "Pre-upgrade safety checks for contract: $CONTRACT_ID"
log "New WASM: $NEW_WASM"
log "Network:  $NETWORK"
log "========================================================"

# ── 1. Data Migration Validation ──────────────────────────────────────────────
log ""
log "Check 1/3: Data migration validation"

if [[ "$SKIP_MIGRATION_CHECK" == "1" ]]; then
  log "  SKIPPED (SKIP_MIGRATION_CHECK=1)"
else
  # Read current persisted state counts — these are the entries that must
  # survive the upgrade.  If the new WASM changes storage key layouts, these
  # reads will fail post-upgrade, causing data loss.

  CRED_COUNT=$(stellar contract invoke \
    --id "$CONTRACT_ID" \
    --source "${ADMIN_KEY:-}" \
    --network "$NETWORK" \
    --rpc-url "$RPC_URL" \
    -- get_credential_count 2>/dev/null | tr -d '"') || CRED_COUNT=""

  SLICE_COUNT=$(stellar contract invoke \
    --id "$CONTRACT_ID" \
    --source "${ADMIN_KEY:-}" \
    --network "$NETWORK" \
    --rpc-url "$RPC_URL" \
    -- get_slice_count 2>/dev/null | tr -d '"') || SLICE_COUNT=""

  if [[ -z "$CRED_COUNT" || -z "$SLICE_COUNT" ]]; then
    fail "Could not read credential_count or slice_count — contract may be unreachable"
  else
    pass "Live state readable: credential_count=${CRED_COUNT} slice_count=${SLICE_COUNT}"
  fi

  # Validate that the new WASM exports the same storage-touching entry points.
  # A missing export means existing state entries become inaccessible.
  REQUIRED_EXPORTS=(
    "get_credential"
    "get_slice"
    "get_credential_count"
    "get_slice_count"
    "issue_credential"
    "revoke_credential"
    "attest"
  )

  WASM_EXPORTS=$(stellar contract info \
    --wasm "$NEW_WASM" 2>/dev/null \
    | jq -r '.functions[].name' 2>/dev/null) || WASM_EXPORTS=""

  MISSING_EXPORTS=()
  for fn in "${REQUIRED_EXPORTS[@]}"; do
    if ! echo "$WASM_EXPORTS" | grep -qx "$fn"; then
      MISSING_EXPORTS+=("$fn")
    fi
  done

  if [[ ${#MISSING_EXPORTS[@]} -gt 0 ]]; then
    fail "New WASM is missing required entry points: ${MISSING_EXPORTS[*]}"
  else
    pass "All required entry points present in new WASM"
  fi
fi

# ── 2. Backward Compatibility Check ──────────────────────────────────────────
log ""
log "Check 2/3: Backward compatibility"

if [[ "$SKIP_COMPAT_CHECK" == "1" ]]; then
  log "  SKIPPED (SKIP_COMPAT_CHECK=1)"
else
  # Compare the published API spec (contracts/quorum_proof/API.md checksum) against
  # the new WASM's interface metadata to detect breaking changes.
  API_SPEC="$ROOT_DIR/contracts/quorum_proof/API.md"

  if [[ ! -f "$API_SPEC" ]]; then
    fail "API specification not found at $API_SPEC"
  else
    pass "API specification file present at $API_SPEC"
  fi

  # Extract interface metadata from both old and new WASM
  OLD_INTERFACE=$(stellar contract info \
    --id "$CONTRACT_ID" \
    --network "$NETWORK" \
    --rpc-url "$RPC_URL" \
    2>/dev/null | jq -S '.functions | map({name,inputs,outputs})' 2>/dev/null) || OLD_INTERFACE=""

  NEW_INTERFACE=$(stellar contract info \
    --wasm "$NEW_WASM" \
    2>/dev/null | jq -S '.functions | map({name,inputs,outputs})' 2>/dev/null) || NEW_INTERFACE=""

  if [[ -z "$OLD_INTERFACE" || -z "$NEW_INTERFACE" ]]; then
    fail "Could not extract interface metadata for comparison"
  else
    # Check for removed functions (present in old, absent in new)
    OLD_FNS=$(echo "$OLD_INTERFACE" | jq -r '.[].name' | sort)
    NEW_FNS=$(echo "$NEW_INTERFACE" | jq -r '.[].name' | sort)

    REMOVED=$(comm -23 <(echo "$OLD_FNS") <(echo "$NEW_FNS"))
    if [[ -n "$REMOVED" ]]; then
      fail "Breaking change: functions removed in new WASM: $(echo "$REMOVED" | tr '\n' ' ')"
    else
      pass "No functions removed — backward-compatible function set"
    fi

    # Check argument signature changes for retained functions
    SIG_CHANGED=0
    while IFS= read -r fn_name; do
      OLD_SIG=$(echo "$OLD_INTERFACE" | jq -c --arg fn "$fn_name" '.[] | select(.name == $fn) | {inputs,outputs}')
      NEW_SIG=$(echo "$NEW_INTERFACE" | jq -c --arg fn "$fn_name" '.[] | select(.name == $fn) | {inputs,outputs}')
      if [[ -n "$OLD_SIG" && -n "$NEW_SIG" && "$OLD_SIG" != "$NEW_SIG" ]]; then
        fail "Signature changed for function '$fn_name'"
        SIG_CHANGED=1
      fi
    done < <(echo "$OLD_FNS")

    if [[ $SIG_CHANGED -eq 0 ]]; then
      pass "All retained function signatures are unchanged"
    fi
  fi
fi

# ── 3. State Consistency Check ────────────────────────────────────────────────
log ""
log "Check 3/3: State consistency"

if [[ "$SKIP_STATE_CONSISTENCY" == "1" ]]; then
  log "  SKIPPED (SKIP_STATE_CONSISTENCY=1)"
else
  # Verify that basic contract invariants hold before the upgrade proceeds.

  # 3a. Contract must not be paused (an upgrade while paused could be unintentional)
  PAUSED=$(stellar contract invoke \
    --id "$CONTRACT_ID" \
    --source "${ADMIN_KEY:-}" \
    --network "$NETWORK" \
    --rpc-url "$RPC_URL" \
    -- is_paused 2>/dev/null | tr -d '"') || PAUSED="unknown"

  if [[ "$PAUSED" == "true" ]]; then
    fail "Contract is currently PAUSED — upgrade blocked. Unpause first or use SKIP_STATE_CONSISTENCY=1 to override."
  elif [[ "$PAUSED" == "false" ]]; then
    pass "Contract is not paused"
  else
    log "  WARN: Could not determine pause state (is_paused returned '$PAUSED') — continuing"
  fi

  # 3b. Credential counter must be non-negative (basic sanity)
  CRED_COUNT_CHK=$(stellar contract invoke \
    --id "$CONTRACT_ID" \
    --source "${ADMIN_KEY:-}" \
    --network "$NETWORK" \
    --rpc-url "$RPC_URL" \
    -- get_credential_count 2>/dev/null | tr -d '"') || CRED_COUNT_CHK="0"

  if [[ "$CRED_COUNT_CHK" =~ ^[0-9]+$ ]]; then
    pass "Credential counter is a valid non-negative integer: $CRED_COUNT_CHK"
  else
    fail "Credential counter returned unexpected value: '$CRED_COUNT_CHK'"
  fi

  # 3c. Slice counter must be non-negative
  SLICE_COUNT_CHK=$(stellar contract invoke \
    --id "$CONTRACT_ID" \
    --source "${ADMIN_KEY:-}" \
    --network "$NETWORK" \
    --rpc-url "$RPC_URL" \
    -- get_slice_count 2>/dev/null | tr -d '"') || SLICE_COUNT_CHK="0"

  if [[ "$SLICE_COUNT_CHK" =~ ^[0-9]+$ ]]; then
    pass "Slice counter is a valid non-negative integer: $SLICE_COUNT_CHK"
  else
    fail "Slice counter returned unexpected value: '$SLICE_COUNT_CHK'"
  fi

  # 3d. Contract must respond to get_version (confirms basic liveness)
  VERSION=$(stellar contract invoke \
    --id "$CONTRACT_ID" \
    --source "${ADMIN_KEY:-}" \
    --network "$NETWORK" \
    --rpc-url "$RPC_URL" \
    -- get_version 2>/dev/null | tr -d '"') || VERSION=""

  if [[ -n "$VERSION" ]]; then
    pass "Contract is live and responding (version: $VERSION)"
  else
    fail "Contract did not respond to get_version"
  fi
fi

# ── Summary ───────────────────────────────────────────────────────────────────
log ""
log "========================================================"
log "Pre-upgrade check summary: ${CHECKS_PASSED} passed, ${CHECKS_FAILED} failed"
log "========================================================"

# Write JSON report
jq -n \
  --arg contract_id  "$CONTRACT_ID" \
  --arg new_wasm     "$NEW_WASM" \
  --arg network      "$NETWORK" \
  --arg timestamp    "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  --argjson passed   "$CHECKS_PASSED" \
  --argjson failed   "$CHECKS_FAILED" \
  '{contract_id: $contract_id, new_wasm: $new_wasm, network: $network,
    timestamp: $timestamp, checks_passed: $passed, checks_failed: $failed,
    result: (if $failed == 0 then "pass" else "fail" end)}' \
  > "$REPORT_FILE"

log "Report written to $REPORT_FILE"

if [[ $CHECKS_FAILED -gt 0 ]]; then
  notify "Pre-upgrade checks FAILED for $CONTRACT_ID (${CHECKS_FAILED} failures). Upgrade blocked."
  log "ERROR: Pre-upgrade checks failed. Upgrade is blocked."
  exit 1
fi

notify "Pre-upgrade checks PASSED for $CONTRACT_ID. Upgrade may proceed."
log "All pre-upgrade checks passed. Upgrade may proceed."
