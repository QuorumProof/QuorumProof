#!/usr/bin/env bash
# scripts/failover.sh — Manage RPC endpoint failover and consistency verification.
#
# Usage:
#   ./scripts/failover.sh --check              # Check all RPC endpoints
#   ./scripts/failover.sh --switch <endpoint>  # Switch to alternate endpoint
#   ./scripts/failover.sh --verify             # Verify consistency across regions
#
# Requires: curl, jq

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"

# Load .env if present
if [[ -f "$ROOT_DIR/.env" ]]; then
  # shellcheck disable=SC1091
  source "$ROOT_DIR/.env"
fi

# RPC endpoints
declare -A RPC_ENDPOINTS=(
  ["testnet"]="https://soroban-testnet.stellar.org"
  ["testnet-backup"]="https://horizon-testnet.stellar.org"
  ["mainnet"]="https://soroban-mainnet.stellar.org"
  ["mainnet-backup"]="https://horizon.stellar.org"
)

# Contract IDs
declare -A CONTRACT_IDS=(
  ["testnet"]="${CONTRACT_QUORUM_PROOF_TESTNET:-}"
  ["mainnet"]="${CONTRACT_QUORUM_PROOF_MAINNET:-}"
)

COMMAND="${1:-check}"

# Check RPC endpoint health
check_endpoint() {
  local endpoint="$1"
  local timeout=5
  
  if curl -s --max-time "$timeout" "$endpoint/health" > /dev/null 2>&1; then
    return 0
  else
    return 1
  fi
}

# Check all endpoints
check_all() {
  echo "==> Checking RPC endpoint health..."
  echo ""
  
  for name in "${!RPC_ENDPOINTS[@]}"; do
    endpoint="${RPC_ENDPOINTS[$name]}"
    
    if check_endpoint "$endpoint"; then
      echo "    ✓ $name: $endpoint"
    else
      echo "    ✗ $name: $endpoint (unreachable)"
    fi
  done
}

# Switch to alternate endpoint
switch_endpoint() {
  local new_endpoint="$1"
  
  if [[ -z "$new_endpoint" ]]; then
    echo "Error: endpoint required"
    exit 1
  fi
  
  echo "==> Switching to $new_endpoint..."
  
  if check_endpoint "$new_endpoint"; then
    # Update .env
    sed -i "s|STELLAR_RPC_URL=.*|STELLAR_RPC_URL=$new_endpoint|" "$ROOT_DIR/.env"
    export STELLAR_RPC_URL="$new_endpoint"
    
    echo "    ✓ Switched to $new_endpoint"
    echo "    Updated .env"
  else
    echo "    ✗ Endpoint $new_endpoint is unreachable"
    exit 1
  fi
}

# Verify consistency across regions
verify_consistency() {
  echo "==> Verifying contract state consistency..."
  echo ""
  
  for network in "${!CONTRACT_IDS[@]}"; do
    contract_id="${CONTRACT_IDS[$network]}"
    
    if [[ -z "$contract_id" ]]; then
      echo "    ⊘ $network: No contract ID configured"
      continue
    fi
    
    # Get credential count from each endpoint
    declare -A counts
    
    for endpoint_name in "${!RPC_ENDPOINTS[@]}"; do
      if [[ "$endpoint_name" != *"backup"* ]]; then
        continue
      fi
      
      endpoint="${RPC_ENDPOINTS[$endpoint_name]}"
      
      if check_endpoint "$endpoint"; then
        # Query contract state
        count=$(curl -s "$endpoint/contracts/$contract_id/state" 2>/dev/null | jq '.credential_count // 0' || echo "0")
        counts["$endpoint_name"]="$count"
      fi
    done
    
    # Compare counts
    echo "    $network ($contract_id):"
    
    local first_count=""
    local consistent=true
    
    for endpoint_name in "${!counts[@]}"; do
      count="${counts[$endpoint_name]}"
      
      if [[ -z "$first_count" ]]; then
        first_count="$count"
      elif [[ "$count" != "$first_count" ]]; then
        consistent=false
      fi
      
      echo "      $endpoint_name: $count credentials"
    done
    
    if [[ "$consistent" == true ]]; then
      echo "      ✓ Consistent"
    else
      echo "      ✗ Inconsistent state detected"
    fi
    
    echo ""
  done
}

# Main
case "$COMMAND" in
  check)
    check_all
    ;;
  switch)
    if [[ $# -lt 2 ]]; then
      echo "Error: --switch requires endpoint argument"
      exit 1
    fi
    switch_endpoint "$2"
    ;;
  verify)
    verify_consistency
    ;;
  *)
    echo "Usage: $0 {check|switch|verify} [args]"
    exit 1
    ;;
esac
