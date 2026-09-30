#!/usr/bin/env bash
# scripts/cost_attribution.sh — Issue #1657: Cost attribution by team/service/label.
#
# Reads the cost report from the QuorumProof API and maps operations to owning
# teams using a configurable attribution table. Produces a per-team cost
# breakdown useful for charge-back, budget tracking, and prioritizing
# optimization work.
#
# Usage:
#   ./scripts/cost_attribution.sh [--config FILE] [--json] [--output FILE]
#
# Options:
#   --config FILE   Path to attribution config YAML/JSON (default: infra/cost-attribution.json)
#   --json          Emit JSON attribution report
#   --output FILE   Write JSON report to FILE
#
# Attribution config format (JSON):
#   {
#     "teams": {
#       "credentials": ["issue_credential", "get_credential", "revoke_credential"],
#       "attestation":  ["attest", "is_attested", "get_attestors"],
#       "zk":           ["verify_claim", "generate_proof_request"],
#       "slices":       ["create_slice", "get_slice", "add_attestor"],
#       "registry":     ["register_sbt", "get_sbt", "transfer_sbt"]
#     }
#   }
#
# Environment variables:
#   API_BASE_URL    — Base URL of the QuorumProof API (default: http://localhost:3001)

set -euo pipefail

API_BASE_URL="${API_BASE_URL:-http://localhost:3001}"
CONFIG_FILE="${CONFIG_FILE:-infra/cost-attribution.json}"
EMIT_JSON=false
OUTPUT_FILE=""

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# ── Argument parsing ──────────────────────────────────────────────────────────
while [[ $# -gt 0 ]]; do
  case "$1" in
    --config)  CONFIG_FILE="${2:?--config requires a path}"; shift ;;
    --json)    EMIT_JSON=true ;;
    --output)  OUTPUT_FILE="${2:?--output requires a path}"; shift ;;
    *)         echo "Unknown option: $1" >&2; exit 1 ;;
  esac
  shift
done

log() { echo "[$(date -u +%H:%M:%SZ)] $*"; }
hr()  { printf '%0.s─' {1..70}; echo; }

require_cmd() { command -v "$1" &>/dev/null || { echo "Required: $1"; exit 1; }; }
require_cmd curl
require_cmd jq

# ── Default attribution config ────────────────────────────────────────────────
# Written to a temp file if the real config doesn't exist.
DEFAULT_CONFIG='{
  "teams": {
    "credentials": [
      "issue_credential",
      "get_credential",
      "revoke_credential",
      "batch_issue_credentials",
      "get_credential_count"
    ],
    "attestation": [
      "attest",
      "is_attested",
      "get_attestors",
      "remove_attestor"
    ],
    "zk": [
      "verify_claim",
      "generate_proof_request",
      "verify_groth16_proof",
      "verify_plonk_proof",
      "create_disclosure_proof",
      "verify_disclosure"
    ],
    "slices": [
      "create_slice",
      "get_slice",
      "add_attestor",
      "get_slice_count"
    ],
    "registry": [
      "register_sbt",
      "get_sbt",
      "get_sbt_count"
    ],
    "infrastructure": [
      "get_version",
      "get_supported_claim_types",
      "admin_pause",
      "admin_unpause",
      "upgrade"
    ]
  }
}'

