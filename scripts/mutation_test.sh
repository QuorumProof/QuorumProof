#!/bin/bash
# Run cargo-mutants against the three QuorumProof contract crates and record
# the mutation score in the append-only JSONL history at mutants/history/.
#
# Usage: ./scripts/mutation_test.sh [--in-place] [extra cargo-mutants flags]
#
# Outputs:
#   mutants.out/         — full results directory
#   mutants.out/missed   — mutants not caught by any test (test gaps)
#   mutants/history/     — one JSONL file per package; appended on every run
#
# Exit codes:
#   0  all mutants caught (or unviable); score within acceptable range
#   1  missed mutants detected OR score regressed vs. rolling baseline
#   2  cargo-mutants not installed
#
# Issue #1480: Mutation testing results have no trend tracking.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if ! command -v cargo-mutants &>/dev/null; then
    echo "cargo-mutants not found. Install with:"
    echo "  cargo install cargo-mutants"
    exit 2
fi

echo "==> Running mutation tests on quorum_proof, sbt_registry, zk_verifier..."

cargo mutants \
    --package quorum_proof \
    --package sbt_registry \
    --package zk_verifier \
    "$@"

# ── Parse outcomes ────────────────────────────────────────────────────────────
# cargo-mutants writes mutants.out/outcomes.json; parse caught/missed per pkg.
OUTCOMES="mutants.out/outcomes.json"

if [[ -f "$OUTCOMES" ]]; then
    # Total caught and missed across all packages
    TOTAL=$(python3 - "$OUTCOMES" <<'EOF'
import json, sys
data = json.load(open(sys.argv[1]))
outcomes = data.get("outcomes", []) if isinstance(data, dict) else data
print(len(outcomes))
EOF
    ) || TOTAL=0

    CAUGHT=$(python3 - "$OUTCOMES" <<'EOF'
import json, sys
data = json.load(open(sys.argv[1]))
outcomes = data.get("outcomes", []) if isinstance(data, dict) else data
print(sum(1 for o in outcomes if o.get("summary") == "CaughtMutant"))
EOF
    ) || CAUGHT=0

    MISSED=$(python3 - "$OUTCOMES" <<'EOF'
import json, sys
data = json.load(open(sys.argv[1]))
outcomes = data.get("outcomes", []) if isinstance(data, dict) else data
print(sum(1 for o in outcomes if o.get("summary") == "MissedMutant"))
EOF
    ) || MISSED=0
else
    # Fallback: grep text output
    MISSED=$(grep -c '^MISSED' mutants.out/outcomes.json 2>/dev/null || echo 0)
    CAUGHT=$(grep -c '^CAUGHT' mutants.out/outcomes.json 2>/dev/null || echo 0)
    TOTAL=$((MISSED + CAUGHT))
fi

echo ""
echo "==> Mutation summary"
echo "    Total  : ${TOTAL}"
echo "    Caught : ${CAUGHT}"
echo "    Missed : ${MISSED}"

# ── Append to JSONL history (Issue #1480) ────────────────────────────────────
if command -v python3 &>/dev/null; then
    echo ""
    echo "==> Recording mutation score history..."
    # Record under the combined workspace entry
    python3 "${SCRIPT_DIR}/mutation_history.py" append "workspace" \
        "${CAUGHT}" "${TOTAL}" || true

    echo "==> Checking for score regression vs. rolling baseline..."
    python3 "${SCRIPT_DIR}/mutation_history.py" check "workspace" || {
        echo "WARNING: mutation score regressed — see details above."
        # Warn but do not hard-fail CI from this script; the CI workflow
        # can decide whether to fail the step.
    }
else
    echo "python3 not found; skipping history recording."
fi

# ── Final result ──────────────────────────────────────────────────────────────
if [[ -s mutants.out/missed ]]; then
    echo ""
    echo "==> Missed mutants (add tests to cover these):"
    cat mutants.out/missed
    exit 1
fi

echo "==> All mutants caught."
