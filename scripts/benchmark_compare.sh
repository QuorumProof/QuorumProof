#!/bin/bash
# Issue #576: Performance benchmark comparison script
# Compares current benchmark results against baseline

set -e

BASELINE_FILE="${1:-.benchmark-baseline.json}"
OUTPUT_FILE="benchmark-results.json"

echo "Running performance benchmarks..."
cargo test -p quorum-proof-benches --test benchmarks -- --nocapture > /tmp/bench_output.txt 2>&1

# Extract benchmark metrics from test output
echo "Extracting benchmark metrics..."
cat /tmp/bench_output.txt | grep -E "\[bench_" > /tmp/bench_metrics.txt || true

# Create JSON output
cat > "$OUTPUT_FILE" << 'EOF'
{
  "timestamp": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "benchmarks": [
EOF

# Parse metrics and add to JSON
while IFS= read -r line; do
    if [[ $line =~ \[bench_([a-z_]+)\]\ cpu=([0-9]+)\ mem=([0-9]+) ]]; then
        name="${BASH_REMATCH[1]}"
        cpu="${BASH_REMATCH[2]}"
        mem="${BASH_REMATCH[3]}"
        echo "    {\"name\": \"$name\", \"cpu\": $cpu, \"memory\": $mem}," >> "$OUTPUT_FILE"
    fi
done < /tmp/bench_metrics.txt

# Remove trailing comma and close JSON
sed -i '$ s/,$//' "$OUTPUT_FILE"
echo "  ]" >> "$OUTPUT_FILE"
echo "}" >> "$OUTPUT_FILE"

echo "Benchmark results saved to $OUTPUT_FILE"

# Compare with baseline if it exists
if [ -f "$BASELINE_FILE" ]; then
    echo ""
    echo "Comparing with baseline..."
    
    # Simple comparison: check if any benchmark exceeded 10% regression
    REGRESSION_DETECTED=0
    
    while IFS= read -r line; do
        if [[ $line =~ \[bench_([a-z_]+)\]\ cpu=([0-9]+)\ mem=([0-9]+) ]]; then
            name="${BASH_REMATCH[1]}"
            current_cpu="${BASH_REMATCH[2]}"
            current_mem="${BASH_REMATCH[3]}"
            
            # Extract baseline values (simplified - assumes same order)
            baseline_cpu=$(grep "\"$name\"" "$BASELINE_FILE" | grep "\"cpu\"" | grep -oE '[0-9]+' | head -1)
            baseline_mem=$(grep "\"$name\"" "$BASELINE_FILE" | grep "\"memory\"" | grep -oE '[0-9]+' | head -1)
            
            if [ -n "$baseline_cpu" ] && [ -n "$baseline_mem" ]; then
                # Calculate percentage change
                cpu_change=$(( (current_cpu - baseline_cpu) * 100 / baseline_cpu ))
                mem_change=$(( (current_mem - baseline_mem) * 100 / baseline_mem ))
                
                echo "  $name: CPU ${cpu_change}% (${current_cpu} vs ${baseline_cpu}), MEM ${mem_change}% (${current_mem} vs ${baseline_mem})"
                
                # Flag if regression > 10%
                if [ "$cpu_change" -gt 10 ] || [ "$mem_change" -gt 10 ]; then
                    echo "    ⚠️  REGRESSION DETECTED"
                    REGRESSION_DETECTED=1
                fi
            fi
        fi
    done < /tmp/bench_metrics.txt
    
    if [ $REGRESSION_DETECTED -eq 1 ]; then
        echo ""
        echo "❌ Performance regression detected! Review changes before merging."
        exit 1
    else
        echo ""
        echo "✅ All benchmarks within acceptable thresholds"
    fi
else
    echo "No baseline found. Creating baseline from current results..."
    cp "$OUTPUT_FILE" "$BASELINE_FILE"
    echo "Baseline saved to $BASELINE_FILE"
fi

echo "Done!"
