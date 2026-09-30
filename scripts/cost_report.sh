#!/usr/bin/env bash
# scripts/cost_report.sh — Issue #1657: Cost tracking and reporting.
#
# Queries the QuorumProof API cost endpoints and emits a human-readable report
# plus optional JSON output for downstream tooling (CI, dashboards).
#
# Usage:
#   ./scripts/cost_report.sh [--json] [--top N] [--output FILE]
#
# Options:
#   --json          Emit raw JSON report to stdout in addition to the summary
#   --top N         Show top N cost contributors (default: 10)
#   --output FILE   Write full JSON report to FILE instead of stdout
#   --days N        Days window for projection (default: 30)
#   --calls N       Hypothetical calls/day for projection (default: 10000)
#
# Environment variables:
#   API_BASE_URL    — Base URL of the QuorumProof API (default: http://localhost:3001)
#   XLM_USD_PRICE   — XLM/USD price for cost conversion (default: fetched from API)

set -euo pipefail

API_BASE_URL="${API_BASE_URL:-http://localhost:3001}"
TOP="${TOP:-10}"
DAYS="${DAYS:-30}"
CALLS_PER_DAY="${CALLS_PER_DAY:-10000}"
OUTPUT_FILE=""
EMIT_JSON=false

# ── Argument parsing ──────────────────────────────────────────────────────────
while [[ $# -gt 0 ]]; do
  case "$1" in
    --json)       EMIT_JSON=true ;;
    --top)        TOP="${2:?--top requires a number}"; shift ;;
    --output)     OUTPUT_FILE="${2:?--output requires a path}"; shift ;;
    --days)       DAYS="${2:?--days requires a number}"; shift ;;
    --calls)      CALLS_PER_DAY="${2:?--calls requires a number}"; shift ;;
    *)            echo "Unknown option: $1" >&2; exit 1 ;;
  esac
  shift
done

log()  { echo "[$(date -u +%H:%M:%SZ)] $*"; }
hr()   { printf '%0.s─' {1..70}; echo; }

require_cmd() { command -v "$1" &>/dev/null || { echo "Required: $1"; exit 1; }; }
require_cmd curl
require_cmd jq

# ── Fetch cost report ─────────────────────────────────────────────────────────
log "Fetching cost report from ${API_BASE_URL}/api/costs/report ..."
REPORT=$(curl -sf "${API_BASE_URL}/api/costs/report" \
  -H "Accept: application/json") \
  || { echo "ERROR: Could not reach ${API_BASE_URL}/api/costs/report" >&2; exit 1; }

# ── Fetch optimization candidates ─────────────────────────────────────────────
log "Fetching optimization candidates (top=${TOP}) ..."
OPTS=$(curl -sf "${API_BASE_URL}/api/costs/optimizations?top=${TOP}" \
  -H "Accept: application/json") \
  || OPTS='{"candidates":[]}'

# ── Print human-readable summary ──────────────────────────────────────────────
echo ""
hr
echo "  QuorumProof Cost Report  —  $(date -u '+%Y-%m-%d %H:%M UTC')"
hr
echo ""

TOTAL_CALLS=$(echo "$REPORT" | jq -r '.totalCalls // 0')
TOTAL_STROOPS=$(echo "$REPORT" | jq -r '.totalStroops // 0')
TOTAL_XLM=$(echo "$REPORT" | jq -r '.totalXlm // 0')
TOTAL_USD=$(echo "$REPORT" | jq -r '.totalUsd // 0')

printf "  %-28s %12s\n" "Total API calls recorded:"    "$TOTAL_CALLS"
printf "  %-28s %12s stroops\n" "Total fees paid:"      "$TOTAL_STROOPS"
printf "  %-28s %12s XLM\n"  "Total fees (XLM):"        "$TOTAL_XLM"
printf "  %-28s %12s USD\n"  "Total fees (USD):"         "$TOTAL_USD"
echo ""

# Per-operation breakdown
hr
echo "  Per-Operation Breakdown (sorted by total cost)"
hr
printf "  %-30s %8s %12s %12s %10s\n" \
  "Operation" "Calls" "Total(stps)" "Avg(stps)" "% of Total"
echo ""

echo "$REPORT" | jq -r \
  --argjson total "$TOTAL_STROOPS" \
  '.operations[] | [.name, .calls, .totalStroops, .avgStroops,
    (if $total > 0 then (.totalStroops / $total * 100 | floor) else 0 end)] |
    @tsv' 2>/dev/null \
  | head -n "$TOP" \
  | while IFS=$'\t' read -r name calls total_s avg_s pct; do
      printf "  %-30s %8s %12s %12s %9s%%\n" \
        "$name" "$calls" "$total_s" "$avg_s" "$pct"
    done

echo ""

# Optimization candidates
hr
echo "  Top Optimization Candidates"
hr

CANDIDATES=$(echo "$OPTS" | jq -r '.candidates // [] | .[]' 2>/dev/null) || CANDIDATES=""

if [[ -z "$CANDIDATES" ]]; then
  echo "  No optimization candidates returned (API may not have enough data yet)."
else
  echo "$OPTS" | jq -r \
    '.candidates[] | "  • " + .operation + ": " + .recommendation + " (savings: " + (.estimatedSavingsXlm | tostring) + " XLM/day at 10k calls)"' \
    2>/dev/null || echo "  (Could not parse candidates)"
fi

echo ""

# ── Cost projections ──────────────────────────────────────────────────────────
hr
echo "  Cost Projections  —  ${CALLS_PER_DAY} calls/day × ${DAYS} days"
hr
echo ""

TOP_OPS=$(echo "$REPORT" | jq -r '[.operations[] | .name] | .[0:5] | .[]' 2>/dev/null) || TOP_OPS=""

for OP in $TOP_OPS; do
  PROJ=$(curl -sf \
    "${API_BASE_URL}/api/costs/projection?operation=$(python3 -c "import urllib.parse,sys; print(urllib.parse.quote(sys.argv[1]))" "$OP" 2>/dev/null || echo "$OP")&callsPerDay=${CALLS_PER_DAY}&days=${DAYS}" \
    -H "Accept: application/json" 2>/dev/null) || PROJ=""

  if [[ -n "$PROJ" ]]; then
    PROJ_XLM=$(echo "$PROJ" | jq -r '.projectedXlm // "N/A"')
    PROJ_USD=$(echo "$PROJ" | jq -r '.projectedUsd // "N/A"')
    printf "  %-30s %10s XLM  %10s USD\n" "$OP" "$PROJ_XLM" "$PROJ_USD"
  fi
done

echo ""
hr
echo "  Report generated by scripts/cost_report.sh  —  Issue #1657"
hr
echo ""

# ── Optional JSON output ──────────────────────────────────────────────────────
COMBINED=$(jq -n \
  --argjson report "$REPORT" \
  --argjson opts "$OPTS" \
  --arg ts "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  '{timestamp: $ts, report: $report, optimizations: $opts}')

if [[ -n "$OUTPUT_FILE" ]]; then
  echo "$COMBINED" > "$OUTPUT_FILE"
  log "Full JSON report written to: $OUTPUT_FILE"
fi

if $EMIT_JSON; then
  echo "$COMBINED"
fi

log "Done."
