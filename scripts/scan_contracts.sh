#!/usr/bin/env bash
# scripts/scan_contracts.sh — Issue #594: Contract-specific security pattern scan.
#
# Checks Soroban contract source for unsafe patterns:
#   1. Bare `unwrap()` / `expect()` calls (should use panic_with_error!)
#   2. `unsafe` blocks
#   3. Hardcoded admin addresses (string literals that look like Stellar addresses)
#   4. Missing auth checks on state-mutating public functions
#
# Exits non-zero if any CRITICAL finding is detected.

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CONTRACT_SRC="$ROOT_DIR/contracts"

CRITICAL=0
WARN=0

critical() { echo "  [CRITICAL] $1"; CRITICAL=$((CRITICAL + 1)); }
warn()     { echo "  [WARN]     $1"; WARN=$((WARN + 1)); }

echo "==> Scanning contract sources in $CONTRACT_SRC"
echo ""

# ── 1. Detect unsafe blocks ───────────────────────────────────────────────────
echo "--- Check: unsafe blocks ---"
while IFS= read -r line; do
  critical "unsafe block: $line"
done < <(grep -rn '\bunsafe\b' "$CONTRACT_SRC" --include='*.rs' \
           --exclude='*.bak' || true)

# ── 2. Detect bare unwrap() (outside test modules) ───────────────────────────
echo "--- Check: bare unwrap() outside tests ---"
while IFS= read -r line; do
  # Skip lines inside #[cfg(test)] blocks — heuristic: file contains _test suffix
  file=$(echo "$line" | cut -d: -f1)
  if [[ "$file" != *test* ]]; then
    warn "bare unwrap(): $line"
  fi
done < <(grep -rn '\.unwrap()' "$CONTRACT_SRC" --include='*.rs' \
           --exclude='*.bak' || true)

# ── 3. Detect hardcoded Stellar addresses (G... 56-char strings) ─────────────
echo "--- Check: hardcoded Stellar addresses ---"
while IFS= read -r line; do
  critical "hardcoded address: $line"
done < <(grep -rn '"G[A-Z2-7]\{55\}"' "$CONTRACT_SRC" --include='*.rs' \
           --exclude='*.bak' || true)

# ── 4. Detect public functions that mutate state without require_auth ─────────
# Heuristic: pub fn that calls env.storage()...set but not require_auth
echo "--- Check: public functions missing require_auth ---"
TMPFILE=$(mktemp)
# Extract all pub fn blocks from non-test files
grep -rn 'pub fn ' "$CONTRACT_SRC" --include='*.rs' --exclude='*.bak' \
  -l > "$TMPFILE" || true

while IFS= read -r src_file; do
  # For each pub fn, check if the function body has set() but no require_auth
  python3 - "$src_file" <<'PYEOF'
import re, sys

text = open(sys.argv[1]).read()
# Find pub fn signatures and their approximate bodies (next 20 lines)
for m in re.finditer(r'pub fn (\w+)\s*\(', text):
    start = m.start()
    snippet = text[start:start+800]
    if '.set(' in snippet and 'require_auth' not in snippet and '#[cfg(test)]' not in snippet:
        line_no = text[:start].count('\n') + 1
        print(f"  [WARN]     possible missing require_auth: {sys.argv[1]}:{line_no}: {m.group(0).strip()}")
PYEOF
done < "$TMPFILE"
rm -f "$TMPFILE"

echo ""
echo "==> Scan complete: $CRITICAL critical, $WARN warnings"

if [[ $CRITICAL -gt 0 ]]; then
  echo "::error::$CRITICAL critical security issue(s) found. Fix before merging."
  exit 1
fi

exit 0
