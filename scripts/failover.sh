#!/usr/bin/env bash
# scripts/failover.sh — Manage RPC endpoint failover and consistency verification.
#
# Usage:
#   ./scripts/failover.sh --check              # Check all RPC endpoints
#   ./scripts/failover.sh --switch <endpoint>  # Switch to alternate endpoint
#   ./scripts/failover.sh --verify             # Verify consistency across regions
#
# Requires: curl, jq, stellar (CLI, used by --verify)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"

# Load .env if present
if [[ -f "$ROOT_DIR/.env" ]]; then
  # shellcheck disable=SC1091
  source "$ROOT_DIR/.env"
fi

# RPC endpoints. Overridable via env (same convention as CONTRACT_IDS below)
# so tests can point --check/--verify at fake endpoints without touching the
# real network.
declare -A RPC_ENDPOINTS=(
  ["testnet"]="${RPC_TESTNET:-https://soroban-testnet.stellar.org}"
  ["testnet-backup"]="${RPC_TESTNET_BACKUP:-https://horizon-testnet.stellar.org}"
  ["mainnet"]="${RPC_MAINNET:-https://soroban-mainnet.stellar.org}"
  ["mainnet-backup"]="${RPC_MAINNET_BACKUP:-https://horizon.stellar.org}"
)

# Contract IDs
declare -A CONTRACT_IDS=(
  ["testnet"]="${CONTRACT_QUORUM_PROOF_TESTNET:-}"
  ["mainnet"]="${CONTRACT_QUORUM_PROOF_MAINNET:-}"
)

# Strip a leading "--" so the documented --check/--switch/--verify flags
# (used throughout this file's own usage comment) actually match below.
# Also fixes: previously only bare `check`/`switch`/`verify` matched, so
# every documented invocation fell through to the usage/error branch.
COMMAND="${1:-check}"
COMMAND="${COMMAND#--}"

# Horizon exposes no JSON-RPC and has no /health route; Soroban RPC is
# JSON-RPC only and has no REST routes at all. They need different checks.
is_horizon_endpoint() {
  [[ "$1" == *horizon* ]]
}

# Check RPC endpoint health using the protocol each endpoint actually speaks.
check_endpoint() {
  local endpoint="$1"
  local timeout=5
  local body

  if is_horizon_endpoint "$endpoint"; then
    # Horizon's root endpoint returns its landing-page JSON on success
    # (history_latest_ledger, horizon_version, ...). There is no /health.
    body=$(curl -s --max-time "$timeout" "$endpoint/" 2>/dev/null) || return 1
    echo "$body" | jq -e '.horizon_version' > /dev/null 2>&1
  else
    # Soroban RPC is JSON-RPC only; getHealth is the documented health
    # check and returns {"result":{"status":"healthy"}} on success.
    body=$(curl -s --max-time "$timeout" -X POST "$endpoint" \
      -H 'Content-Type: application/json' \
      -d '{"jsonrpc":"2.0","id":1,"method":"getHealth"}' 2>/dev/null) || return 1
    [[ "$(echo "$body" | jq -r '.result.status // empty' 2>/dev/null)" == "healthy" ]]
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

# Sentinel for "could not determine this endpoint's count", as distinct from
# a genuine count of 0 (RPC failure, unreachable endpoint, or an endpoint —
# e.g. Horizon — that cannot serve contract state at all).
UNKNOWN_MARKER="UNKNOWN"

# Query credential_count via a real Soroban RPC call (stellar contract invoke
# simulates the contract's get_credential_count read against $endpoint),
# following the same pattern already used for cross-instance comparison in
# scripts/reconcile_state.sh's query_counter. Prints $UNKNOWN_MARKER — never
# 0 — on any failure, so an unreachable/incompatible endpoint can't be
# mistaken for a genuine empty state.
query_credential_count() {
  local contract="$1" network="$2" endpoint="$3"
  local raw
  # Always returns 0: printing $UNKNOWN_MARKER *is* the successful outcome
  # for a failed query. Callers capture this via plain assignment under
  # `set -e`, where a non-zero return here would abort the whole script.
  if raw=$(stellar contract invoke \
    --id "$contract" \
    --network "$network" \
    --rpc-url "$endpoint" \
    -- get_credential_count 2>/dev/null | tr -d '"'); then
    if [[ "$raw" =~ ^-?[0-9]+$ ]]; then
      echo "$raw"
      return 0
    fi
  fi
  echo "$UNKNOWN_MARKER"
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

    # Get credential count from this network's own primary and backup
    # endpoints only.
    # Also fixes: this previously matched every "*backup*" key regardless of
    # network (e.g. mainnet-backup was queried using the testnet contract
    # id), which made the comparison meaningless.
    #
    # Also fixes: `declare -A counts` alone does not clear a pre-existing
    # array at this scope, so with both testnet and mainnet configured the
    # second iteration silently inherited stale entries from the first
    # (visible once compared with `${!counts[@]}` below). `=()` resets it.
    declare -A counts=()

    for endpoint_name in "$network" "$network-backup"; do
      endpoint="${RPC_ENDPOINTS[$endpoint_name]:-}"
      if [[ -z "$endpoint" ]]; then
        continue
      fi
      counts["$endpoint_name"]=$(query_credential_count "$contract_id" "$network" "$endpoint")
    done

    # Compare counts. Any UNKNOWN makes the result explicitly unverifiable —
    # it must never be treated as a matching value.
    echo "    $network ($contract_id):"

    local first_count=""
    local consistent=true
    local unverifiable=false

    for endpoint_name in "${!counts[@]}"; do
      count="${counts[$endpoint_name]}"

      if [[ "$count" == "$UNKNOWN_MARKER" ]]; then
        unverifiable=true
      elif [[ -z "$first_count" ]]; then
        first_count="$count"
      elif [[ "$count" != "$first_count" ]]; then
        consistent=false
      fi

      echo "      $endpoint_name: $count credentials"
    done

    if [[ "$unverifiable" == true ]]; then
      echo "      ? Could not verify (one or more endpoints did not return a valid count)"
    elif [[ "$consistent" == true ]]; then
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
