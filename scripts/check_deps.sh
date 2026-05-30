#!/usr/bin/env bash
# scripts/check_deps.sh — #589 Verify contract dependency versions match dependencies.toml.
#
# Reads contracts/dependencies.toml and checks that each declared soroban-sdk
# version matches the version pinned in the corresponding Cargo.toml.
# Exits non-zero if any mismatch or breaking-change version is detected.

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MANIFEST="$ROOT_DIR/contracts/dependencies.toml"
PASS=0
FAIL=0

check() {
  local desc="$1" result="$2"
  if [[ "$result" == "ok" ]]; then
    echo "  [PASS] $desc"
    PASS=$((PASS + 1))
  else
    echo "  [FAIL] $desc — $result"
    FAIL=$((FAIL + 1))
  fi
}

echo "==> Checking contract dependencies against $MANIFEST"

# Extract declared soroban-sdk version from dependencies.toml (first occurrence)
DECLARED_SDK=$(grep -A2 'name.*=.*"soroban-sdk"' "$MANIFEST" | grep 'version' | head -1 | sed 's/.*= *"\(.*\)".*/\1/')

# Check workspace soroban-sdk version in root Cargo.toml
WORKSPACE_SDK=$(grep 'soroban-sdk' "$ROOT_DIR/Cargo.toml" | grep 'version' | sed 's/.*version = "\([^"]*\)".*/\1/')

if [[ "$DECLARED_SDK" == "$WORKSPACE_SDK" ]]; then
  check "soroban-sdk workspace version ($WORKSPACE_SDK) matches manifest ($DECLARED_SDK)" "ok"
else
  check "soroban-sdk workspace version" "Cargo.toml has $WORKSPACE_SDK, manifest declares $DECLARED_SDK"
fi

# Check each contract's Cargo.toml for soroban-sdk overrides
for contract_dir in "$ROOT_DIR"/contracts/*/; do
  cargo_toml="$contract_dir/Cargo.toml"
  [[ -f "$cargo_toml" ]] || continue
  contract_name=$(basename "$contract_dir")

  # If the contract pins its own soroban-sdk version (not inheriting workspace), flag it
  if grep -q 'soroban-sdk.*version' "$cargo_toml" 2>/dev/null; then
    LOCAL_SDK=$(grep 'soroban-sdk' "$cargo_toml" | grep 'version' | sed 's/.*version = "\([^"]*\)".*/\1/')
    if [[ "$LOCAL_SDK" != "$DECLARED_SDK" ]]; then
      check "$contract_name soroban-sdk version" "local pin $LOCAL_SDK differs from manifest $DECLARED_SDK"
    else
      check "$contract_name soroban-sdk version ($LOCAL_SDK)" "ok"
    fi
  fi
done

# Check for breaking-change versions: warn if installed SDK >= breaking_at threshold
BREAKING_AT=$(grep '^\s*breaking_at' "$MANIFEST" | head -1 | sed 's/.*= *"\(.*\)".*/\1/' | tr -d '>=')
MAJOR_INSTALLED=$(echo "$WORKSPACE_SDK" | cut -d. -f1)
MAJOR_BREAKING=$(echo "$BREAKING_AT" | cut -d. -f1)

if [[ "$MAJOR_INSTALLED" -ge "$MAJOR_BREAKING" ]]; then
  check "soroban-sdk below breaking version ($BREAKING_AT)" \
    "installed $WORKSPACE_SDK meets or exceeds breaking threshold — re-audit required"
else
  check "soroban-sdk below breaking version ($BREAKING_AT)" "ok"
fi

echo ""
echo "==> Results: $PASS passed, $FAIL failed"
[[ $FAIL -eq 0 ]] && exit 0 || exit 1
