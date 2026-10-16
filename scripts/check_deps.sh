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


# ── RUSTSEC advisory age check (issue #1490) ─────────────────────────────────
#
# Warn if any advisory in deny.toml's `allow = [...]` list has been present for
# more than 90 days.  The "added" date is extracted from the comment immediately
# above each allow entry in deny.toml (format: "Added: YYYY-MM-DD").
#
# This is a warning-only check — it does not fail the build — because we cannot
# automatically remove the exception without first confirming a fixed version is
# available.  It surfaces the need for a human review so exceptions don't linger
# indefinitely.

DENY_TOML="$ROOT_DIR/deny.toml"
ADVISORY_AGE_LIMIT=90
echo ""
echo "==> Checking RUSTSEC advisory allow-list age (limit: ${ADVISORY_AGE_LIMIT} days)"

# TODAY in seconds since epoch (cross-platform: macOS uses -j -f, GNU uses -d)
if date --version 2>&1 | grep -q 'GNU'; then
  TODAY_EPOCH=$(date -u +%s)
  date_to_epoch() { date -u -d "$1" +%s 2>/dev/null || echo 0; }
else
  TODAY_EPOCH=$(date -u +%s)
  date_to_epoch() { date -u -j -f "%Y-%m-%d" "$1" +%s 2>/dev/null || echo 0; }
fi

WARNED_AGE=0
# Extract each advisory ID and the "Added:" date from the preceding comment block
while IFS= read -r line; do
  # Match an advisory allow entry, e.g.     "RUSTSEC-2026-0258",
  if [[ "$line" =~ \"(RUSTSEC-[0-9]+-[0-9]+)\" ]]; then
    ADVISORY="${BASH_REMATCH[1]}"
    # ADDED_DATE captured from the comment immediately above
    if [[ -n "$ADDED_DATE" ]]; then
      ADDED_EPOCH=$(date_to_epoch "$ADDED_DATE")
      if [[ "$ADDED_EPOCH" -gt 0 ]]; then
        AGE_DAYS=$(( (TODAY_EPOCH - ADDED_EPOCH) / 86400 ))
        if [[ $AGE_DAYS -gt $ADVISORY_AGE_LIMIT ]]; then
          echo "  [WARN] $ADVISORY has been allowed for ${AGE_DAYS} days (limit: ${ADVISORY_AGE_LIMIT})."
          echo "         Review whether a patched version is now available and remove the exception if so."
          WARNED_AGE=$((WARNED_AGE + 1))
        else
          echo "  [OK]   $ADVISORY allowed for ${AGE_DAYS}/${ADVISORY_AGE_LIMIT} days (added: $ADDED_DATE)"
        fi
      else
        echo "  [WARN] $ADVISORY — could not parse 'Added:' date ('$ADDED_DATE'). Add 'Added: YYYY-MM-DD' comment."
        WARNED_AGE=$((WARNED_AGE + 1))
      fi
    else
      echo "  [WARN] $ADVISORY — no 'Added: YYYY-MM-DD' comment found above allow entry."
      WARNED_AGE=$((WARNED_AGE + 1))
    fi
    ADDED_DATE=""
  fi
  # Look for an "Added: YYYY-MM-DD" comment line
  if [[ "$line" =~ Added:[[:space:]]*([0-9]{4}-[0-9]{2}-[0-9]{2}) ]]; then
    ADDED_DATE="${BASH_REMATCH[1]}"
  fi
done < "$DENY_TOML"

if [[ $WARNED_AGE -gt 0 ]]; then
  echo ""
  echo "  NOTE: $WARNED_AGE advisory exception(s) need attention (stale or missing date)."
fi

echo ""
echo "==> Results: $PASS passed, $FAIL failed, $WARNED_AGE advisory age warning(s)"
[[ $FAIL -eq 0 ]] && exit 0 || exit 1
