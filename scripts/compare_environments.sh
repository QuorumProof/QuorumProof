#!/usr/bin/env bash
# scripts/compare_environments.sh — #1662 Multi-environment comparison tool.
#
# Compares named environment snapshots stored in the environments/ directory
# against the canonical values in environments.toml. Detects RPC URL
# mismatches, passphrase drift, and common config inconsistencies across
# environment pairs.
#
# Usage:
#   ./scripts/compare_environments.sh [OPTIONS]
#
# Options:
#   --envs <list>        Comma-separated environment names to compare
#                        (default: all found in environments/)
#                        Example: --envs testnet,mainnet
#   --report-dir <dir>   Directory to write per-comparison drift reports
#                        (default: no reports written)
#   --format <text|json> Output format for reports (default: text)
#   --fail-on-drift      Exit 1 if any drift found across all comparisons
#   --help               Show this help
#
# Environment snapshots:
#   Create a snapshot by copying your .env to environments/<name>.env, e.g.:
#     cp .env environments/testnet.env
#
#   The environments/ directory is .gitignore'd by default to avoid committing
#   secrets. Use environments/<name>.env.example for shareable templates.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
ENVIRONMENTS_FILE="$PROJECT_ROOT/environments.toml"
ENVIRONMENTS_DIR="$PROJECT_ROOT/environments"
PARITY_CHECKER="$SCRIPT_DIR/check_env_parity.sh"

# ── Colours ───────────────────────────────────────────────────────────────────
RED='\033[0;31m'
YELLOW='\033[1;33m'
GREEN='\033[0;32m'
CYAN='\033[0;36m'
BOLD='\033[1m'
RESET='\033[0m'

if [ ! -t 1 ]; then
    RED='' YELLOW='' GREEN='' CYAN='' BOLD='' RESET=''
fi

# ── Defaults ──────────────────────────────────────────────────────────────────
ENVS_ARG=""
REPORT_DIR=""
FORMAT="text"
FAIL_ON_DRIFT=0

# ── Argument parsing ──────────────────────────────────────────────────────────
while [[ $# -gt 0 ]]; do
    case "$1" in
        --envs)        ENVS_ARG="$2";  shift 2 ;;
        --report-dir)  REPORT_DIR="$2"; shift 2 ;;
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
get_value() {
    local file="$1" key="$2"
    grep -v '^\s*#' "$file" \
        | { grep "^${key}=" || true; } \
        | head -1 \
        | sed "s/^${key}=//" \
        | sed "s/^['\"]//;s/['\"]$//"
}

get_toml_value() {
    local section="$1" field="$2"
    grep -A 5 "^\[$section\]" "$ENVIRONMENTS_FILE" \
        | grep "^$field" \
        | head -1 \
        | cut -d'"' -f2
}

# ── Discover snapshot files ───────────────────────────────────────────────────
echo -e "${BOLD}QuorumProof Multi-Environment Comparison${RESET}"
echo ""

if [ ! -d "$ENVIRONMENTS_DIR" ]; then
    echo -e "${YELLOW}⚠ environments/ directory not found at $ENVIRONMENTS_DIR${RESET}"
    echo "  Create it and add snapshots: cp .env environments/testnet.env"
    echo ""
    # Create it so the user has a starting point
    mkdir -p "$ENVIRONMENTS_DIR"
    cat > "$ENVIRONMENTS_DIR/README.md" <<'ENVREADME'
# environments/

This directory holds per-named-network environment snapshots for the
QuorumProof parity checker.

## Creating a snapshot

```bash
cp .env environments/testnet.env
```

## File naming

Snapshot files must be named `<network-name>.env`, matching the section
headers in `environments.toml` (testnet, mainnet, futurenet, standalone).

## Security note

These files may contain secrets. The directory is `.gitignore`'d.
Commit only `*.env.example` files (with placeholder values).
ENVREADME
    echo -e "  Created ${CYAN}$ENVIRONMENTS_DIR/${RESET} with a README."
    echo ""
fi

