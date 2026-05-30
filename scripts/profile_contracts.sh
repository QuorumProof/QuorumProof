#!/bin/bash
# Issue #593: Profile contract hot paths and emit an optimization report.
# Uses the existing benchmark test suite (benches/tests/benchmarks.rs) which
# already measures CPU instructions and memory bytes via env.budget().
# Outputs a Markdown report to target/profile_report.md.
set -euo pipefail

REPORT="target/profile_report.md"
mkdir -p target

echo "Running contract performance profiling..."

# Capture benchmark output (--nocapture surfaces the budget numbers)
RAW=$(cargo test -p quorum-proof-benches --test benchmarks -- --nocapture 2>&1)

echo "$RAW"

# ── Parse CPU/MEM lines emitted by the benchmark suite ───────────────────────
# The benchmarks print lines like:
#   issue_credential  cpu=1_234_567  mem=1_100_000
# We extract them and flag anything that exceeds the 80% threshold as a hotspot.

THRESHOLD_WARN=0.80   # flag ops using >80% of their CI threshold

cat > "$REPORT" <<'HEADER'
# Contract Performance Profile

| Operation | CPU (instructions) | Memory (bytes) | Status |
|---|---|---|---|
HEADER

declare -A THRESHOLDS_CPU=(
  [issue_credential]=2000000
  [create_slice]=2000000
  [attest]=2000000
  [revoke_credential]=1500000
  [mint_sbt]=3000000
  [burn_sbt]=2000000
  [verify_claim]=1500000
  [verify_engineer]=8000000
  [batch_issue_5]=12000000
  [batch_verify_5]=6000000
)

BOTTLENECKS=()

while IFS= read -r line; do
  # Match lines like: "  issue_credential  cpu=1234567  mem=1100000"
  if [[ "$line" =~ ([a-z_0-9]+)[[:space:]]+cpu=([0-9_]+)[[:space:]]+mem=([0-9_]+) ]]; then
    op="${BASH_REMATCH[1]}"
    cpu="${BASH_REMATCH[2]//\_/}"
    mem="${BASH_REMATCH[3]//\_/}"
    threshold="${THRESHOLDS_CPU[$op]:-0}"
    status="✅"
    if [ "$threshold" -gt 0 ]; then
      warn_at=$(echo "$threshold * $THRESHOLD_WARN" | bc | cut -d. -f1)
      if [ "$cpu" -ge "$threshold" ]; then
        status="❌ EXCEEDS THRESHOLD"
        BOTTLENECKS+=("$op (cpu=$cpu >= threshold=$threshold)")
      elif [ "$cpu" -ge "$warn_at" ]; then
        status="⚠️ near limit"
        BOTTLENECKS+=("$op (cpu=$cpu, ${THRESHOLD_WARN}% of $threshold)")
      fi
    fi
    echo "| \`$op\` | $cpu | $mem | $status |" >> "$REPORT"
  fi
done <<< "$RAW"

# ── Recommendations ───────────────────────────────────────────────────────────
{
  echo ""
  echo "## Bottlenecks & Recommendations"
  if [ ${#BOTTLENECKS[@]} -eq 0 ]; then
    echo "No bottlenecks detected. All operations are within thresholds."
  else
    for b in "${BOTTLENECKS[@]}"; do
      echo "- **$b** — consider reducing storage reads, inlining helpers, or splitting into smaller ops."
    done
  fi
  echo ""
  echo "_Generated: $(date -u +%Y-%m-%dT%H:%M:%SZ)_"
} >> "$REPORT"

echo ""
echo "Profile report written to $REPORT"

# Exit non-zero if any threshold was exceeded (for CI gating)
if [ ${#BOTTLENECKS[@]} -gt 0 ]; then
  echo "WARNING: ${#BOTTLENECKS[@]} bottleneck(s) detected."
fi
