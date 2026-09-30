#!/bin/bash
# cli/commands/deploy.sh — Contract deployment CLI for QuorumProof.
#
# Wraps the stellar CLI to deploy one or all contracts to the specified network
# and writes a JSON deployment manifest on success.
#
# Usage:
#   ./cli/qp deploy [options]
#   ./cli/commands/deploy.sh [options]
#
# Options:
#   --network <testnet|mainnet|futurenet|standalone>  Target network (default: testnet)
#   --contract <quorum_proof|sbt_registry|zk_verifier|all>  Contract to deploy (default: all)
#   --wasm-dir <path>        Directory containing compiled .wasm files
#                            (default: target/wasm32-unknown-unknown/release)
#   --dry-run                Print deployment commands without executing them
#   --manifest <path>        Output path for the JSON deployment manifest
#                            (default: deployment-<network>.json)
#   --source <key>           Stellar key name to sign with (default: deployer)
#   --help, -h               Show this help message

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
BOLD='\033[1m'
RESET='\033[0m'

info()  { echo -e "${GREEN}[deploy]${RESET} $*"; }
warn()  { echo -e "${YELLOW}[deploy] WARNING:${RESET} $*" >&2; }
error() { echo -e "${RED}[deploy] ERROR:${RESET} $*" >&2; }
step()  { echo -e "${BOLD}[deploy]${RESET} $*"; }

# ── Help ──────────────────────────────────────────────────────────────────────
print_help() {
  echo -e "${BOLD}qp deploy${RESET} — Deploy QuorumProof contracts to a Stellar network"
  echo ""
  echo -e "${BOLD}USAGE${RESET}"
  echo "  ./cli/qp deploy [options]"
  echo ""
  echo -e "${BOLD}OPTIONS${RESET}"
  echo "  --network <network>   Target network: testnet|mainnet|futurenet|standalone"
  echo "                        (default: testnet, or \$STELLAR_NETWORK)"
  echo "  --contract <name>     Contract to deploy: quorum_proof|sbt_registry|zk_verifier|all"
  echo "                        (default: all)"
  echo "  --wasm-dir <path>     Directory with compiled .wasm files"
  echo "                        (default: target/wasm32-unknown-unknown/release)"
  echo "  --dry-run             Print commands without executing them"
  echo "  --manifest <path>     Deployment manifest output path"
  echo "                        (default: deployment-<network>.json)"
  echo "  --source <key>        Stellar signing key name (default: deployer)"
  echo "  --help, -h            Show this help message"
  echo ""
  echo -e "${BOLD}EXAMPLES${RESET}"
  echo "  # Deploy all contracts to testnet"
  echo "  ./cli/qp deploy --network testnet"
  echo ""
  echo "  # Deploy only the zk_verifier to mainnet"
  echo "  ./cli/qp deploy --network mainnet --contract zk_verifier"
  echo ""
  echo "  # Dry-run to preview deployment commands"
  echo "  ./cli/qp deploy --network testnet --dry-run"
  echo ""
  echo "  # Use a custom WASM directory and manifest path"
  echo "  ./cli/qp deploy --wasm-dir ./target/release --manifest ./my-manifest.json"
  echo ""
  echo -e "${BOLD}OUTPUT${RESET}"
  echo "  On success a JSON manifest is written to <manifest>:"
  echo "    { \"network\": \"testnet\", \"deployed_at\": \"...\","
  echo "      \"deployer\": \"G...\", \"contracts\": { ... } }"
}

# ── Argument defaults ─────────────────────────────────────────────────────────
NETWORK="${STELLAR_NETWORK:-testnet}"
CONTRACT="all"
WASM_DIR="${WASM_DIR:-$PROJECT_ROOT/target/wasm32-unknown-unknown/release}"
DRY_RUN=false
MANIFEST_PATH=""
SOURCE_KEY="deployer"

# ── Parse arguments ────────────────────────────────────────────────────────────
while [ $# -gt 0 ]; do
  case "$1" in
    --help|-h)
      print_help
      exit 0
      ;;
    --network)
      [ $# -ge 2 ] || { error "--network requires a value"; exit 2; }
      NETWORK="$2"; shift 2
      ;;
    --contract)
      [ $# -ge 2 ] || { error "--contract requires a value"; exit 2; }
      CONTRACT="$2"; shift 2
      ;;
    --wasm-dir)
      [ $# -ge 2 ] || { error "--wasm-dir requires a value"; exit 2; }
      WASM_DIR="$2"; shift 2
      ;;
    --dry-run)
      DRY_RUN=true; shift
      ;;
    --manifest)
      [ $# -ge 2 ] || { error "--manifest requires a value"; exit 2; }
      MANIFEST_PATH="$2"; shift 2
      ;;
    --source)
      [ $# -ge 2 ] || { error "--source requires a value"; exit 2; }
      SOURCE_KEY="$2"; shift 2
      ;;
    *)
      error "Unknown option: '$1'"
      echo "Run './cli/qp deploy --help' for usage."
      exit 2
      ;;
  esac
done

# ── Validate inputs ────────────────────────────────────────────────────────────
case "$NETWORK" in
  testnet|mainnet|futurenet|standalone) ;;
  *)
    error "Invalid network: '$NETWORK'"
    error "Valid networks: testnet, mainnet, futurenet, standalone"
    exit 2
    ;;
esac

case "$CONTRACT" in
  quorum_proof|sbt_registry|zk_verifier|all) ;;
  *)
    error "Invalid contract: '$CONTRACT'"
    error "Valid contracts: quorum_proof, sbt_registry, zk_verifier, all"
    exit 2
    ;;
esac

# Default manifest path based on network
if [ -z "$MANIFEST_PATH" ]; then
  MANIFEST_PATH="$PROJECT_ROOT/deployment-${NETWORK}.json"
