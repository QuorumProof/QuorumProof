#!/usr/bin/env bash
# scripts/upgrade_rollback.sh — Issue #595: Automated contract upgrade with rollback.
#
# Usage:
#   ./scripts/upgrade_rollback.sh <contract_id> <new_wasm_path> <admin_key>
#
# Workflow:
#   1. Snapshot current WASM hash (pre-upgrade baseline).
#   2. Run smoke tests against the live contract.
#   3. Deploy the new WASM.
#   4. Run post-upgrade smoke tests.
#   5. If post-upgrade tests fail → rollback to previous WASM hash and notify.
#
# Environment variables (override defaults):
#   STELLAR_NETWORK   — testnet | mainnet | futurenet (default: testnet)
#   STELLAR_RPC_URL   — RPC endpoint
#   NOTIFY_WEBHOOK    — Slack/Teams webhook URL for failure notifications (optional)

set -euo pipefail

CONTRACT_ID="${1:?Usage: $0 <contract_id> <new_wasm_path> <admin_key>}"
NEW_WASM="${2:?}"
ADMIN_KEY="${3:?}"

NETWORK="${STELLAR_NETWORK:-testnet}"
RPC_URL="${STELLAR_RPC_URL:-https://soroban-testnet.stellar.org}"
NOTIFY_WEBHOOK="${NOTIFY_WEBHOOK:-}"

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SNAPSHOT_FILE="$ROOT_DIR/.upgrade_snapshot_${CONTRACT_ID}.json"

log()  { echo "[$(date -u +%H:%M:%SZ)] $*"; }
fail() { log "ERROR: $*"; notify "UPGRADE FAILED: $*"; exit 1; }

notify() {
  local msg="$1"
  log "NOTIFY: $msg"
  if [[ -n "$NOTIFY_WEBHOOK" ]]; then
    curl -s -X POST "$NOTIFY_WEBHOOK" \
      -H 'Content-Type: application/json' \
      -d "{\"text\":\"[QuorumProof] $msg\"}" || true
  fi
}

require_cmd() {
  command -v "$1" &>/dev/null || fail "Required command not found: $1"
}

require_cmd stellar
require_cmd jq

# ── Step 1: Snapshot pre-upgrade state ───────────────────────────────────────
log "Step 1: Snapshotting pre-upgrade contract state..."

PRE_WASM_HASH=$(stellar contract info \
  --id "$CONTRACT_ID" \
  --network "$NETWORK" \
  --rpc-url "$RPC_URL" \
  2>/dev/null | jq -r '.wasm_hash // empty') || true

if [[ -z "$PRE_WASM_HASH" ]]; then
  fail "Could not retrieve current WASM hash for contract $CONTRACT_ID"
fi

jq -n \
  --arg contract_id "$CONTRACT_ID" \
  --arg wasm_hash "$PRE_WASM_HASH" \
  --arg timestamp "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  --arg network "$NETWORK" \
  '{contract_id: $contract_id, wasm_hash: $wasm_hash, timestamp: $timestamp, network: $network}' \
  > "$SNAPSHOT_FILE"

log "Pre-upgrade WASM hash: $PRE_WASM_HASH (saved to $SNAPSHOT_FILE)"

# ── Step 2: Pre-upgrade smoke tests ──────────────────────────────────────────
log "Step 2: Running pre-upgrade smoke tests..."
if ! "$ROOT_DIR/scripts/test.sh" 2>&1; then
  fail "Pre-upgrade smoke tests failed — aborting upgrade"
fi
log "Pre-upgrade smoke tests passed."

# ── Step 3: Upload new WASM and upgrade ──────────────────────────────────────
log "Step 3: Uploading new WASM: $NEW_WASM"

NEW_WASM_HASH=$(stellar contract upload \
  --wasm "$NEW_WASM" \
  --source "$ADMIN_KEY" \
  --network "$NETWORK" \
  --rpc-url "$RPC_URL") || fail "WASM upload failed"

log "New WASM hash: $NEW_WASM_HASH"

log "Step 3b: Invoking contract upgrade..."
stellar contract invoke \
  --id "$CONTRACT_ID" \
  --source "$ADMIN_KEY" \
  --network "$NETWORK" \
  --rpc-url "$RPC_URL" \
  -- upgrade \
  --admin "$ADMIN_KEY" \
  --new_wasm_hash "$NEW_WASM_HASH" \
  || fail "Contract upgrade invocation failed"

log "Upgrade transaction submitted."

# ── Step 4: Post-upgrade smoke tests ─────────────────────────────────────────
log "Step 4: Running post-upgrade smoke tests..."
POST_TEST_EXIT=0
"$ROOT_DIR/scripts/test.sh" 2>&1 || POST_TEST_EXIT=$?

if [[ $POST_TEST_EXIT -ne 0 ]]; then
  log "Post-upgrade smoke tests FAILED (exit $POST_TEST_EXIT). Initiating rollback..."

  # ── Step 5: Rollback ─────────────────────────────────────────────────────
  log "Step 5: Rolling back to WASM hash $PRE_WASM_HASH..."

  stellar contract invoke \
    --id "$CONTRACT_ID" \
    --source "$ADMIN_KEY" \
    --network "$NETWORK" \
    --rpc-url "$RPC_URL" \
    -- upgrade \
    --admin "$ADMIN_KEY" \
    --new_wasm_hash "$PRE_WASM_HASH" \
    && log "Rollback transaction submitted." \
    || log "WARNING: Rollback transaction also failed — manual intervention required!"

  notify "Upgrade of $CONTRACT_ID to $NEW_WASM_HASH FAILED. Rolled back to $PRE_WASM_HASH. Manual review required."
  rm -f "$SNAPSHOT_FILE"
  exit 1
fi

log "Post-upgrade smoke tests passed."
notify "Upgrade of $CONTRACT_ID to $NEW_WASM_HASH succeeded on $NETWORK."
rm -f "$SNAPSHOT_FILE"
log "Done."
