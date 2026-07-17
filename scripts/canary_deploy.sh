#!/usr/bin/env bash
# scripts/canary_deploy.sh — Issue #847: Canary deployment pipeline.
#
# Deploys the new WASM to 10% of traffic endpoints first, runs health checks
# for a configurable soak period, then promotes to full rollout or rolls back.
#
# Usage:
#   ./scripts/canary_deploy.sh <contract_id> <new_wasm_path> <admin_key>
#
# Environment variables:
#   STELLAR_NETWORK        — testnet | mainnet (default: testnet)
#   STELLAR_RPC_URL        — RPC endpoint
#   CANARY_SOAK_SECONDS    — Health-check soak period (default: 120)
#   CANARY_ERROR_THRESHOLD — Max error rate (0–1) to pass health check (default: 0.05)
#   CANARY_LATENCY_P95_MS  — Max p95 latency in ms to pass health check (default: 2000)
#   PROMETHEUS_URL         — Prometheus base URL for metric queries (default: http://localhost:9090)
#   NOTIFY_WEBHOOK         — Slack/Teams webhook URL for failure notifications (optional)

set -euo pipefail

CONTRACT_ID="${1:?Usage: $0 <contract_id> <new_wasm_path> <admin_key>}"
NEW_WASM="${2:?}"
ADMIN_KEY="${3:?}"

NETWORK="${STELLAR_NETWORK:-testnet}"
RPC_URL="${STELLAR_RPC_URL:-https://soroban-testnet.stellar.org}"
CANARY_ROLLOUT_PCT=10
CANARY_SOAK_SECONDS="${CANARY_SOAK_SECONDS:-120}"
CANARY_ERROR_THRESHOLD="${CANARY_ERROR_THRESHOLD:-0.05}"
CANARY_LATENCY_P95_MS="${CANARY_LATENCY_P95_MS:-2000}"
PROMETHEUS_URL="${PROMETHEUS_URL:-http://localhost:9090}"
NOTIFY_WEBHOOK="${NOTIFY_WEBHOOK:-}"

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

log()    { echo "[$(date -u +%H:%M:%SZ)] $*"; }
fail()   { log "ERROR: $*"; notify "CANARY FAILED: $*"; exit 1; }
notify() {
  local msg="$1"
  log "NOTIFY: $msg"
  if [[ -n "$NOTIFY_WEBHOOK" ]]; then
    curl -s -X POST "$NOTIFY_WEBHOOK" \
      -H 'Content-Type: application/json' \
      -d "{\"text\":\"[QuorumProof Canary] $msg\"}" || true
  fi
}

require_cmd() { command -v "$1" &>/dev/null || fail "Required command not found: $1"; }

require_cmd stellar
require_cmd jq
require_cmd curl

# ── Step 1: Snapshot pre-canary state ────────────────────────────────────────
log "Step 1: Snapshotting pre-canary contract state..."

PRE_WASM_HASH=$(stellar contract info \
  --id "$CONTRACT_ID" \
  --network "$NETWORK" \
  --rpc-url "$RPC_URL" \
  2>/dev/null | jq -r '.wasm_hash // empty') || true

[[ -n "$PRE_WASM_HASH" ]] || fail "Could not retrieve current WASM hash for $CONTRACT_ID"
log "Pre-canary WASM hash: $PRE_WASM_HASH"

# ── Step 2: Upload new WASM ───────────────────────────────────────────────────
log "Step 2: Uploading new WASM: $NEW_WASM"

NEW_WASM_HASH=$(stellar contract upload \
  --wasm "$NEW_WASM" \
  --source "$ADMIN_KEY" \
  --network "$NETWORK" \
  --rpc-url "$RPC_URL") || fail "WASM upload failed"

log "New WASM hash: $NEW_WASM_HASH"

# ── Step 3: Canary rollout (10%) ──────────────────────────────────────────────
log "Step 3: Deploying canary at ${CANARY_ROLLOUT_PCT}% rollout..."

ROLLOUT_PCT="$CANARY_ROLLOUT_PCT" \
  "$ROOT_DIR/scripts/canary_test.sh" \
  || fail "Canary smoke tests failed immediately after deploy"

