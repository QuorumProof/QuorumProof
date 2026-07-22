#!/bin/bash
# Parameterized benchmark scaling report.
#
# Runs the *_scaling benchmarks (benches/tests/benchmarks.rs) across a range
# of n per operation, fits an empirical complexity class (linear / superlinear
# / quadratic-or-worse) per operation via benches/src/bin/scaling_report.rs,
# updates benches/history/*.jsonl so drift is visible across commits (not
# just single-run jumps), and writes benches/target/bench-scaling-report.md.
#
# This is additive to — not a replacement for — the existing fixed-threshold
# gate (scripts/benchmark_compare.sh, scripts/profile_contracts.sh, and the
# assert!s in benches/tests/benchmarks.rs itself).
set -euo pipefail

MANIFEST="benches/Cargo.toml"
RAW_DIR="benches/target/bench-scaling"
REPORT="benches/target/bench-scaling-report.md"

echo "Clearing stale scaling data points..."
rm -rf "$RAW_DIR"

echo "Running scaling benchmarks..."
cargo test --manifest-path "$MANIFEST" --target x86_64-unknown-linux-gnu --test benchmarks -- --nocapture

echo ""
echo "Fitting complexity curves and updating history..."
if cargo run --manifest-path "$MANIFEST" --target x86_64-unknown-linux-gnu --bin scaling_report; then
    STATUS=0
else
    STATUS=$?
fi

echo ""
if [ "$STATUS" -eq 0 ]; then
    echo "✅ Scaling report generated: $REPORT"
else
    echo "❌ Scaling report gate failed (exit $STATUS) — see $REPORT"
fi

exit "$STATUS"
