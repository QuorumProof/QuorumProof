#!/bin/bash
# cli/commands/analyze.sh — Quorum slice analysis CLI for QuorumProof.
#
# Queries the quorum_proof contract for a slice's configuration and computes
# coverage metrics: how many attestors have signed vs. the threshold required.
#
# Usage:
#   ./cli/qp analyze [options]
#   ./cli/commands/analyze.sh [options]
#
# Options:
#   --slice-id <id>           Slice ID to analyze (required)
#   --network <network>       Stellar network to query (default: testnet)
#   --contract <address>      quorum_proof contract address
#                             (default: $CONTRACT_QUORUM_PROOF from .env)
#   --output <json|table>     Output format (default: table)
#   --source <key>            Stellar key for simulation (default: deployer)
#   --help, -h                Show this help message

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CLI_DIR="$(dirname "$SCRIPT_DIR")"
PROJECT_ROOT="$(dirname "$CLI_DIR")"

# Load environment if present
if [ -f "$PROJECT_ROOT/.env" ]; then
  # shellcheck disable=SC1091
  source "$PROJECT_ROOT/.env"
fi

# ── ANSI colour helpers ────────────────────────────────────────────────────────
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
CYAN='\033[0;36m'
BOLD='\033[1m'
RESET='\033[0m'

info()  { echo -e "${GREEN}[analyze]${RESET} $*"; }
warn()  { echo -e "${YELLOW}[analyze] WARNING:${RESET} $*" >&2; }
error() { echo -e "${RED}[analyze] ERROR:${RESET} $*" >&2; }

# ── Help ──────────────────────────────────────────────────────────────────────
print_help() {
  echo -e "${BOLD}qp analyze${RESET} — Analyze a QuorumProof quorum slice"
  echo ""
  echo -e "${BOLD}USAGE${RESET}"
  echo "  ./cli/qp analyze --slice-id <id> [options]"
  echo ""
  echo -e "${BOLD}OPTIONS${RESET}"
  echo "  --slice-id <id>       Slice ID to analyze (required)"
  echo "  --network <network>   Network to query: testnet|mainnet|futurenet|standalone"
  echo "                        (default: testnet, or \$STELLAR_NETWORK)"
  echo "  --contract <address>  quorum_proof contract address"
  echo "                        (default: \$CONTRACT_QUORUM_PROOF)"
  echo "  --output <format>     Output format: json|table (default: table)"
  echo "  --source <key>        Stellar key for simulation (default: deployer)"
  echo "  --help, -h            Show this help message"
  echo ""
  echo -e "${BOLD}EXAMPLES${RESET}"
  echo "  # Analyze slice 7 on testnet"
  echo "  ./cli/qp analyze --slice-id 7"
  echo ""
  echo "  # JSON output for scripting"
  echo "  ./cli/qp analyze --slice-id 7 --output json"
  echo ""
  echo "  # Query mainnet with an explicit contract address"
  echo "  ./cli/qp analyze --slice-id 7 --network mainnet --contract C..."
  echo ""
  echo -e "${BOLD}OUTPUT${RESET}"
  echo "  Reports the slice's attestors, threshold requirement, and coverage:"
  echo "    attested_count / total_attestors >= threshold => QUORUM REACHED"
  echo ""
  echo -e "${BOLD}EXIT CODES${RESET}"
  echo "  0  Quorum reached (attested >= threshold)"
  echo "  1  Quorum not reached or error"
  echo "  2  Usage error (bad arguments)"
}

# ── Argument defaults ─────────────────────────────────────────────────────────
SLICE_ID=""
NETWORK="${STELLAR_NETWORK:-testnet}"
CONTRACT_ADDRESS="${CONTRACT_QUORUM_PROOF:-}"
OUTPUT_FORMAT="table"
SOURCE_KEY="deployer"

# ── Parse arguments ────────────────────────────────────────────────────────────
while [ $# -gt 0 ]; do
  case "$1" in
    --help|-h)
      print_help
      exit 0
      ;;
    --slice-id)
      [ $# -ge 2 ] || { error "--slice-id requires a value"; exit 2; }
      SLICE_ID="$2"; shift 2
      ;;
    --network)
      [ $# -ge 2 ] || { error "--network requires a value"; exit 2; }
      NETWORK="$2"; shift 2
      ;;
    --contract)
      [ $# -ge 2 ] || { error "--contract requires a value"; exit 2; }
      CONTRACT_ADDRESS="$2"; shift 2
      ;;
    --output)
      [ $# -ge 2 ] || { error "--output requires a value"; exit 2; }
      OUTPUT_FORMAT="$2"; shift 2
      ;;
    --source)
      [ $# -ge 2 ] || { error "--source requires a value"; exit 2; }
      SOURCE_KEY="$2"; shift 2
      ;;
    *)
      error "Unknown option: '$1'"
      echo "Run './cli/qp analyze --help' for usage."
      exit 2
      ;;
  esac