log "Canary is live. Entering ${CANARY_SOAK_SECONDS}s soak period..."

# ── Step 4: Health checks during soak ────────────────────────────────────────
log "Step 4: Monitoring health for ${CANARY_SOAK_SECONDS}s..."

CHECK_INTERVAL=15
ELAPSED=0
while [[ $ELAPSED -lt $CANARY_SOAK_SECONDS ]]; do
  sleep "$CHECK_INTERVAL"
  ELAPSED=$((ELAPSED + CHECK_INTERVAL))

  # Error rate check via Prometheus
  ERROR_RATE=$(curl -sf \
    "${PROMETHEUS_URL}/api/v1/query" \
    --data-urlencode 'query=rate(quorumproof_api_errors_total[1m])' \
    | jq -r '.data.result[0].value[1] // "0"') || ERROR_RATE="0"

  # p95 latency check via Prometheus (convert to ms)
  LATENCY_P95_S=$(curl -sf \
    "${PROMETHEUS_URL}/api/v1/query" \
    --data-urlencode 'query=histogram_quantile(0.95, rate(quorumproof_contract_invocation_duration_seconds_bucket[1m]))' \
    | jq -r '.data.result[0].value[1] // "0"') || LATENCY_P95_S="0"
  LATENCY_P95_MS=$(echo "$LATENCY_P95_S * 1000" | awk '{printf "%.0f", $1 * 1000}')

  log "  [${ELAPSED}s/${CANARY_SOAK_SECONDS}s] error_rate=${ERROR_RATE} p95_latency=${LATENCY_P95_MS}ms"

  # Fail-fast if thresholds are breached during soak
  if awk "BEGIN{exit !($ERROR_RATE > $CANARY_ERROR_THRESHOLD)}"; then
    log "Canary health check FAILED: error rate ${ERROR_RATE} > threshold ${CANARY_ERROR_THRESHOLD}"
    log "Rolling back to $PRE_WASM_HASH..."
    stellar contract invoke \
      --id "$CONTRACT_ID" \
      --source "$ADMIN_KEY" \
      --network "$NETWORK" \
      --rpc-url "$RPC_URL" \
      -- upgrade \
      --admin "$ADMIN_KEY" \
      --new_wasm_hash "$PRE_WASM_HASH" \
      && log "Rollback complete." \
      || log "WARNING: Rollback also failed — manual intervention required!"
    fail "Canary aborted due to elevated error rate. Rolled back to $PRE_WASM_HASH."
  fi

  if awk "BEGIN{exit !($LATENCY_P95_MS > $CANARY_LATENCY_P95_MS)}"; then
    log "Canary health check FAILED: p95 latency ${LATENCY_P95_MS}ms > threshold ${CANARY_LATENCY_P95_MS}ms"
    log "Rolling back to $PRE_WASM_HASH..."
    stellar contract invoke \
      --id "$CONTRACT_ID" \
      --source "$ADMIN_KEY" \
      --network "$NETWORK" \
      --rpc-url "$RPC_URL" \
      -- upgrade \
      --admin "$ADMIN_KEY" \
      --new_wasm_hash "$PRE_WASM_HASH" \
      && log "Rollback complete." \
      || log "WARNING: Rollback also failed — manual intervention required!"
    fail "Canary aborted due to high latency. Rolled back to $PRE_WASM_HASH."
  fi
done

log "Soak period complete. All health checks passed."

# ── Step 5: Full rollout ──────────────────────────────────────────────────────
log "Step 5: Promoting canary to full rollout (100%)..."

stellar contract invoke \
  --id "$CONTRACT_ID" \
  --source "$ADMIN_KEY" \
  --network "$NETWORK" \
  --rpc-url "$RPC_URL" \
  -- upgrade \
  --admin "$ADMIN_KEY" \
  --new_wasm_hash "$NEW_WASM_HASH" \
  || fail "Full rollout upgrade invocation failed"

log "Full rollout complete."
notify "Canary deployment of $CONTRACT_ID to $NEW_WASM_HASH succeeded on $NETWORK (${CANARY_ROLLOUT_PCT}% → 100%)."
log "Done."