# Resolve config path relative to repo root if not absolute
if [[ "$CONFIG_FILE" != /* ]]; then
  CONFIG_FILE="${ROOT_DIR}/${CONFIG_FILE}"
fi

if [[ ! -f "$CONFIG_FILE" ]]; then
  log "Attribution config not found at ${CONFIG_FILE}; using defaults."
  TMPCONFIG=$(mktemp)
  echo "$DEFAULT_CONFIG" > "$TMPCONFIG"
  CONFIG_FILE="$TMPCONFIG"
  trap 'rm -f "$TMPCONFIG"' EXIT
fi

log "Using attribution config: ${CONFIG_FILE}"
log "Fetching cost report from ${API_BASE_URL}/api/costs/report ..."

# ── Fetch cost data ───────────────────────────────────────────────────────────
REPORT=$(curl -sf "${API_BASE_URL}/api/costs/report" \
  -H "Accept: application/json") \
  || { echo "ERROR: Could not reach ${API_BASE_URL}/api/costs/report" >&2; exit 1; }

TOTAL_STROOPS=$(echo "$REPORT" | jq -r '.totalStroops // 0')
TOTAL_XLM=$(echo "$REPORT"    | jq -r '.totalXlm    // 0')
TOTAL_USD=$(echo "$REPORT"    | jq -r '.totalUsd    // 0')
TOTAL_CALLS=$(echo "$REPORT"  | jq -r '.totalCalls  // 0')

# ── Build attribution table ───────────────────────────────────────────────────
# For each team, sum the stroops/calls of its owned operations.
ATTRIBUTION=$(jq -n \
  --argjson config "$(cat "$CONFIG_FILE")" \
  --argjson report "$REPORT" \
  --arg total_stroops "$TOTAL_STROOPS" \
  '{
    teams: ($config.teams | to_entries | map({
      team: .key,
      operations: .value,
      calls: (
        .value | map(
          ($report.operations // [] | map(select(.name == .)) | .[0] | .calls // 0)
        ) | add // 0
      ),
      totalStroops: (
        .value | map(
          ($report.operations // [] | map(select(.name == .)) | .[0] | .totalStroops // 0)
        ) | add // 0
      )
    })) | sort_by(-.totalStroops)
  }')

# ── Print report ──────────────────────────────────────────────────────────────
echo ""
hr
echo "  QuorumProof Cost Attribution  —  $(date -u '+%Y-%m-%d %H:%M UTC')"
hr
echo ""
printf "  %-18s %8s %14s %8s %10s\n" \
  "Team" "Calls" "Stroops" "XLM" "% Share"
echo ""

echo "$ATTRIBUTION" | jq -r \
  --argjson total "$TOTAL_STROOPS" \
  '.teams[] | [
    .team,
    .calls,
    .totalStroops,
    (.totalStroops / 10000000 | tostring | .[0:8]),
    (if $total > 0 then (.totalStroops / $total * 100 | floor) else 0 end)
  ] | @tsv' 2>/dev/null \
  | while IFS=$'\t' read -r team calls stroops xlm pct; do
      printf "  %-18s %8s %14s %8s %9s%%\n" \
        "$team" "$calls" "$stroops" "$xlm" "$pct"
    done

echo ""
hr
printf "  %-18s %8s %14s %8s\n" \
  "TOTAL" "$TOTAL_CALLS" "$TOTAL_STROOPS" "$TOTAL_XLM"
printf "  %-18s %8s\n" "(USD)" "$TOTAL_USD"
hr
echo ""

# Identify unattributed operations
ATTRIBUTED_OPS=$(jq -r \
  '.teams | to_entries | .[].value | .[]' \
  "$CONFIG_FILE" 2>/dev/null | sort -u)

UNATTRIBUTED=$(echo "$REPORT" | jq -r \
  '.operations // [] | .[].name' 2>/dev/null \
  | grep -vFf <(echo "$ATTRIBUTED_OPS") \
  | head -n 20 || true)

if [[ -n "$UNATTRIBUTED" ]]; then
  echo "  Unattributed operations (add to ${CONFIG_FILE}):"
  echo "$UNATTRIBUTED" | while read -r op; do
    echo "    - $op"
  done
  echo ""
fi

hr
echo "  Generated by scripts/cost_attribution.sh  —  Issue #1657"
hr
echo ""

# ── Optional JSON output ──────────────────────────────────────────────────────
COMBINED=$(jq -n \
  --argjson attribution "$ATTRIBUTION" \
  --argjson report "$REPORT" \
  --arg ts "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  '{timestamp: $ts, attribution: $attribution, raw: $report}')

if [[ -n "$OUTPUT_FILE" ]]; then
  echo "$COMBINED" > "$OUTPUT_FILE"
  log "Full JSON attribution written to: $OUTPUT_FILE"
fi

if $EMIT_JSON; then
  echo "$COMBINED"
fi

log "Done."
