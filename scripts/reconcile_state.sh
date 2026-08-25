#!/usr/bin/env bash
# scripts/reconcile_state.sh — Issue #596: Automated contract state reconciliation.
#
# Compares key state counters across two contract instances (e.g. primary vs replica,
# or two network environments) and flags them for manual recovery if inconsistencies
# are detected. This script does NOT itself perform recovery — it detects, reports,
# and (if NOTIFY_WEBHOOK is set) pages on-call with an actionable payload. A human
# (or a separate runbook) still has to act on the report.
#
# An RPC failure on either instance is never treated as a counter of 0. It is
# surfaced as a distinct "unverifiable" state, so an outage on both instances
# cannot read as "consistent".
#
# Usage:
#   ./scripts/reconcile_state.sh <contract_id_a> <contract_id_b>
#
# Exit codes:
#   0 — reconciliation complete, no inconsistencies found
#   1 — inconsistency detected between the two instances (manual recovery required)
#   2 — one or more counters could not be verified (RPC failure); NOT a confirmed
#       consistent result
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

# Sentinel returned by query_counter when a counter could not be determined
# (RPC failure, or a non-numeric response), as opposed to a genuine value of 0.
UNKNOWN_MARKER="UNKNOWN"

INCONSISTENCIES=0
UNVERIFIED=0
UNVERIFIED_METRICS=""

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
unverifiable() {
  local label="$1" val_a="$2" val_b="$3"
  local msg="$label could not be verified: A=$val_a B=$val_b (RPC query failed on at least one instance)"
  log "  [UNKNOWN] $msg"
  UNVERIFIED=$((UNVERIFIED + 1))
  UNVERIFIED_METRICS+="$label"$'\n'
  if [[ -n "$NOTIFY_WEBHOOK" ]]; then
    curl -s -X POST "$NOTIFY_WEBHOOK" \
      -H 'Content-Type: application/json' \
      -d "{\"text\":\"[QuorumProof Reconcile] UNVERIFIED: $msg\"}" || true
  fi
}

require_cmd() { command -v "$1" &>/dev/null || { log "Required: $1"; exit 1; }; }
require_cmd stellar
require_cmd jq
require_cmd python3

# ── Query a counter from a contract ──────────────────────────────────────────
# Prints the counter value, or $UNKNOWN_MARKER if the RPC call failed or
# returned something that isn't a plain integer. Never silently maps a
# failure to "0" — a genuine 0 and an unreachable instance must stay
# distinguishable to the caller.
query_counter() {
  local contract="$1" network="$2" rpc="$3" fn="$4"
  local raw
  if raw=$(stellar contract invoke \
    --id "$contract" \
    --network "$network" \
    --rpc-url "$rpc" \
    -- "$fn" 2>/dev/null | tr -d '"'); then
    if [[ "$raw" =~ ^-?[0-9]+$ ]]; then
      echo "$raw"
    else
      echo "$UNKNOWN_MARKER"
    fi
  else
    echo "$UNKNOWN_MARKER"
  fi
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

  if [[ "$val_a" == "$UNKNOWN_MARKER" || "$val_b" == "$UNKNOWN_MARKER" ]]; then
    unverifiable "$label" "$val_a" "$val_b"
    return
  fi

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

# ── Step 3: Determine overall status and write report ────────────────────────
if (( INCONSISTENCIES > 0 )); then
  STATUS="inconsistent"
elif (( UNVERIFIED > 0 )); then
  STATUS="unverifiable"
else
  STATUS="consistent"
fi

UNVERIFIED_METRICS_JSON=$(printf '%s' "$UNVERIFIED_METRICS" | jq -R -s 'split("\n") | map(select(length > 0))')

jq -n \
  --arg ts "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  --arg status "$STATUS" \
  --arg contract_a "$CONTRACT_A" \
  --arg contract_b "$CONTRACT_B" \
  --arg cred_a "$CRED_COUNT_A" \
  --arg cred_b "$CRED_COUNT_B" \
  --arg slice_a "$SLICE_COUNT_A" \
  --arg slice_b "$SLICE_COUNT_B" \
  --argjson inconsistencies "$INCONSISTENCIES" \
  --argjson unverified "$UNVERIFIED" \
  --argjson unverified_metrics "$UNVERIFIED_METRICS_JSON" \
  '
  def num_or_null: if . == "UNKNOWN" then null else tonumber end;
  {
    timestamp: $ts,
    status: $status,
    instance_a: {contract: $contract_a, credential_count: ($cred_a | num_or_null), slice_count: ($slice_a | num_or_null)},
    instance_b: {contract: $contract_b, credential_count: ($cred_b | num_or_null), slice_count: ($slice_b | num_or_null)},
    inconsistencies: $inconsistencies,
    unverified: $unverified,
    unverified_metrics: $unverified_metrics
  }' > "$REPORT_FILE"

log "Report written to $REPORT_FILE"

# ── Step 4: Surface the result — never claim success on an unverified state ──
if (( INCONSISTENCIES > 0 )); then
  log "MANUAL RECOVERY REQUIRED: $INCONSISTENCIES inconsistency(ies) detected between $CONTRACT_A ($NETWORK_A) and $CONTRACT_B ($NETWORK_B)."
  log "This script does not perform automated recovery — see $REPORT_FILE and invoke the appropriate recovery runbook."
  if [[ -n "$NOTIFY_WEBHOOK" ]]; then
    curl -s -X POST "$NOTIFY_WEBHOOK" \
      -H 'Content-Type: application/json' \
      -d "$(jq -n --arg text "[QuorumProof Reconcile] MANUAL RECOVERY REQUIRED: $INCONSISTENCIES inconsistency(ies) between $CONTRACT_A ($NETWORK_A) and $CONTRACT_B ($NETWORK_B). Report: $REPORT_FILE" '{text: $text}')" || true
  fi
  exit 1
fi

if (( UNVERIFIED > 0 )); then
  log "UNABLE TO VERIFY: $UNVERIFIED metric(s) could not be compared — RPC failure on at least one instance."
  log "This is NOT a confirmed-consistent result. See $REPORT_FILE for details."
  exit 2
fi

log "Reconciliation complete. No inconsistencies found."
