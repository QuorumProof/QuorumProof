#!/usr/bin/env bash
# scripts/check_env_parity.sh — #1662 Environment parity checker.
#
# Compares two environment files for drift: missing keys, extra keys,
# placeholder values, network consistency, contract address format, and
# required-var presence. Outputs a color-coded report and optionally writes
# a machine-readable drift report to a file.
#
# Usage:
#   ./scripts/check_env_parity.sh [OPTIONS]
#
# Options:
#   --env1 <file>        First env file  (default: .env)
#   --env2 <file>        Second env file (default: .env.example)
#   --report <file>      Write drift report to <file> (text or JSON depending on --format)
#   --format <text|json> Output format for --report (default: text)
#   --fail-on-drift      Exit 1 if any drift is found
#   --help               Show this help

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
ENVIRONMENTS_FILE="$PROJECT_ROOT/environments.toml"

# ── Colours ──────────────────────────────────────────────────────────────────
RED='\033[0;31m'
YELLOW='\033[1;33m'
GREEN='\033[0;32m'
CYAN='\033[0;36m'
BOLD='\033[1m'
RESET='\033[0m'

# Disable colours when not writing to a terminal
if [ ! -t 1 ]; then
    RED='' YELLOW='' GREEN='' CYAN='' BOLD='' RESET=''
fi

# ── Defaults ──────────────────────────────────────────────────────────────────
ENV1="$PROJECT_ROOT/.env"
ENV2="$PROJECT_ROOT/.env.example"
REPORT_FILE=""
FORMAT="text"
FAIL_ON_DRIFT=0

# ── Argument parsing ──────────────────────────────────────────────────────────
while [[ $# -gt 0 ]]; do
    case "$1" in
        --env1)   ENV1="$2";        shift 2 ;;
        --env2)   ENV2="$2";        shift 2 ;;
        --report) REPORT_FILE="$2"; shift 2 ;;
        --format)
            FORMAT="$2"
            if [[ "$FORMAT" != "text" && "$FORMAT" != "json" ]]; then
                echo "ERROR: --format must be 'text' or 'json'" >&2
                exit 1
            fi
            shift 2
            ;;
        --fail-on-drift) FAIL_ON_DRIFT=1; shift ;;
        --help)
            sed -n '/^# Usage:/,/^[^#]/{ /^#/{ s/^# \{0,2\}//; p }; /^[^#]/q }' "$0"
            exit 0
            ;;
        *) echo "ERROR: Unknown option: $1" >&2; exit 1 ;;
    esac
done

# ── Helpers ───────────────────────────────────────────────────────────────────

# Parse a key=value env file; strips comments and blank lines.
# Prints only the KEY names (one per line).
parse_keys() {
    local file="$1"
    grep -v '^\s*#' "$file" \
        | grep -v '^\s*$' \
        | sed 's/=.*//' \
        | sed 's/^\s*//;s/\s*$//' \
        | sort
}

# Return the value for a given KEY from a file.
get_value() {
    local file="$1"
    local key="$2"
    grep -v '^\s*#' "$file" \
        | { grep "^${key}=" || true; } \
        | head -1 \
        | sed "s/^${key}=//" \
        | sed "s/^['\"]//;s/['\"]$//"
}

# ── Drift accumulators ────────────────────────────────────────────────────────
MISSING_KEYS=()       # keys in env2 not in env1
EXTRA_KEYS=()         # keys in env1 not in env2
PLACEHOLDER_VARS=()   # keys with <...> or change-me values in env1
NETWORK_ISSUES=()     # network / RPC consistency issues
CONTRACT_ISSUES=()    # contract address format issues
REQUIRED_MISSING=()   # required vars absent or empty in env1

REQUIRED_VARS=(
    STELLAR_NETWORK
    STELLAR_RPC_URL
    CONTRACT_QUORUM_PROOF
    CONTRACT_SBT_REGISTRY
    CONTRACT_ZK_VERIFIER
)

# ── Verify files exist ────────────────────────────────────────────────────────
if [ ! -f "$ENV1" ]; then
    echo -e "${RED}ERROR:${RESET} env1 file not found: $ENV1" >&2
    echo "       (copy .env.example to .env and configure it first)" >&2
    exit 1
fi
if [ ! -f "$ENV2" ]; then
    echo -e "${RED}ERROR:${RESET} env2 file not found: $ENV2" >&2
    exit 1
fi