done

# ── Validate inputs ────────────────────────────────────────────────────────────
if [ -z "$SLICE_ID" ]; then
  error "--slice-id is required"
  echo ""
  print_help
  exit 2
fi

if ! [[ "$SLICE_ID" =~ ^[0-9]+$ ]]; then
  error "Invalid slice ID: '$SLICE_ID' (must be a non-negative integer)"
  exit 2
fi

case "$NETWORK" in
  testnet|mainnet|futurenet|standalone) ;;
  *)
    error "Invalid network: '$NETWORK'"
    error "Valid networks: testnet, mainnet, futurenet, standalone"
    exit 2
    ;;
esac

case "$OUTPUT_FORMAT" in
  json|table) ;;
  *)
    error "Invalid output format: '$OUTPUT_FORMAT'"
    error "Valid formats: json, table"
    exit 2
    ;;
esac

if [ -z "$CONTRACT_ADDRESS" ]; then
  error "Contract address is required. Set \$CONTRACT_QUORUM_PROOF in .env or pass --contract <address>"
  exit 1
fi

# ── Dependency check ────────────────────────────────────────────────────────────
if ! command -v stellar &>/dev/null; then
  error "stellar CLI not found. Install it from https://stellar.org/developers"
  exit 1
fi

# ── Contract invocations ──────────────────────────────────────────────────────
invoke_contract() {
  local fn_name="$1"
  shift
  local output
  if ! output=$(stellar contract invoke \
    --id "$CONTRACT_ADDRESS" \
    --source "$SOURCE_KEY" \
    --network "$NETWORK" \
    -- "$fn_name" "$@" 2>&1); then
    error "Contract call '$fn_name' failed:"
    echo "$output" >&2
    exit 1
  fi
  echo "$output"
}

# ── Coverage computation ──────────────────────────────────────────────────────
# Parses a raw Soroban Vec output (e.g. ["G...", "G..."]) and counts elements.
# Returns 0 for an empty/null result.
count_elements() {
  local raw="$1"
  # Try jq first for reliable JSON parsing
  if command -v jq &>/dev/null; then
    local count
    count=$(echo "$raw" | jq 'if type == "array" then length else 0 end' 2>/dev/null || echo 0)
    echo "$count"
    return
  fi
  # Fallback: count comma-separated items inside brackets
  # Handles both ["a","b"] and [] cases
  local stripped
  stripped="${raw#\[}"
  stripped="${stripped%\]}"
  stripped="${stripped// /}"
  if [ -z "$stripped" ]; then
    echo 0
  else
    # Count elements by counting commas + 1
    local count=1
    count=$(echo "$stripped" | awk -F',' '{print NF}')
    echo "$count"
  fi
}

# Extract a numeric field from raw Soroban struct output.
# Soroban returns XDR-decoded structs; we do a best-effort grep parse.
extract_field() {
  local raw="$1"
  local field="$2"
  if command -v jq &>/dev/null; then
    echo "$raw" | jq -r ".$field // \"unknown\"" 2>/dev/null || echo "unknown"
  else
    # Naive: look for "field": value
    echo "$raw" | grep -o "\"$field\":[^,}]*" | head -1 | cut -d: -f2 | tr -d ' "' || echo "unknown"
  fi
}

# ── Fetch slice data ──────────────────────────────────────────────────────────
if [ "$OUTPUT_FORMAT" != "minimal" ]; then
  info "Querying slice #$SLICE_ID on $NETWORK ..."
fi

RAW_SLICE=$(invoke_contract get_slice --id "$SLICE_ID")
RAW_ATTESTORS=$(invoke_contract get_attestors --slice-id "$SLICE_ID")

# ── Parse threshold ────────────────────────────────────────────────────────────
# get_slice returns a QuorumSlice struct; extract the threshold field.
THRESHOLD=$(extract_field "$RAW_SLICE" "threshold")

# Count total attestors registered in the slice
TOTAL_ATTESTORS=$(count_elements "$RAW_ATTESTORS")

# Soroban returns a list of addresses that have signed; we count them as
# "attested". If the contract exposes attested count separately we use that;
# otherwise we use total_attestors as a proxy (all registered == signed).
# For real deployments, `get_attestors` returns only addresses that have called
# `attest()`. Adjust the logic below if your contract differs.
ATTESTED_COUNT="$TOTAL_ATTESTORS"

