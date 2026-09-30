#!/usr/bin/env bash
# scripts/check_code_examples.sh — #1638 Run the multi-language code examples against a mock API.
#
# Starts examples/multi-language/mock_server.py, runs each language's
# quickstart against it, and diffs stdout with expected_output.txt.
#
# Usage:
#   ./scripts/check_code_examples.sh                 # every language
#   ./scripts/check_code_examples.sh python rust     # a subset
#
# Env:
#   CODE_EXAMPLES_STRICT=1   fail (instead of skip) when a toolchain is missing
#   MOCK_PORT=8787           port for the mock server

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
EX_DIR="$ROOT_DIR/examples/multi-language"
EXPECTED="$EX_DIR/expected_output.txt"
PORT="${MOCK_PORT:-8787}"
STRICT="${CODE_EXAMPLES_STRICT:-0}"
LANGS=("$@")
[[ ${#LANGS[@]} -eq 0 ]] && LANGS=(python javascript go rust)

python3 "$EX_DIR/mock_server.py" "$PORT" &
MOCK_PID=$!
trap 'kill "$MOCK_PID" 2>/dev/null || true' EXIT

# Wait for the mock server to accept connections.
for _ in $(seq 1 50); do
  if python3 - "$PORT" <<'PY' 2>/dev/null; then break; fi
import socket, sys
socket.create_connection(("127.0.0.1", int(sys.argv[1])), timeout=0.2).close()
PY
  sleep 0.1
done

export QP_API_URL="http://127.0.0.1:$PORT"
FAILED=0

run_example() {
  local lang="$1" tool="$2"; shift 2
  if ! command -v "$tool" >/dev/null 2>&1; then
    if [[ "$STRICT" == "1" ]]; then
      echo "  [FAIL] $lang — '$tool' not installed"
      FAILED=$((FAILED + 1))
    else
      echo "  [SKIP] $lang — '$tool' not installed"
    fi
    return
  fi
  local out
  if ! out="$("$@" 2>&1)"; then
    echo "  [FAIL] $lang — example exited non-zero"
    echo "$out" | sed 's/^/         /'
    FAILED=$((FAILED + 1))
    return
  fi
  if diff -u "$EXPECTED" <(printf '%s\n' "$out") >/tmp/code-example-diff.$$ ; then
    echo "  [PASS] $lang"
  else
    echo "  [FAIL] $lang — output differs from expected_output.txt"
    sed 's/^/         /' /tmp/code-example-diff.$$
    FAILED=$((FAILED + 1))
  fi
  rm -f /tmp/code-example-diff.$$
}

echo "==> Running multi-language code examples against mock API on :$PORT"
for lang in "${LANGS[@]}"; do
  case "$lang" in
    python)     run_example python python3 python3 "$EX_DIR/python/quickstart.py" ;;
    javascript) run_example javascript node node "$EX_DIR/javascript/quickstart.mjs" ;;
    go)         run_example go go bash -c "cd '$EX_DIR/go' && go run ." ;;
    rust)       run_example rust cargo bash -c "cd '$EX_DIR/rust' && cargo run --quiet" ;;
    *) echo "  [FAIL] unknown language '$lang'"; FAILED=$((FAILED + 1)) ;;
  esac
done

echo ""
if [[ $FAILED -eq 0 ]]; then
  echo "All code examples passed."
else
  echo "$FAILED code example(s) failed."
  exit 1
fi