echo -e "${BOLD}QuorumProof Environment Parity Checker${RESET}"
echo -e "  env1 (primary):  ${CYAN}$ENV1${RESET}"
echo -e "  env2 (reference): ${CYAN}$ENV2${RESET}"
echo ""

# ── CHECK 1: Missing keys (in env2 but not in env1) ──────────────────────────
echo -e "${BOLD}[1/6] Missing keys${RESET}"

KEYS1=$(parse_keys "$ENV1")
KEYS2=$(parse_keys "$ENV2")

while IFS= read -r key; do
    if [ -z "$key" ]; then continue; fi
    if ! echo "$KEYS1" | grep -qx "$key"; then
        MISSING_KEYS+=("$key")
    fi
done <<< "$KEYS2"

if [ ${#MISSING_KEYS[@]} -eq 0 ]; then
    echo -e "  ${GREEN}✓ No missing keys${RESET}"
else
    for key in "${MISSING_KEYS[@]}"; do
        echo -e "  ${RED}✗ MISSING:${RESET} $key  (present in $(basename "$ENV2"), absent from $(basename "$ENV1"))"
    done
fi
echo ""

# ── CHECK 2: Extra keys (in env1 but not in env2) ────────────────────────────
echo -e "${BOLD}[2/6] Extra keys${RESET}"

while IFS= read -r key; do
    if [ -z "$key" ]; then continue; fi
    if ! echo "$KEYS2" | grep -qx "$key"; then
        EXTRA_KEYS+=("$key")
    fi
done <<< "$KEYS1"

if [ ${#EXTRA_KEYS[@]} -eq 0 ]; then
    echo -e "  ${GREEN}✓ No extra keys${RESET}"
else
    for key in "${EXTRA_KEYS[@]}"; do
        echo -e "  ${YELLOW}⚠ EXTRA:${RESET} $key  (present in $(basename "$ENV1"), absent from $(basename "$ENV2"))"
    done
fi
echo ""

# ── CHECK 3: Placeholder values ───────────────────────────────────────────────
echo -e "${BOLD}[3/6] Placeholder values${RESET}"

while IFS= read -r key; do
    if [ -z "$key" ]; then continue; fi
    val=$(get_value "$ENV1" "$key")
    # Match <...> or change-me (case-insensitive)
    if [[ "$val" == \<*\> ]] || echo "$val" | grep -qi "change-me"; then
        PLACEHOLDER_VARS+=("$key=$val")
    fi
done <<< "$KEYS1"

if [ ${#PLACEHOLDER_VARS[@]} -eq 0 ]; then
    echo -e "  ${GREEN}✓ No placeholder values detected${RESET}"
else
    for entry in "${PLACEHOLDER_VARS[@]}"; do
        key="${entry%%=*}"
        val="${entry#*=}"
        echo -e "  ${YELLOW}⚠ PLACEHOLDER:${RESET} $key=\"$val\""
    done
fi
echo ""

# ── CHECK 4: Network consistency ─────────────────────────────────────────────
echo -e "${BOLD}[4/6] Network consistency${RESET}"

NETWORK=$(get_value "$ENV1" "STELLAR_NETWORK")
RPC_URL=$(get_value "$ENV1" "STELLAR_RPC_URL")

if [ -z "$NETWORK" ]; then
    NETWORK_ISSUES+=("STELLAR_NETWORK is not set in $(basename "$ENV1")")
elif [ ! -f "$ENVIRONMENTS_FILE" ]; then
    NETWORK_ISSUES+=("environments.toml not found at $ENVIRONMENTS_FILE — cannot verify network")
else
    # Confirm network is known in environments.toml
    if ! grep -q "^\[$NETWORK\]" "$ENVIRONMENTS_FILE" 2>/dev/null; then
        NETWORK_ISSUES+=("STELLAR_NETWORK=$NETWORK is not defined in environments.toml (valid: testnet, mainnet, futurenet, standalone)")
    else
        # Extract the canonical RPC URL for this network
        CANONICAL_RPC=$(grep -A 3 "^\[$NETWORK\]" "$ENVIRONMENTS_FILE" | grep "rpc_url" | cut -d'"' -f2)
        if [ -z "$CANONICAL_RPC" ]; then
            NETWORK_ISSUES+=("Could not read rpc_url for [$NETWORK] from environments.toml")
        elif [ -n "$RPC_URL" ] && [ "$RPC_URL" != "$CANONICAL_RPC" ]; then
            NETWORK_ISSUES+=("STELLAR_RPC_URL mismatch for network=$NETWORK: env has \"$RPC_URL\", environments.toml expects \"$CANONICAL_RPC\"")
        fi

        # Cross-check VITE_STELLAR_NETWORK if present
        VITE_NETWORK=$(get_value "$ENV1" "VITE_STELLAR_NETWORK")
        if [ -n "$VITE_NETWORK" ] && [ "$VITE_NETWORK" != "$NETWORK" ]; then
            NETWORK_ISSUES+=("VITE_STELLAR_NETWORK=$VITE_NETWORK does not match STELLAR_NETWORK=$NETWORK")
        fi

        # Cross-check VITE_STELLAR_RPC_URL if present
        VITE_RPC=$(get_value "$ENV1" "VITE_STELLAR_RPC_URL")
        if [ -n "$VITE_RPC" ] && [ -n "$RPC_URL" ] && [ "$VITE_RPC" != "$RPC_URL" ]; then
            NETWORK_ISSUES+=("VITE_STELLAR_RPC_URL=$VITE_RPC does not match STELLAR_RPC_URL=$RPC_URL")
        fi
    fi
fi

if [ ${#NETWORK_ISSUES[@]} -eq 0 ]; then
    echo -e "  ${GREEN}✓ Network configuration is consistent${RESET}"
    [ -n "$NETWORK" ] && echo -e "    STELLAR_NETWORK=${CYAN}$NETWORK${RESET}"
    [ -n "$RPC_URL" ]  && echo -e "    STELLAR_RPC_URL=${CYAN}$RPC_URL${RESET}"
else
    for issue in "${NETWORK_ISSUES[@]}"; do
        echo -e "  ${RED}✗ NETWORK DRIFT:${RESET} $issue"
    done
fi
echo ""

# ── CHECK 5: Contract address format ─────────────────────────────────────────
echo -e "${BOLD}[5/6] Contract address format${RESET}"

CONTRACT_VARS=()
while IFS= read -r key; do
    if [[ "$key" == CONTRACT_* ]]; then
        CONTRACT_VARS+=("$key")
    fi
done <<< "$KEYS1"

for key in "${CONTRACT_VARS[@]}"; do
    val=$(get_value "$ENV1" "$key")
    if [ -z "$val" ]; then
        continue  # empty — handled by required-vars check
    fi
    # Skip obvious placeholders (already caught by check 3)
    if [[ "$val" == \<*\> ]] || echo "$val" | grep -qi "change-me"; then
        continue
    fi
    # Stellar contract IDs: 56-character base32 string starting with 'C'
    if ! echo "$val" | grep -qE '^C[A-Z2-7]{55}$'; then
        CONTRACT_ISSUES+=("$key=\"$val\" (expected 56-char Stellar contract ID starting with 'C')")
    fi
done

if [ ${#CONTRACT_ISSUES[@]} -eq 0 ]; then
    echo -e "  ${GREEN}✓ All contract address formats look valid${RESET}"
else
    for issue in "${CONTRACT_ISSUES[@]}"; do
        echo -e "  ${RED}✗ INVALID FORMAT:${RESET} $issue"
    done
fi
echo ""

# ── CHECK 6: Required vars ────────────────────────────────────────────────────
echo -e "${BOLD}[6/6] Required variables${RESET}"

for var in "${REQUIRED_VARS[@]}"; do
    val=$(get_value "$ENV1" "$var" 2>/dev/null || true)
    if [ -z "$val" ]; then
        REQUIRED_MISSING+=("$var (not set or empty)")
    elif [[ "$val" == \<*\> ]] || echo "$val" | grep -qi "change-me"; then
        REQUIRED_MISSING+=("$var (contains placeholder: \"$val\")")
    fi
done

if [ ${#REQUIRED_MISSING[@]} -eq 0 ]; then
    echo -e "  ${GREEN}✓ All required variables are set${RESET}"
else
    for entry in "${REQUIRED_MISSING[@]}"; do
        echo -e "  ${RED}✗ REQUIRED MISSING:${RESET} $entry"
    done
fi
echo ""

# ── Summary ───────────────────────────────────────────────────────────────────
TOTAL_DRIFT=$(( ${#MISSING_KEYS[@]} + ${#PLACEHOLDER_VARS[@]} + ${#NETWORK_ISSUES[@]} + ${#CONTRACT_ISSUES[@]} + ${#REQUIRED_MISSING[@]} ))
TOTAL_WARNINGS=${#EXTRA_KEYS[@]}

echo -e "${BOLD}━━━ Summary ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
if [ $TOTAL_DRIFT -eq 0 ] && [ $TOTAL_WARNINGS -eq 0 ]; then
    echo -e "  ${GREEN}${BOLD}✓ No drift detected — environments are in parity.${RESET}"
else
    [ $TOTAL_DRIFT -gt 0 ] && \
        echo -e "  ${RED}✗ $TOTAL_DRIFT drift issue(s) found${RESET}"
    [ $TOTAL_WARNINGS -gt 0 ] && \
        echo -e "  ${YELLOW}⚠ $TOTAL_WARNINGS warning(s) (extra keys)${RESET}"
fi
echo ""

# ── Write report file ─────────────────────────────────────────────────────────
if [ -n "$REPORT_FILE" ]; then
    TIMESTAMP=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

    if [ "$FORMAT" = "json" ]; then
        # Build JSON arrays
        json_array() {
            local -n arr=$1
            local out="["
            local first=1
            for item in "${arr[@]+"${arr[@]}"}"; do
                escaped=$(echo "$item" | sed 's/\\/\\\\/g; s/"/\\"/g')
                [ $first -eq 0 ] && out+=","
                out+="\"$escaped\""
                first=0
            done
            out+="]"
            echo "$out"
        }

        cat > "$REPORT_FILE" <<EOF
{
  "generated_at": "$TIMESTAMP",
  "env1": "$ENV1",
  "env2": "$ENV2",
  "drift_count": $TOTAL_DRIFT,
  "warning_count": $TOTAL_WARNINGS,
  "missing_keys": $(json_array MISSING_KEYS),
  "extra_keys": $(json_array EXTRA_KEYS),
  "placeholder_vars": $(json_array PLACEHOLDER_VARS),
  "network_issues": $(json_array NETWORK_ISSUES),
  "contract_issues": $(json_array CONTRACT_ISSUES),
  "required_missing": $(json_array REQUIRED_MISSING)
}
EOF
    else
        {
            echo "QuorumProof Environment Parity Report"
            echo "Generated: $TIMESTAMP"
            echo "env1: $ENV1"
            echo "env2: $ENV2"
            echo "drift_count: $TOTAL_DRIFT"
            echo "warning_count: $TOTAL_WARNINGS"
            echo ""
            echo "=== Missing Keys (${#MISSING_KEYS[@]}) ==="
            for k in "${MISSING_KEYS[@]+"${MISSING_KEYS[@]}"}"; do echo "  - $k"; done
            echo ""
            echo "=== Extra Keys (${#EXTRA_KEYS[@]}) ==="
            for k in "${EXTRA_KEYS[@]+"${EXTRA_KEYS[@]}"}"; do echo "  - $k"; done
            echo ""
            echo "=== Placeholder Values (${#PLACEHOLDER_VARS[@]}) ==="
            for k in "${PLACEHOLDER_VARS[@]+"${PLACEHOLDER_VARS[@]}"}"; do echo "  - $k"; done
            echo ""
            echo "=== Network Issues (${#NETWORK_ISSUES[@]}) ==="
            for k in "${NETWORK_ISSUES[@]+"${NETWORK_ISSUES[@]}"}"; do echo "  - $k"; done
            echo ""
            echo "=== Contract Format Issues (${#CONTRACT_ISSUES[@]}) ==="
            for k in "${CONTRACT_ISSUES[@]+"${CONTRACT_ISSUES[@]}"}"; do echo "  - $k"; done
            echo ""
            echo "=== Required Variables Missing (${#REQUIRED_MISSING[@]}) ==="
            for k in "${REQUIRED_MISSING[@]+"${REQUIRED_MISSING[@]}"}"; do echo "  - $k"; done
        } > "$REPORT_FILE"
    fi

    echo -e "  Report written to: ${CYAN}$REPORT_FILE${RESET}"
    echo ""
fi

# ── Exit code ─────────────────────────────────────────────────────────────────
if [ "$FAIL_ON_DRIFT" -eq 1 ] && [ $TOTAL_DRIFT -gt 0 ]; then
    echo -e "${RED}Exiting with status 1 (--fail-on-drift is set and drift was found).${RESET}" >&2
    exit 1
fi

exit 0