# Compute coverage percentage (requires integer arithmetic)
if [ "$TOTAL_ATTESTORS" -gt 0 ] 2>/dev/null; then
  COVERAGE_PCT=$(( (ATTESTED_COUNT * 100) / TOTAL_ATTESTORS ))
else
  COVERAGE_PCT=0
fi

# Determine quorum status
QUORUM_REACHED="false"
if [ "$THRESHOLD" != "unknown" ] && [[ "$THRESHOLD" =~ ^[0-9]+$ ]]; then
  if [ "$ATTESTED_COUNT" -ge "$THRESHOLD" ] 2>/dev/null; then
    QUORUM_REACHED="true"
  fi
else
  warn "Could not determine threshold from slice data; quorum status unknown."
fi

# ── Build attestor list ────────────────────────────────────────────────────────
# Produce a JSON array of attestor addresses for the JSON output.
if command -v jq &>/dev/null; then
  ATTESTOR_JSON_ARRAY=$(echo "$RAW_ATTESTORS" | jq -c '
    if type == "array" then . else [.] end
  ' 2>/dev/null || echo "[]")
else
  # Raw passthrough
  ATTESTOR_JSON_ARRAY="$RAW_ATTESTORS"
fi

# ── Output ─────────────────────────────────────────────────────────────────────
TIMESTAMP="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

case "$OUTPUT_FORMAT" in

  # ── JSON ──────────────────────────────────────────────────────────────────
  json)
    JSON_OUT=$(cat <<EOF
{
  "queried_at": "$TIMESTAMP",
  "network": "$NETWORK",
  "contract": "$CONTRACT_ADDRESS",
  "slice_id": $SLICE_ID,
  "threshold": "$THRESHOLD",
  "total_attestors": $TOTAL_ATTESTORS,
  "attested_count": $ATTESTED_COUNT,
  "coverage_pct": $COVERAGE_PCT,
  "quorum_reached": $QUORUM_REACHED,
  "attestors": $ATTESTOR_JSON_ARRAY
}
EOF
)
    if command -v jq &>/dev/null; then
      echo "$JSON_OUT" | jq .
    else
      echo "$JSON_OUT"
    fi
    ;;

  # ── Table ─────────────────────────────────────────────────────────────────
  table)
    echo ""
    echo -e "${BOLD}╔══════════════════════════════════════════╗${RESET}"
    echo -e "${BOLD}║      QuorumProof Slice Analysis Report   ║${RESET}"
    echo -e "${BOLD}╚══════════════════════════════════════════╝${RESET}"
    echo ""
    printf "  %-24s %s\n" "Slice ID:"            "$SLICE_ID"
    printf "  %-24s %s\n" "Network:"             "$NETWORK"
    printf "  %-24s %s\n" "Contract:"            "$CONTRACT_ADDRESS"
    printf "  %-24s %s\n" "Queried at:"          "$TIMESTAMP"
    echo ""
    printf "  %-24s %s\n" "Threshold required:"  "$THRESHOLD"
    printf "  %-24s %s\n" "Total attestors:"     "$TOTAL_ATTESTORS"
    printf "  %-24s %s\n" "Attested count:"      "$ATTESTED_COUNT"
    printf "  %-24s %s%%\n" "Coverage:"          "$COVERAGE_PCT"
    echo ""

    # Attestor list
    echo -e "  ${BOLD}Attestors:${RESET}"
    if command -v jq &>/dev/null; then
      echo "$ATTESTOR_JSON_ARRAY" | jq -r '.[] | "    • " + .' 2>/dev/null \
        || echo "    $RAW_ATTESTORS"
    else
      echo "    $RAW_ATTESTORS"
    fi
    echo ""

    # Quorum status banner
    if [ "$QUORUM_REACHED" = "true" ]; then
      echo -e "  Quorum status: ${GREEN}✓ QUORUM REACHED${RESET} ($ATTESTED_COUNT/$THRESHOLD attestors)"
    else
      if [ "$THRESHOLD" = "unknown" ]; then
        echo -e "  Quorum status: ${YELLOW}⚠ UNKNOWN${RESET} (could not parse threshold)"
      else
        echo -e "  Quorum status: ${RED}✗ QUORUM NOT REACHED${RESET} ($ATTESTED_COUNT/$THRESHOLD attestors)"
      fi
    fi
    echo ""
    ;;
esac

# Exit code reflects quorum status
if [ "$QUORUM_REACHED" = "true" ]; then
  exit 0
else
  exit 1
fi
