#!/usr/bin/env bash
# scripts/reconcile_state.sh — Issue #596: Automated contract state reconciliation.
#
# Compares key state counters across two contract instances (e.g. primary vs replica,
# or two network environments) and triggers recovery if inconsistencies are detected.
#
# Usage:
#   ./scripts/reconcile_state.sh <contract_id_a> <contract_id_b>
#
# Environment variables:
#   STELLAR_NETWORK_A   — network for instance A (default: testnet)
#   STELLAR_RPC_URL_A   — RPC URL for instance A
#   STELLAR_NETWORK_B   — network for instance B (default: testnet)
#   STELLAR_RPC_URL_B   — RPC URL for instance B
#   NOTIFY_WEBHOOK      — Slack/Teams webhook for alerts (optional)
#   RECONCILE_TOLERANCE — allowed delta between counters before flagging (default: 0)

set -euo pipefail

CONTRACT_A="${1:?Usage: $0 <contract_id_a> <contract_id_b>}"
CONTRACT_B="${2:?}"

NETWORK_A="${STELLAR_NETWORK_A:-testnet}"
RPC_A="${STELLAR_RPC_URL_A:-https://soroban-testnet.stellar.org}"
NETWORK_B="${STELLAR_NETWORK_B:-testnet}"
RPC_B="${STELLAR_RPC_URL_B:-https://soroban-testnet.stellar.org}"
NOTIFY_WEBHOOK="${NOTIFY_WEBHOOK:-}"
TOLERANCE="${RECONCILE_TOLERANCE:-0}"

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPORT_FILE="$ROOT_DIR/reconcile_report_$(date -u +%Y%m%dT%H%M%SZ).json"

INCONSISTENCIES=0

log()   { echo "[$(date -u +%H:%M:%SZ)] $*"; }
alert() {
  local msg="$1"
  log "ALERT: $msg"
  INCONSISTENCIES=$((INCONSISTENCIES + 1))
  if [[ -n "$NOTIFY_WEBHOOK" ]]; then
    curl -s -X POST "$NOTIFY_WEBHOOK" \
      -H 'Content-Type: application/json' \
      -d "{\"text\":\"[QuorumProof Reconcile] $msg\"}" || true
  fi
}

require_cmd() { command -v "$1" &>/dev/null || { log "Required: $1"; exit 1; }; }
require_cmd stellar
require_cmd jq
require_cmd python3

# ── Query a counter from a contract ──────────────────────────────────────────
query_counter() {
  local contract="$1" network="$2" rpc="$3" fn="$4"
  stellar contract invoke \
    --id "$contract" \
    --network "$network" \
    --rpc-url "$rpc" \
    -- "$fn" 2>/dev/null \
    | tr -d '"' \
    || echo "0"
}

# ── Step 1: Fetch state from both instances ───────────────────────────────────
log "Fetching state from instance A ($CONTRACT_A on $NETWORK_A)..."
CRED_COUNT_A=$(query_counter "$CONTRACT_A" "$NETWORK_A" "$RPC_A" "get_credential_count")
SLICE_COUNT_A=$(query_counter "$CONTRACT_A" "$NETWORK_A" "$RPC_A" "get_slice_count")

log "Fetching state from instance B ($CONTRACT_B on $NETWORK_B)..."
CRED_COUNT_B=$(query_counter "$CONTRACT_B" "$NETWORK_B" "$RPC_B" "get_credential_count")
SLICE_COUNT_B=$(query_counter "$CONTRACT_B" "$NETWORK_B" "$RPC_B" "get_slice_count")

log "Instance A — credentials: $CRED_COUNT_A, slices: $SLICE_COUNT_A"
log "Instance B — credentials: $CRED_COUNT_B, slices: $SLICE_COUNT_B"

# ── Step 2: Compare with tolerance ───────────────────────────────────────────
check_delta() {
  local label="$1" val_a="$2" val_b="$3"
  local delta=$(( val_a > val_b ? val_a - val_b : val_b - val_a ))
  if (( delta > TOLERANCE )); then
    alert "$label mismatch: A=$val_a B=$val_b delta=$delta (tolerance=$TOLERANCE)"
  else
    log "  [OK] $label: A=$val_a B=$val_b (delta=$delta)"
  fi
}

log "--- Comparing state ---"
check_delta "credential_count" "$CRED_COUNT_A" "$CRED_COUNT_B"
check_delta "slice_count"      "$SLICE_COUNT_A" "$SLICE_COUNT_B"

# ── Step 3: Write report ──────────────────────────────────────────────────────
jq -n \
  --arg ts "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  --arg contract_a "$CONTRACT_A" \
  --arg contract_b "$CONTRACT_B" \
  --argjson cred_a "$CRED_COUNT_A" \
  --argjson cred_b "$CRED_COUNT_B" \
  --argjson slice_a "$SLICE_COUNT_A" \
  --argjson slice_b "$SLICE_COUNT_B" \
  --argjson inconsistencies "$INCONSISTENCIES" \
  '{
    timestamp: $ts,
    instance_a: {contract: $contract_a, credential_count: $cred_a, slice_count: $slice_a},
    instance_b: {contract: $contract_b, credential_count: $cred_b, slice_count: $slice_b},
    inconsistencies: $inconsistencies
  }' > "$REPORT_FILE"

log "Report written to $REPORT_FILE"

# ── Step 4: Trigger recovery if inconsistencies found ────────────────────────
if [[ $INCONSISTENCIES -gt 0 ]]; then
  log "RECOVERY TRIGGERED: $INCONSISTENCIES inconsistency(ies) detected."
  log "Manual review required. See $REPORT_FILE for details."
  # In a real deployment, this would invoke a recovery runbook or page on-call.
  exit 1
fi

log "Reconciliation complete. No inconsistencies found."
