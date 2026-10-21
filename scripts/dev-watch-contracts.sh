#!/usr/bin/env bash
# Issue #1676 — rebuild Soroban contract WASM on source change during development.
#
# Watches contracts/**/*.rs and contracts/**/Cargo.toml and re-runs the
# wasm32 build whenever they change, so contract edits are compiled without
# restarting the loop by hand.
#
# Usage:
#   ./scripts/dev-watch-contracts.sh                 # watch + build quorum_proof (debug)
#   CONTRACT_PACKAGES="quorum_proof sbt_registry" ./scripts/dev-watch-contracts.sh
#   WATCH_PROFILE=release ./scripts/dev-watch-contracts.sh   # match deployed artifacts
#   WATCH_INTERVAL=2 ./scripts/dev-watch-contracts.sh        # poll every 2 seconds
#
# Behaviour:
#   - If `cargo-watch` is installed, it is used (filesystem events, no polling).
#   - Otherwise the script polls a checksum of the watched files every
#     WATCH_INTERVAL seconds (default 2). Polling works in containers and
#     network filesystems where inotify events are unreliable.
#   - Builds are debug by default for faster iteration. Use WATCH_PROFILE=release
#     before deploying, because release builds apply wasm-opt and are the
#     artifacts CI and deploy scripts use.
#
# This script does not deploy anything. It only compiles.

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PACKAGES="${CONTRACT_PACKAGES:-quorum_proof}"
PROFILE="${WATCH_PROFILE:-dev}"
INTERVAL="${WATCH_INTERVAL:-2}"
TARGET="wasm32-unknown-unknown"

PROFILE_FLAG=()
if [[ "$PROFILE" == "release" ]]; then
  PROFILE_FLAG=(--release)
fi

build() {
  local pkg args=()
  for pkg in $PACKAGES; do
    args+=(-p "$pkg")
  done
  echo "==> [$(date +%H:%M:%S)] building ${PACKAGES} (${PROFILE}, ${TARGET})"
  if (cd "$ROOT_DIR" && cargo build --target "$TARGET" "${PROFILE_FLAG[@]}" "${args[@]}"); then
    echo "==> build ok"
  else
    # Keep watching after a failed build so the next save can fix it.
    echo "==> build failed; still watching for changes"
  fi
}

if command -v cargo-watch >/dev/null 2>&1; then
  echo "Using cargo-watch for ${PACKAGES} (${PROFILE})"
  WATCH_ARGS=(-w contracts -x "build --target $TARGET ${PROFILE_FLAG[*]:-} $(for p in $PACKAGES; do printf -- '-p %s ' "$p"; done)")
  exec cargo watch "${WATCH_ARGS[@]}"
fi

fingerprint() {
  # Hash the content of every Rust source and manifest under contracts/,
  # skipping build output so builds do not retrigger themselves.
  (cd "$ROOT_DIR" && find contracts \( -name target -o -name node_modules \) -prune -o \
      \( -name '*.rs' -o -name 'Cargo.toml' \) -type f -print | sort | xargs sha256sum) \
    | sha256sum | cut -d' ' -f1
}

echo "Polling contracts/ every ${INTERVAL}s for ${PACKAGES} (${PROFILE}). Ctrl+C to stop."
last=""
while true; do
  current="$(fingerprint)"
  if [[ "$current" != "$last" ]]; then
    last="$current"
    build
  fi
  sleep "$INTERVAL"
done
