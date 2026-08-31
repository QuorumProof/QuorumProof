#!/usr/bin/env bash
# scripts/check_docs_index.sh — #1498 Verify every docs/*.md is linked from docs/README.md.
#
# docs/ holds 70+ standalone Markdown files. docs/README.md is the index new
# contributors use to discover what already exists. This check fails if a doc
# has been added without a corresponding link in that index, so the index
# cannot silently rot.
#
# Exempt:
#   - docs/README.md itself (it is the index)
#   - docs/adr/**          (indexed separately by docs/adr/README.md)

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
INDEX="$ROOT_DIR/docs/README.md"
MISSING=0

if [[ ! -f "$INDEX" ]]; then
  echo "  [FAIL] docs/README.md not found — the documentation index is missing"
  exit 1
fi

echo "==> Checking docs/*.md are linked from docs/README.md"

for doc in "$ROOT_DIR"/docs/*.md; do
  name="$(basename "$doc")"
  [[ "$name" == "README.md" ]] && continue

  # Match a Markdown link target: (name), (./name) or (name#anchor).
  if grep -qE "\(\.?/?${name//./\\.}(#[^)]*)?\)" "$INDEX"; then
    echo "  [PASS] $name"
  else
    echo "  [FAIL] $name is not linked from docs/README.md"
    MISSING=$((MISSING + 1))
  fi
done

echo ""
if [[ $MISSING -eq 0 ]]; then
  echo "==> All docs are indexed."
  exit 0
fi

echo "==> $MISSING doc(s) missing from the index."
echo "    Add a link (with a one-line description) to docs/README.md under the"
echo "    appropriate section. See the 'Adding a new doc' section of that file."
exit 1
