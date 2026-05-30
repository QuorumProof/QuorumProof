#!/usr/bin/env bash
# scripts/deploy_multi_region.sh — Deploy QuorumProof contracts to multiple Stellar networks.
#
# Usage:
#   ./scripts/deploy_multi_region.sh [--networks testnet,mainnet] [--verify]
#
# Requires: soroban CLI, jq

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"

# Load .env if present
if [[ -f "$ROOT_DIR/.env" ]]; then
  # shellcheck disable=SC1091
  source "$ROOT_DIR/.env"
fi

NETWORKS="${STELLAR_NETWORKS:-testnet,mainnet}"
VERIFY=false
DEPLOYMENT_LOG="$ROOT_DIR/deployments.log"

# Parse arguments
while [[ $# -gt 0 ]]; do
  case $1 in
    --networks)
      NETWORKS="$2"
      shift 2
      ;;
    --verify)
      VERIFY=true
      shift
      ;;
    *)
      echo "Unknown option: $1"
      exit 1
      ;;
  esac
done

# Initialize deployment log
{
  echo "=== Multi-Region Deployment Log ==="
  echo "Timestamp: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "Networks: $NETWORKS"
  echo ""
} > "$DEPLOYMENT_LOG"

# Build contracts
echo "==> Building contracts..."
./scripts/build.sh

# Deploy to each network
IFS=',' read -ra NETWORK_ARRAY <<< "$NETWORKS"
DEPLOYMENT_RESULTS=()

for NETWORK in "${NETWORK_ARRAY[@]}"; do
  NETWORK=$(echo "$NETWORK" | xargs)  # Trim whitespace
  
  echo ""
  echo "==> Deploying to $NETWORK..."
  
  # Configure network
  stellar network add --rpc-url "$(get_rpc_url "$NETWORK")" "$NETWORK" 2>/dev/null || true
  
  # Deploy contracts
  DEPLOY_OUTPUT=$(mktemp)
  if soroban contract deploy \
    --wasm target/wasm32-unknown-unknown/release/quorum_proof.wasm \
    --network "$NETWORK" \
    --source-account deployer > "$DEPLOY_OUTPUT" 2>&1; then
    
    CONTRACT_ID=$(grep -oP 'Contract ID: \K[^[:space:]]+' "$DEPLOY_OUTPUT" || echo "")
    
    if [[ -n "$CONTRACT_ID" ]]; then
      echo "    ✓ Deployed to $NETWORK: $CONTRACT_ID"
      
      # Log deployment
      {
        echo "Network: $NETWORK"
        echo "Contract ID: $CONTRACT_ID"
        echo "Timestamp: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
        echo ""
      } >> "$DEPLOYMENT_LOG"
      
      DEPLOYMENT_RESULTS+=("$NETWORK:$CONTRACT_ID")
      
      # Verify deployment if requested
      if [[ "$VERIFY" == true ]]; then
        verify_deployment "$NETWORK" "$CONTRACT_ID"
      fi
    else
      echo "    ✗ Failed to extract contract ID from $NETWORK"
      DEPLOYMENT_RESULTS+=("$NETWORK:FAILED")
    fi
  else
    echo "    ✗ Deployment to $NETWORK failed"
    cat "$DEPLOY_OUTPUT"
    DEPLOYMENT_RESULTS+=("$NETWORK:FAILED")
  fi
  
  rm -f "$DEPLOY_OUTPUT"
done

# Summary
echo ""
echo "==> Deployment Summary"
echo "    Log: $DEPLOYMENT_LOG"
echo ""

for RESULT in "${DEPLOYMENT_RESULTS[@]}"; do
  IFS=':' read -r NETWORK CONTRACT_ID <<< "$RESULT"
  if [[ "$CONTRACT_ID" == "FAILED" ]]; then
    echo "    ✗ $NETWORK: FAILED"
  else
    echo "    ✓ $NETWORK: $CONTRACT_ID"
  fi
done

# Check for failures
FAILED_COUNT=$(printf '%s\n' "${DEPLOYMENT_RESULTS[@]}" | grep -c "FAILED" || true)
if [[ $FAILED_COUNT -gt 0 ]]; then
  echo ""
  echo "⚠️  $FAILED_COUNT deployment(s) failed"
  exit 1
fi

echo ""
echo "==> Multi-region deployment complete"
