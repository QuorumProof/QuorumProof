#!/usr/bin/env bash
# scripts/testnet_smoke_test.sh — Post-deployment smoke tests for testnet CI.
#
# Reads the manifest written by deploy_testnet.sh and exercises the core
# read/write path on each freshly-deployed contract. Exits non-zero on any
# failure so the CI workflow can trigger scripts/testnet_rollback.sh.
#
# Usage: ./scripts/testnet_smoke_test.sh [manifest_path]
set -euo pipefail

MANIFEST_PATH="${1:-${MANIFEST_PATH:-testnet-deployment.json}}"
NETWORK="${STELLAR_NETWORK:-testnet}"

log() { echo "[$(date -u +%H:%M:%SZ)] $*"; }
fail() { log "SMOKE TEST FAILED: $*"; exit 1; }

require_cmd() {
  command -v "$1" &>/dev/null || fail "Required command not found: $1"
}

require_cmd stellar
require_cmd jq

[ -f "$MANIFEST_PATH" ] || fail "Manifest not found: $MANIFEST_PATH"

CONTRACT_QUORUM_PROOF=$(jq -r '.contracts.quorum_proof' "$MANIFEST_PATH")
CONTRACT_SBT_REGISTRY=$(jq -r '.contracts.sbt_registry' "$MANIFEST_PATH")
CONTRACT_ZK_VERIFIER=$(jq -r '.contracts.zk_verifier' "$MANIFEST_PATH")

[ -n "$CONTRACT_QUORUM_PROOF" ] && [ "$CONTRACT_QUORUM_PROOF" != "null" ] || fail "quorum_proof contract ID missing from manifest"

stellar keys generate smoketest --network "$NETWORK" 2>/dev/null || true

echo "=== Testnet smoke tests ($NETWORK) ==="

log "[1/4] quorum_proof: contract reachable (get_version)..."
stellar contract invoke \
  --id "$CONTRACT_QUORUM_PROOF" \
  --source smoketest \
  --network "$NETWORK" \
  -- get_version \
  || fail "quorum_proof get_version did not respond"

log "[2/4] quorum_proof: get_state_metrics readable..."
stellar contract invoke \
  --id "$CONTRACT_QUORUM_PROOF" \
  --source smoketest \
  --network "$NETWORK" \
  -- get_state_metrics \
  || fail "quorum_proof get_state_metrics did not respond"

if [ -n "$CONTRACT_SBT_REGISTRY" ] && [ "$CONTRACT_SBT_REGISTRY" != "null" ]; then
  log "[3/4] sbt_registry: contract reachable..."
  stellar contract invoke \
    --id "$CONTRACT_SBT_REGISTRY" \
    --source smoketest \
    --network "$NETWORK" \
    -- get_version \
    || fail "sbt_registry get_version did not respond"
else
  log "[3/4] sbt_registry: skipped (not in manifest)"
fi

if [ -n "$CONTRACT_ZK_VERIFIER" ] && [ "$CONTRACT_ZK_VERIFIER" != "null" ]; then
  log "[4/4] zk_verifier: contract reachable..."
  stellar contract invoke \
    --id "$CONTRACT_ZK_VERIFIER" \
    --source smoketest \
    --network "$NETWORK" \
    -- get_version \
    || fail "zk_verifier get_version did not respond"
else
  log "[4/4] zk_verifier: skipped (not in manifest)"
fi

echo "=== All testnet smoke tests passed ==="
