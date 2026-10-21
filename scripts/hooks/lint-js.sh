#!/usr/bin/env bash
# scripts/hooks/lint-js.sh — #1672 ESLint wrapper used by .pre-commit-config.yaml.
#
# pre-commit passes staged file paths relative to the repository root, but ESLint must run
# from the workspace directory so it picks up that workspace's config. This script strips the
# workspace prefix and runs ESLint from inside it.
#
# Usage: scripts/hooks/lint-js.sh <workspace-dir> <file>...

set -euo pipefail

if [[ $# -lt 2 ]]; then
  echo "usage: $0 <workspace-dir> <file>..." >&2
  exit 2
fi

workspace="$1"
shift

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR/$workspace"

files=()
for f in "$@"; do
  files+=("${f#"$workspace"/}")
done

exec npx --no-install eslint "${files[@]}"
