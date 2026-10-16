#!/bin/bash
# cli/commands/verify.sh — Credential verification CLI for QuorumProof.
#
# Queries the quorum_proof contract to retrieve a credential and check its
# attestation status. Uses `stellar contract invoke` under the hood.
#
# Usage:
#   ./cli/qp verify [options]
#   ./cli/commands/verify.sh [options]
#
# Options:
#   --credential-id <id>        Credential ID to look up (required)
#   --network <network>         Stellar network to query (default: testnet)
#   --contract <address>        quorum_proof contract address
#                               (default: $CONTRACT_QUORUM_PROOF from .env)
#   --output <json|table|minimal>  Output format (default: table)
#   --source <key>              Stellar key for simulation (default: deployer)
#   --help, -h                  Show this help message

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

info()  { echo -e "${GREEN}[verify]${RESET} $*"; }
warn()  { echo -e "${YELLOW}[verify] WARNING:${RESET} $*" >&2; }
error() { echo -e "${RED}[verify] ERROR:${RESET} $*" >&2; }

# ── Help ──────────────────────────────────────────────────────────────────────
print_help() {
  echo -e "${BOLD}qp verify${RESET} — Verify a QuorumProof credential by ID"
  echo ""
  echo -e "${BOLD}USAGE${RESET}"
  echo "  ./cli/qp verify --credential-id <id> [options]"
  echo ""
  echo -e "${BOLD}OPTIONS${RESET}"
  echo "  --credential-id <id>    Credential ID to look up (required)"
  echo "  --network <network>     Network to query: testnet|mainnet|futurenet|standalone"
  echo "                          (default: testnet, or \$STELLAR_NETWORK)"
  echo "  --contract <address>    quorum_proof contract address"
  echo "                          (default: \$CONTRACT_QUORUM_PROOF)"
  echo "  --output <format>       Output format: json|table|minimal"
  echo "                          (default: table)"
  echo "  --source <key>          Stellar key for simulation (default: deployer)"
  echo "  --help, -h              Show this help message"
  echo ""
  echo -e "${BOLD}EXAMPLES${RESET}"
  echo "  # Verify credential 42 on testnet"
  echo "  ./cli/qp verify --credential-id 42"
  echo ""
  echo "  # JSON output for scripting"
  echo "  ./cli/qp verify --credential-id 42 --output json"
  echo ""
  echo "  # Minimal single-line status"
  echo "  ./cli/qp verify --credential-id 42 --output minimal"
  echo ""
  echo "  # Specify network and contract explicitly"
  echo "  ./cli/qp verify --credential-id 42 --network mainnet --contract C..."
  echo ""
  echo -e "${BOLD}OUTPUT FORMATS${RESET}"
  echo "  table    Human-readable table with all credential fields (default)"
  echo "  json     Machine-readable JSON (pretty-printed with jq if available)"
  echo "  minimal  Single line: <id> <type> <attested:true|false>"
  echo ""
  echo -e "${BOLD}EXIT CODES${RESET}"
  echo "  0  Credential found and attested"
  echo "  1  Error (contract call failed, credential not found, etc.)"
  echo "  2  Usage error (bad arguments)"
}

# ── Argument defaults ─────────────────────────────────────────────────────────
CREDENTIAL_ID=""
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
    --credential-id)
      [ $# -ge 2 ] || { error "--credential-id requires a value"; exit 2; }
      CREDENTIAL_ID="$2"; shift 2
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
      echo "Run './cli/qp verify --help' for usage."
      exit 2
      ;;
  esac
done

# ── Validate inputs ────────────────────────────────────────────────────────────
if [ -z "$CREDENTIAL_ID" ]; then
  error "--credential-id is required"
  echo ""
  print_help
  exit 2
fi

# Validate credential ID is a non-negative integer
if ! [[ "$CREDENTIAL_ID" =~ ^[0-9]+$ ]]; then
  error "Invalid credential ID: '$CREDENTIAL_ID' (must be a non-negative integer)"
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
  json|table|minimal) ;;
  *)
    error "Invalid output format: '$OUTPUT_FORMAT'"
    error "Valid formats: json, table, minimal"
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

# invoke_contract <fn_name> <extra_args...> — calls stellar contract invoke
# and returns the raw output. Exits 1 on failure.
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

# ── Fetch credential data ─────────────────────────────────────────────────────
if [ "$OUTPUT_FORMAT" != "minimal" ]; then
  info "Querying credential #$CREDENTIAL_ID on $NETWORK ..."
fi

# get_credential returns the Credential struct serialised by Soroban
RAW_CREDENTIAL=$(invoke_contract get_credential --id "$CREDENTIAL_ID")

# is_attested returns a boolean
RAW_ATTESTED=$(invoke_contract is_attested --id "$CREDENTIAL_ID")

# Normalise the attestation value to a simple boolean string
case "$RAW_ATTESTED" in
  true|"true"|1|"\"true\"") ATTESTED="true" ;;
  *) ATTESTED="false" ;;
esac

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
  "credential_id": $CREDENTIAL_ID,
  "attested": $ATTESTED,
  "raw_credential": $RAW_CREDENTIAL
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
    echo -e "${BOLD}╔══════════════════════════════════════╗${RESET}"
    echo -e "${BOLD}║     QuorumProof Credential Report    ║${RESET}"
    echo -e "${BOLD}╚══════════════════════════════════════╝${RESET}"
    echo ""
    printf "  %-20s %s\n" "Credential ID:"   "$CREDENTIAL_ID"
    printf "  %-20s %s\n" "Network:"         "$NETWORK"
    printf "  %-20s %s\n" "Contract:"        "$CONTRACT_ADDRESS"
    printf "  %-20s %s\n" "Queried at:"      "$TIMESTAMP"
    echo ""
    printf "  %-20s %s\n" "Raw credential:"
    echo "$RAW_CREDENTIAL" | sed 's/^/    /'
    echo ""
    if [ "$ATTESTED" = "true" ]; then
      echo -e "  Attestation status: ${GREEN}✓ ATTESTED${RESET}"
    else
      echo -e "  Attestation status: ${RED}✗ NOT ATTESTED${RESET}"
    fi
    echo ""
    ;;

  # ── Minimal ───────────────────────────────────────────────────────────────
  minimal)
    echo "$CREDENTIAL_ID attested:$ATTESTED"
    ;;
esac

# Exit with 0 if attested, 1 if not attested (allows use in shell conditionals)
if [ "$ATTESTED" = "true" ]; then
  exit 0
else
  if [ "$OUTPUT_FORMAT" = "table" ]; then
    warn "Credential #$CREDENTIAL_ID is not yet attested."
  fi
  exit 1
fi
