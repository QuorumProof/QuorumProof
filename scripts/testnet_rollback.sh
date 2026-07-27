#!/usr/bin/env bash
# scripts/testnet_rollback.sh — Automatic rollback for failed testnet CI deploys.
#
# A fresh testnet deployment can't be "rolled back" on-chain the way an
# in-place contract upgrade can (see scripts/upgrade_rollback.sh) — a failed
# deploy is simply a new, broken set of contract IDs. "Rollback" here means:
# restore the manifest pointer (testnet-deployment.json) to the last
# known-good deployment written by scripts/deploy_testnet.sh, so downstream
# consumers (api-server config, dashboards) keep using the previous contract
# IDs instead of the broken ones, and notify.
#
# Usage: ./scripts/testnet_rollback.sh [manifest_path]
set -euo pipefail

MANIFEST_PATH="${1:-${MANIFEST_PATH:-testnet-deployment.json}}"
PREVIOUS_PATH="${MANIFEST_PATH}.previous"
NOTIFY_WEBHOOK="${NOTIFY_WEBHOOK:-}"

log() { echo "[$(date -u +%H:%M:%SZ)] $*"; }

notify() {
  local msg="$1"
  log "NOTIFY: $msg"
  if [[ -n "$NOTIFY_WEBHOOK" ]]; then
    curl -s -X POST "$NOTIFY_WEBHOOK" \
      -H 'Content-Type: application/json' \
      -d "{\"text\":\"[QuorumProof CI] $msg\"}" || true
  fi
}

if [ ! -f "$PREVIOUS_PATH" ]; then
  notify "Testnet smoke tests failed and no previous manifest exists to roll back to. Broken manifest left at $MANIFEST_PATH for investigation."
  log "No previous manifest found at $PREVIOUS_PATH — nothing to restore."
  exit 1
fi

BROKEN_PATH="${MANIFEST_PATH}.broken-$(date -u +%Y%m%dT%H%M%SZ)"
cp "$MANIFEST_PATH" "$BROKEN_PATH"
cp "$PREVIOUS_PATH" "$MANIFEST_PATH"

log "Restored $MANIFEST_PATH from $PREVIOUS_PATH (broken deployment saved to $BROKEN_PATH)"
notify "Testnet smoke tests failed after deployment. Rolled back testnet-deployment.json to the last known-good contract IDs. Broken deployment archived as $BROKEN_PATH."