fi

# ── Dependency check ────────────────────────────────────────────────────────────
if ! command -v stellar &>/dev/null; then
  error "stellar CLI not found. Install it from https://stellar.org/developers"
  exit 1
fi

# ── Helpers ────────────────────────────────────────────────────────────────────

# Run or print a command depending on --dry-run
run_cmd() {
  if [ "$DRY_RUN" = true ]; then
    echo -e "${YELLOW}[dry-run]${RESET} $*"
  else
    "$@"
  fi
}

# Deploy a single contract and return its address (stdout)
deploy_contract() {
  local name="$1"       # e.g. quorum_proof
  local wasm_file="$WASM_DIR/${name}.wasm"

  if [ ! -f "$wasm_file" ] && [ "$DRY_RUN" = false ]; then
    error "WASM file not found: $wasm_file"
    error "Build contracts first with: ./scripts/build.sh"
    exit 1
  fi

  step "Deploying $name from $wasm_file ..."

  if [ "$DRY_RUN" = true ]; then
    echo -e "${YELLOW}[dry-run]${RESET} stellar contract deploy --wasm \"$wasm_file\" --source $SOURCE_KEY --network $NETWORK"
    echo "DRYRUN_ADDRESS_${name}"
    return 0
  fi

  local address
  address=$(stellar contract deploy \
    --wasm "$wasm_file" \
    --source "$SOURCE_KEY" \
    --network "$NETWORK")

  echo "$address"
}

# ── Main deployment logic ─────────────────────────────────────────────────────
if [ "$DRY_RUN" = true ]; then
  warn "DRY RUN — no actual deployments will be made."
fi

step "Target network: $NETWORK"
step "Contract(s):    $CONTRACT"
step "WASM directory: $WASM_DIR"
step "Manifest path:  $MANIFEST_PATH"
step "Source key:     $SOURCE_KEY"
echo ""

# Ensure the deployer key exists (create+fund on non-mainnet if missing)
if [ "$DRY_RUN" = false ]; then
  if [ "$NETWORK" != "mainnet" ]; then
    info "Ensuring deployer key '$SOURCE_KEY' exists on $NETWORK ..."
    stellar keys generate "$SOURCE_KEY" --network "$NETWORK" --fund 2>/dev/null || true
  else
    # On mainnet, key must already exist
    if ! stellar keys address "$SOURCE_KEY" &>/dev/null; then
      error "Signing key '$SOURCE_KEY' not found. Generate it first:"
      error "  stellar keys generate $SOURCE_KEY"
      exit 1
    fi
  fi
  DEPLOYER_ADDRESS=$(stellar keys address "$SOURCE_KEY")
  info "Deployer address: $DEPLOYER_ADDRESS"
else
  DEPLOYER_ADDRESS="DRYRUN_DEPLOYER_ADDRESS"
fi

# Preserve previous manifest
if [ -f "$MANIFEST_PATH" ] && [ "$DRY_RUN" = false ]; then
  cp "$MANIFEST_PATH" "${MANIFEST_PATH}.previous"
  info "Previous manifest saved to ${MANIFEST_PATH}.previous"
fi

# Deploy the requested contracts
ADDR_QUORUM_PROOF="${CONTRACT_QUORUM_PROOF:-null}"
ADDR_SBT_REGISTRY="${CONTRACT_SBT_REGISTRY:-null}"
ADDR_ZK_VERIFIER="${CONTRACT_ZK_VERIFIER:-null}"

if [ "$CONTRACT" = "all" ] || [ "$CONTRACT" = "quorum_proof" ]; then
  ADDR_QUORUM_PROOF=$(deploy_contract quorum_proof)
  info "quorum_proof deployed: $ADDR_QUORUM_PROOF"
fi

if [ "$CONTRACT" = "all" ] || [ "$CONTRACT" = "sbt_registry" ]; then
  ADDR_SBT_REGISTRY=$(deploy_contract sbt_registry)
  info "sbt_registry deployed:  $ADDR_SBT_REGISTRY"
fi

if [ "$CONTRACT" = "all" ] || [ "$CONTRACT" = "zk_verifier" ]; then
  ADDR_ZK_VERIFIER=$(deploy_contract zk_verifier)
  info "zk_verifier deployed:   $ADDR_ZK_VERIFIER"
fi

# ── Write manifest ────────────────────────────────────────────────────────────
DEPLOYED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

MANIFEST_JSON=$(cat <<EOF
{
  "network": "$NETWORK",
  "deployed_at": "$DEPLOYED_AT",
  "deployer": "$DEPLOYER_ADDRESS",
  "wasm_dir": "$WASM_DIR",
  "contracts": {
    "quorum_proof": "$ADDR_QUORUM_PROOF",
    "sbt_registry": "$ADDR_SBT_REGISTRY",
    "zk_verifier": "$ADDR_ZK_VERIFIER"
  }
}
EOF
)

if [ "$DRY_RUN" = false ]; then
  echo "$MANIFEST_JSON" > "$MANIFEST_PATH"
  info "Deployment manifest written to $MANIFEST_PATH"
else
  warn "Dry run — manifest not written. Would write to $MANIFEST_PATH:"
fi

# Pretty-print the manifest using jq if available, otherwise raw
echo ""
if command -v jq &>/dev/null; then
  echo "$MANIFEST_JSON" | jq .
else
  echo "$MANIFEST_JSON"
fi

if [ "$DRY_RUN" = false ]; then
  echo ""
  echo -e "${GREEN}✓ Deployment complete.${RESET}"
else
  echo ""
  echo -e "${YELLOW}✓ Dry run complete. No changes made.${RESET}"
fi
