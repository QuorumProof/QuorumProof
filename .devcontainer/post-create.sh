#!/usr/bin/env bash
# .devcontainer/post-create.sh — #1671 one-time setup run after a Codespace/devcontainer is created.
#
# Installs the JS dependencies for every Node workspace and the Rust tooling needed to build
# the Soroban contracts. Re-running is safe: every step is idempotent.

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

info() { echo "[post-create] $*"; }

info "Ensuring the wasm32 target is installed for contract builds"
rustup target add wasm32-unknown-unknown

for dir in api-server frontend dashboard; do
  if [[ -f "$dir/package-lock.json" ]]; then
    info "Installing npm dependencies in $dir"
    (cd "$dir" && npm ci --no-audit --no-fund)
  fi
done

info "Installing pre-commit hooks"
python3 -m pip install --user --quiet pre-commit
python3 -m pre_commit install || info "WARN: could not install hooks; run 'pre-commit install' manually"

info "Done. Next steps: see docs/codespaces.md"