# Collect snapshot files
declare -a SNAPSHOT_FILES=()
if [ -n "$ENVS_ARG" ]; then
    IFS=',' read -ra REQUESTED_ENVS <<< "$ENVS_ARG"
    for env_name in "${REQUESTED_ENVS[@]}"; do
        env_name="${env_name// /}"  # trim spaces
        candidate="$ENVIRONMENTS_DIR/${env_name}.env"
        if [ ! -f "$candidate" ]; then
            echo -e "${RED}ERROR:${RESET} Snapshot not found: $candidate" >&2
            exit 1
        fi
        SNAPSHOT_FILES+=("$candidate")
    done
else
    while IFS= read -r f; do
        SNAPSHOT_FILES+=("$f")
    done < <(find "$ENVIRONMENTS_DIR" -maxdepth 1 -name "*.env" ! -name "*.env.example" 2>/dev/null | sort)
fi

if [ ${#SNAPSHOT_FILES[@]} -eq 0 ]; then
    echo -e "${YELLOW}No snapshot files found in $ENVIRONMENTS_DIR${RESET}"
    echo "  To create one: cp .env environments/testnet.env"
    exit 0
fi

echo -e "  Found ${#SNAPSHOT_FILES[@]} snapshot file(s): "
for f in "${SNAPSHOT_FILES[@]}"; do
    echo -e "    ${CYAN}$(basename "$f")${RESET}"
done
echo ""

# ── Create report directory ───────────────────────────────────────────────────
if [ -n "$REPORT_DIR" ]; then
    mkdir -p "$REPORT_DIR"
fi

# ── Per-snapshot checks ───────────────────────────────────────────────────────
TOTAL_DRIFT=0
TIMESTAMP=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

for SNAP_FILE in "${SNAPSHOT_FILES[@]}"; do
    SNAP_NAME=$(basename "$SNAP_FILE" .env)
    echo -e "${BOLD}━━━ $SNAP_NAME ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"

    SNAP_DRIFT=0
    SNAP_ISSUES=()
    PARITY_OUTPUT=""
    PARITY_EXIT=0

    # ── 4a: RPC URL consistency ───────────────────────────────────────────────
    SNAP_NETWORK=$(get_value "$SNAP_FILE" "STELLAR_NETWORK")
    SNAP_RPC=$(get_value "$SNAP_FILE" "STELLAR_RPC_URL")

    if [ -z "$SNAP_NETWORK" ]; then
        SNAP_ISSUES+=("STELLAR_NETWORK not set in snapshot")
        SNAP_DRIFT=$((SNAP_DRIFT + 1))
    elif [ -f "$ENVIRONMENTS_FILE" ]; then
        CANONICAL_RPC=$(get_toml_value "$SNAP_NETWORK" "rpc_url")
        if [ -z "$CANONICAL_RPC" ]; then
            SNAP_ISSUES+=("Network '$SNAP_NETWORK' not found in environments.toml")
            SNAP_DRIFT=$((SNAP_DRIFT + 1))
        elif [ -n "$SNAP_RPC" ] && [ "$SNAP_RPC" != "$CANONICAL_RPC" ]; then
            SNAP_ISSUES+=("RPC URL mismatch: snapshot has \"$SNAP_RPC\", environments.toml expects \"$CANONICAL_RPC\"")
            SNAP_DRIFT=$((SNAP_DRIFT + 1))
        fi
    fi

    # ── 4b: Network passphrase consistency ────────────────────────────────────
    SNAP_PASSPHRASE=$(get_value "$SNAP_FILE" "STELLAR_NETWORK_PASSPHRASE")
    if [ -n "$SNAP_PASSPHRASE" ] && [ -n "$SNAP_NETWORK" ] && [ -f "$ENVIRONMENTS_FILE" ]; then
        CANONICAL_PASS=$(get_toml_value "$SNAP_NETWORK" "network_passphrase")
        if [ -n "$CANONICAL_PASS" ] && [ "$SNAP_PASSPHRASE" != "$CANONICAL_PASS" ]; then
            SNAP_ISSUES+=("Passphrase mismatch for $SNAP_NETWORK: snapshot has \"$SNAP_PASSPHRASE\", environments.toml has \"$CANONICAL_PASS\"")
            SNAP_DRIFT=$((SNAP_DRIFT + 1))
        fi
    fi

    # ── 4c: Common config consistency ─────────────────────────────────────────
    # VITE_ vars should mirror their non-VITE counterparts
    COMMON_PAIRS=(
        "STELLAR_NETWORK:VITE_STELLAR_NETWORK"
        "STELLAR_RPC_URL:VITE_STELLAR_RPC_URL"
        "CONTRACT_QUORUM_PROOF:VITE_CONTRACT_QUORUM_PROOF"
        "CONTRACT_SBT_REGISTRY:VITE_CONTRACT_SBT_REGISTRY"
        "CONTRACT_ZK_VERIFIER:VITE_CONTRACT_ZK_VERIFIER"
    )

    for pair in "${COMMON_PAIRS[@]}"; do
        backend_key="${pair%%:*}"
        frontend_key="${pair##*:}"
        bval=$(get_value "$SNAP_FILE" "$backend_key" 2>/dev/null || true)
        fval=$(get_value "$SNAP_FILE" "$frontend_key" 2>/dev/null || true)
        if [ -n "$bval" ] && [ -n "$fval" ] && [ "$bval" != "$fval" ]; then
            SNAP_ISSUES+=("Frontend/backend mismatch: $backend_key=\"$bval\" vs $frontend_key=\"$fval\"")
            SNAP_DRIFT=$((SNAP_DRIFT + 1))
        fi
    done

    # ── 4d: Cross-file parity check (against .env.example) ───────────────────
    ENV_EXAMPLE="$PROJECT_ROOT/.env.example"
    PARITY_REPORT=""
    PARITY_EXIT=0

    if [ -f "$PARITY_CHECKER" ] && [ -f "$ENV_EXAMPLE" ]; then
        PARITY_REPORT_FILE=""
        if [ -n "$REPORT_DIR" ]; then
            PARITY_REPORT_FILE="$REPORT_DIR/${SNAP_NAME}-parity.$FORMAT"
        fi

        PARITY_ARGS=(--env1 "$SNAP_FILE" --env2 "$ENV_EXAMPLE" --format "$FORMAT")
        [ -n "$PARITY_REPORT_FILE" ] && PARITY_ARGS+=(--report "$PARITY_REPORT_FILE")

        # Run parity check; capture output; don't let it abort us yet
        set +e
        PARITY_OUTPUT=$("$PARITY_CHECKER" "${PARITY_ARGS[@]}" 2>&1)
        PARITY_EXIT=$?
        set -e

        if [ $PARITY_EXIT -ne 0 ]; then
            SNAP_ISSUES+=("Parity check against .env.example reported drift (see detailed output below)")
            SNAP_DRIFT=$((SNAP_DRIFT + 1))
        fi
    fi

    # ── Print results for this snapshot ───────────────────────────────────────
    if [ ${#SNAP_ISSUES[@]} -eq 0 ]; then
        echo -e "  ${GREEN}✓ No drift detected for $SNAP_NAME${RESET}"
        [ -n "$SNAP_NETWORK" ] && echo -e "    network=${CYAN}$SNAP_NETWORK${RESET}  rpc=${CYAN}${SNAP_RPC:-<not set>}${RESET}"
    else
        for issue in "${SNAP_ISSUES[@]}"; do
            echo -e "  ${RED}✗${RESET} $issue"
        done
    fi

    # If parity check produced output and found issues, show it indented
    if [ -n "$PARITY_OUTPUT" ] && [ $PARITY_EXIT -ne 0 ]; then
        echo ""
        echo -e "  ${BOLD}Parity detail (vs .env.example):${RESET}"
        while IFS= read -r line; do
            echo "    $line"
        done <<< "$PARITY_OUTPUT"
    fi

    # ── Write per-snapshot summary report ─────────────────────────────────────
    if [ -n "$REPORT_DIR" ]; then
        SUMMARY_FILE="$REPORT_DIR/${SNAP_NAME}-summary.$FORMAT"

        if [ "$FORMAT" = "json" ]; then
            # Serialize issues array to JSON
            ISSUES_JSON="["
            first=1
            for issue in "${SNAP_ISSUES[@]+"${SNAP_ISSUES[@]}"}"; do
                escaped=$(echo "$issue" | sed 's/\\/\\\\/g; s/"/\\"/g')
                [ $first -eq 0 ] && ISSUES_JSON+=","
                ISSUES_JSON+="\"$escaped\""
                first=0
            done
            ISSUES_JSON+="]"

            cat > "$SUMMARY_FILE" <<EOF
{
  "generated_at": "$TIMESTAMP",
  "snapshot": "$SNAP_NAME",
  "snapshot_file": "$SNAP_FILE",
  "network": "${SNAP_NETWORK:-}",
  "rpc_url": "${SNAP_RPC:-}",
  "drift_count": $SNAP_DRIFT,
  "issues": $ISSUES_JSON
}
EOF
        else
            {
                echo "QuorumProof Environment Comparison Summary"
                echo "Generated: $TIMESTAMP"
                echo "Snapshot: $SNAP_NAME ($SNAP_FILE)"
                echo "Network: ${SNAP_NETWORK:-<not set>}"
                echo "RPC URL: ${SNAP_RPC:-<not set>}"
                echo "Drift count: $SNAP_DRIFT"
                echo ""
                echo "=== Issues ==="
                if [ ${#SNAP_ISSUES[@]} -eq 0 ]; then
                    echo "  (none)"
                else
                    for issue in "${SNAP_ISSUES[@]}"; do
                        echo "  - $issue"
                    done
                fi
            } > "$SUMMARY_FILE"
        fi
        echo -e "  Summary report: ${CYAN}$SUMMARY_FILE${RESET}"
    fi

    TOTAL_DRIFT=$((TOTAL_DRIFT + SNAP_DRIFT))
    unset SNAP_ISSUES
    declare -a SNAP_ISSUES=()
    echo ""
done

# ── Cross-snapshot consistency ────────────────────────────────────────────────
# If multiple snapshots exist, check that shared config vars are consistent
# across all of them where they should be network-independent.
NETWORK_INDEPENDENT_VARS=(
    RATE_LIMIT_WINDOW_MS
    RATE_LIMIT_MAX
    HMAC_SIGNING_SECRET
    BRIDGE_HMAC_SECRET
)

if [ ${#SNAPSHOT_FILES[@]} -gt 1 ]; then
    echo -e "${BOLD}━━━ Cross-snapshot consistency ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
    CROSS_DRIFT=0

    for var in "${NETWORK_INDEPENDENT_VARS[@]}"; do
        declare -A seen_vals=()
        for snap in "${SNAPSHOT_FILES[@]}"; do
            val=$(get_value "$snap" "$var" 2>/dev/null || true)
            snap_name=$(basename "$snap" .env)
            if [ -n "$val" ]; then
                seen_vals["$snap_name"]="$val"
            fi
        done

        # Check if all values are the same
        unique_vals=$(printf '%s\n' "${seen_vals[@]+"${seen_vals[@]}"}" | sort -u | wc -l)
        if [ "${unique_vals}" -gt 1 ]; then
            echo -e "  ${YELLOW}⚠ INCONSISTENT:${RESET} $var differs across snapshots:"
            for snap_name in "${!seen_vals[@]}"; do
                echo -e "      $snap_name: \"${seen_vals[$snap_name]}\""
            done
            CROSS_DRIFT=$((CROSS_DRIFT + 1))
        fi
        unset seen_vals
        declare -A seen_vals=()
    done

    if [ $CROSS_DRIFT -eq 0 ]; then
        echo -e "  ${GREEN}✓ Shared config vars are consistent across all snapshots${RESET}"
    fi
    TOTAL_DRIFT=$((TOTAL_DRIFT + CROSS_DRIFT))
    echo ""
fi

# ── Grand summary ─────────────────────────────────────────────────────────────
echo -e "${BOLD}━━━ Grand Summary ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
echo -e "  Snapshots compared: ${#SNAPSHOT_FILES[@]}"
if [ $TOTAL_DRIFT -eq 0 ]; then
    echo -e "  ${GREEN}${BOLD}✓ All environments are in parity.${RESET}"
else
    echo -e "  ${RED}✗ Total drift issues found: $TOTAL_DRIFT${RESET}"
    echo ""
    echo -e "  Run ${CYAN}./scripts/check_env_parity.sh --env1 environments/<name>.env${RESET} for"
    echo -e "  a detailed per-file report, or see ${CYAN}$REPORT_DIR/${RESET} if --report-dir was set."
fi
echo ""

if [ "$FAIL_ON_DRIFT" -eq 1 ] && [ $TOTAL_DRIFT -gt 0 ]; then
    echo -e "${RED}Exiting with status 1 (--fail-on-drift is set and drift was found).${RESET}" >&2
    exit 1
fi

exit 0
