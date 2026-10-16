#!/usr/bin/env bash
# Issue #1633: create a new Architecture Decision Record from the template.
#
#   scripts/adr/new-adr.sh "Short decision title"
#
# Creates docs/adr/adr-NNN-short-decision-title.md with the next free number,
# fills in the title, appends a row to the index in docs/adr/README.md and
# bumps the "next available ADR number" note.
set -euo pipefail

ADR_DIR="$(cd "$(dirname "$0")/../../docs/adr" && pwd)"
TEMPLATE="$ADR_DIR/0000-adr-template.md"
INDEX="$ADR_DIR/README.md"

if [[ $# -lt 1 || -z "$1" ]]; then
  echo "usage: $0 \"Short decision title\"" >&2
  exit 2
fi
TITLE="$1"

last=$(ls "$ADR_DIR" | sed -nE 's/^adr-([0-9]{3})-.*/\1/p' | sort -n | tail -1)
next=$(printf '%03d' $((10#${last:-0} + 1)))
after=$(printf '%03d' $((10#$next + 1)))
slug=$(echo "$TITLE" | tr '[:upper:]' '[:lower:]' | sed -E 's/[^a-z0-9]+/-/g; s/^-+|-+$//g')
file="$ADR_DIR/adr-$next-$slug.md"
today=$(date +%Y-%m-%d)

if [[ -e "$file" ]]; then
  echo "error: $file already exists" >&2
  exit 1
fi

sed -e "1s/^# ADR-NNNN: .*/# ADR-$next: $TITLE/" "$TEMPLATE" > "$file"

row="| [$next](./adr-$next-$slug.md) | $TITLE | Proposed | $today |"
# insert the row just above the end-of-index marker
awk -v row="$row" '/<!-- adr-index-end -->/ { print row } { print }' "$INDEX" > "$INDEX.tmp"
mv "$INDEX.tmp" "$INDEX"
sed -i.bak -E "s/next available ADR number is \*\*[0-9]+\*\*/next available ADR number is **$after**/" "$INDEX" && rm -f "$INDEX.bak"

echo "Created $file"
echo "Next: fill in every section, link it from the code it governs, and open a PR."
