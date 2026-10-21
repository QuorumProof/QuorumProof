#!/usr/bin/env bash
# Issue #1829: verify every Prometheus alert rule in monitoring/prometheus/alerts.yml
# has a runbook_url annotation.
#
# Exits non-zero and lists the offending alert names if any alert is missing
# a runbook_url, so the CI gate fails fast with actionable output.
set -euo pipefail

ALERTS_FILE="monitoring/prometheus/alerts.yml"

cd "$(dirname "$0")/.."

if [ ! -f "$ALERTS_FILE" ]; then
    echo "ERROR: $ALERTS_FILE not found." >&2
    exit 1
fi

# Walk the YAML with awk:
#   - When we see "- alert: <Name>", record the name and reset the seen flag.
#   - When we see "runbook_url:" inside the same alert block, set the seen flag.
#   - When we hit the next "- alert:" or end of file, check the flag and report.
missing=()
current_alert=""
has_runbook=0

while IFS= read -r line; do
    if [[ "$line" =~ ^[[:space:]]*-[[:space:]]alert:[[:space:]]*(.+)$ ]]; then
        # Flush previous alert
        if [ -n "$current_alert" ] && [ "$has_runbook" -eq 0 ]; then
            missing+=("$current_alert")
        fi
        current_alert="${BASH_REMATCH[1]}"
        has_runbook=0
    elif [[ "$line" =~ runbook_url: ]] && [ -n "$current_alert" ]; then
        has_runbook=1
    fi
done < "$ALERTS_FILE"

# Flush the last alert
if [ -n "$current_alert" ] && [ "$has_runbook" -eq 0 ]; then
    missing+=("$current_alert")
fi

if [ "${#missing[@]}" -gt 0 ]; then
    echo "ERROR: the following alert(s) are missing a runbook_url annotation:" >&2
    for name in "${missing[@]}"; do
        echo "  - $name" >&2
    done
    echo "" >&2
    echo "Add a runbook_url annotation to each alert in $ALERTS_FILE and create" >&2
    echo "the corresponding section in docs/operational-runbook.md." >&2
    exit 1
fi

total=$(grep -c '- alert:' "$ALERTS_FILE" || true)
echo "OK: all ${total} alert(s) in $ALERTS_FILE have a runbook_url annotation."
