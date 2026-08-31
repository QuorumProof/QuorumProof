#!/bin/bash
set -e

# Validate environments.toml configuration against .env settings
# Ensures STELLAR_NETWORK selection matches CONTRACT addresses on the correct RPC endpoint

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
ENVIRONMENTS_FILE="$PROJECT_ROOT/environments.toml"

# Load environment variables (exit gracefully if .env doesn't exist)
if [ -f "$PROJECT_ROOT/.env" ]; then
    set +e
    # shellcheck disable=SC2046
    export $(grep -v '^#' "$PROJECT_ROOT/.env" | xargs)
    set -e
fi

# Validate required environment variables
validate_env_var() {
    local var_name=$1
    local var_value=${!var_name}

    if [ -z "$var_value" ]; then
        echo "ERROR: $var_name is not set in .env"
        return 1
    fi

    # Check if value is a placeholder
    if [[ "$var_value" == "<"* ]] || [[ "$var_value" == "change-me"* ]]; then
        echo "ERROR: $var_name is not configured (contains placeholder or default value)"
        return 1
    fi

    return 0
}

# Check if STELLAR_NETWORK is configured
if [ -z "$STELLAR_NETWORK" ]; then
    echo "ERROR: STELLAR_NETWORK is not set in .env"
    exit 1
fi

# Validate network is in environments.toml
if ! grep -q "^\[$STELLAR_NETWORK\]" "$ENVIRONMENTS_FILE"; then
    echo "ERROR: STELLAR_NETWORK=$STELLAR_NETWORK is not defined in $ENVIRONMENTS_FILE"
    echo "Valid networks: testnet, mainnet, futurenet, standalone"
    exit 1
fi

# Extract RPC URL from environments.toml
RPC_URL=$(grep -A 2 "^\[$STELLAR_NETWORK\]" "$ENVIRONMENTS_FILE" | grep "rpc_url" | cut -d'"' -f2)

if [ -z "$RPC_URL" ]; then
    echo "ERROR: Could not extract RPC URL for network=$STELLAR_NETWORK from $ENVIRONMENTS_FILE"
    exit 1
fi

echo "✓ STELLAR_NETWORK=$STELLAR_NETWORK is valid"
echo "✓ RPC endpoint: $RPC_URL"

# Validate contract addresses exist and are configured
CONTRACTS=("CONTRACT_QUORUM_PROOF" "CONTRACT_SBT_REGISTRY" "CONTRACT_ZK_VERIFIER")
VALIDATION_FAILED=0

for contract_var in "${CONTRACTS[@]}"; do
    if ! validate_env_var "$contract_var"; then
        VALIDATION_FAILED=1
    fi
done

if [ $VALIDATION_FAILED -eq 1 ]; then
    exit 1
fi

echo "✓ All contract addresses are configured"

# Attempt to verify contracts exist on RPC endpoint (if curl available)
if command -v curl &> /dev/null; then
    verify_contract_on_network() {
        local contract_id=$1
        local rpc_url=$2
        local network=$3

        # Use Stellar RPC getContractData endpoint to verify contract exists
        # This is a lightweight check that doesn't require contract-specific knowledge
        local payload=$(cat <<EOF
{
    "jsonrpc": "2.0",
    "id": 1,
    "method": "getLedgerEntries",
    "params": {
        "keys": ["$contract_id"]
    }
}
EOF
)

        local response
        response=$(curl -s -X POST "$rpc_url" \
            -H "Content-Type: application/json" \
            -d "$payload" 2>/dev/null || echo "")

        # Check for RPC connection error
        if [ -z "$response" ]; then
            echo "WARNING: Could not connect to RPC endpoint: $rpc_url"
            echo "         Skipping contract verification. Verify manually or check network connectivity."
            return 0
        fi

        # Check if contract is found (ledger entry exists)
        if echo "$response" | grep -q "\"entries\"" && ! echo "$response" | grep -q "\"error\""; then
            return 0
        fi

        # Could be "contract not yet deployed" or "wrong network"
        if echo "$response" | grep -q "resourceNotFound\|not found"; then
            return 1
        fi

        return 0
    }

    echo ""
    echo "Verifying contracts on $STELLAR_NETWORK..."

    NETWORK_MISMATCH=0
    for contract_var in "${CONTRACTS[@]}"; do
        contract_id=${!contract_var}
        if ! verify_contract_on_network "$contract_id" "$RPC_URL" "$STELLAR_NETWORK"; then
            echo "ERROR: Contract $contract_var=$contract_id not found on $STELLAR_NETWORK"
            echo "       This could mean:"
            echo "       1. The contract has not been deployed to $STELLAR_NETWORK yet"
            echo "       2. STELLAR_NETWORK is set incorrectly (contract deployed to different network)"
            NETWORK_MISMATCH=1
        fi
    done

    if [ $NETWORK_MISMATCH -eq 1 ]; then
        exit 1
    fi

    echo "✓ All contracts verified on $STELLAR_NETWORK"
else
    echo "WARNING: curl not found; skipping RPC verification of contract addresses"
    echo "         Ensure contracts are manually deployed to the $STELLAR_NETWORK network"
fi

echo ""
echo "✓ Environment configuration is valid"
exit 0
