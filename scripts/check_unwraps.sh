#!/usr/bin/env bash
# Issue #1391: guard against new bare `.unwrap()` calls in contract code.
#
# A bare `.unwrap()` aborts the transaction with an opaque host trap instead
# of one of the contract's `ContractError` variants, which off-chain clients
# and indexers cannot interpret. New non-test contract code should use
# `.unwrap_or_else(|| panic_with_error!(&env, ContractError::...))` instead.
#
# This is a ratchet, not a clean-sweep gate: the remaining occurrences were
# audited (see docs/unwrap-audit.md) and are provably safe, but the count must
# not grow. Lower BASELINE whenever occurrences are removed.
set -euo pipefail

BASELINE=${UNWRAP_BASELINE:-110}

cd "$(dirname "$0")/.."

total=0
for file in $(find contracts -path '*/src/*.rs' -not -name '*test*.rs' -not -name '*.bak' | sort); do
    # Only production code: everything before the file's inline test module.
    count=$(awk '/^#\[cfg\(test\)\]$/ { pending = 1; next }
                 pending && /^(pub )?mod tests[ ]*\{/ { exit }
                 { pending = 0; print }' "$file" | grep -c '\.unwrap()' || true)
    if [ "$count" -gt 0 ]; then
        printf '%6d  %s\n' "$count" "$file"
    fi
    total=$((total + count))
done

echo "total bare .unwrap() in non-test contract code: $total (baseline $BASELINE)"

if [ "$total" -gt "$BASELINE" ]; then
    echo "ERROR: new bare .unwrap() calls were added." >&2
    echo "Use .unwrap_or_else(|| panic_with_error!(&env, ContractError::...)) so the" >&2
    echo "failure surfaces as a typed contract error." >&2
    exit 1
fi

if [ "$total" -lt "$BASELINE" ]; then
    echo "NOTE: count dropped below the baseline — lower BASELINE in $0 to lock it in."
fi
