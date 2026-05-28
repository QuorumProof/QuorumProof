#!/usr/bin/env bash
# scripts/snapshot.sh — Export QuorumProof contract state to a JSON snapshot.
#
# Usage:
#   ./scripts/snapshot.sh [--network testnet|mainnet] [--output path/to/file.json]
#
# Requires: soroban CLI, jq, environment variables from .env

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"

# Load .env if present
if [[ -f "$ROOT_DIR/.env" ]]; then
  # shellcheck disable=SC1091
  source "$ROOT_DIR/.env"
fi

NETWORK="${STELLAR_NETWORK:-testnet}"
CONTRACT_ID="${CONTRACT_QUORUM_PROOF:?CONTRACT_QUORUM_PROOF must be set}"
TIMESTAMP="$(date +%F)"
OUTPUT_DIR="$ROOT_DIR/backups/snapshots"
OUTPUT_FILE="${1:-$OUTPUT_DIR/quorumproof-$TIMESTAMP.json}"

mkdir -p "$OUTPUT_DIR"

echo "==> Snapshotting QuorumProof contract $CONTRACT_ID on $NETWORK"

invoke() {
  soroban contract invoke \
    --id "$CONTRACT_ID" \
    --network "$NETWORK" \
    -- "$@" 2>/dev/null
}

# Fetch counts
CRED_COUNT=$(invoke get_credential_count | tr -d '"')
SLICE_COUNT=$(invoke get_slice_count | tr -d '"')

echo "    Credentials: $CRED_COUNT"
echo "    Slices:      $SLICE_COUNT"

# Build JSON snapshot
{
  echo "{"
  echo "  \"snapshot_date\": \"$TIMESTAMP\","
  echo "  \"network\": \"$NETWORK\","
  echo "  \"contract_id\": \"$CONTRACT_ID\","
  echo "  \"credential_count\": $CRED_COUNT,"
  echo "  \"slice_count\": $SLICE_COUNT,"
  echo "  \"credentials\": ["

  for i in $(seq 1 "$CRED_COUNT"); do
    CRED=$(invoke get_credential --credential-id "$i" 2>/dev/null || echo "null")
    if [[ "$i" -lt "$CRED_COUNT" ]]; then
      echo "    $CRED,"
    else
      echo "    $CRED"
    fi
  done

  echo "  ],"
  echo "  \"slices\": ["

  for i in $(seq 1 "$SLICE_COUNT"); do
    SLICE=$(invoke get_slice --slice-id "$i" 2>/dev/null || echo "null")
    if [[ "$i" -lt "$SLICE_COUNT" ]]; then
      echo "    $SLICE,"
    else
      echo "    $SLICE"
    fi
  done

  echo "  ]"
  echo "}"
} > "$OUTPUT_FILE"

echo "==> Snapshot written to $OUTPUT_FILE"
echo "==> Size: $(du -sh "$OUTPUT_FILE" | cut -f1)"
