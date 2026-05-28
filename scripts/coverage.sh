#!/bin/bash

# Code Coverage Reporting Script
# Generates coverage reports for the QuorumProof frontend

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$SCRIPT_DIR"
FRONTEND_DIR="$PROJECT_ROOT/frontend"
COVERAGE_DIR="$FRONTEND_DIR/coverage"

echo "🔍 Generating code coverage report..."

cd "$FRONTEND_DIR"

# Run tests with coverage
npm run test:coverage

# Check if coverage directory exists
if [ -d "$COVERAGE_DIR" ]; then
    echo "✅ Coverage report generated successfully"
    echo ""
    echo "📊 Coverage Summary:"
    echo "===================="
    
    # Display coverage summary from lcov report
    if [ -f "$COVERAGE_DIR/lcov-report/index.html" ]; then
        echo "📄 HTML Report: $COVERAGE_DIR/lcov-report/index.html"
    fi
    
    if [ -f "$COVERAGE_DIR/coverage-final.json" ]; then
        echo "📋 JSON Report: $COVERAGE_DIR/coverage-final.json"
    fi
    
    echo ""
    echo "To view the HTML report, open:"
    echo "  $COVERAGE_DIR/lcov-report/index.html"
else
    echo "❌ Coverage directory not found"
    exit 1
fi

# Optional: Check coverage thresholds
echo ""
echo "📈 Checking coverage thresholds..."

# Parse coverage from JSON report if available
if [ -f "$COVERAGE_DIR/coverage-final.json" ]; then
    # Extract coverage percentages (requires jq)
    if command -v jq &> /dev/null; then
        TOTAL_COVERAGE=$(jq '.total.lines.pct' "$COVERAGE_DIR/coverage-final.json")
        echo "Total Line Coverage: ${TOTAL_COVERAGE}%"
        
        # Check against threshold (70%)
        THRESHOLD=70
        if (( $(echo "$TOTAL_COVERAGE < $THRESHOLD" | bc -l) )); then
            echo "⚠️  Coverage is below threshold of ${THRESHOLD}%"
        else
            echo "✅ Coverage meets threshold of ${THRESHOLD}%"
        fi
    fi
fi

echo ""
echo "✨ Coverage reporting complete!"
