#!/usr/bin/env bash
# regression: #2000 — coverage.sh resolves the frontend from the project root.
# Smoke-test coverage.sh against an isolated fixture project.
#
# Run with: ./scripts/tests/regression_2000_coverage.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(dirname "$(dirname "$SCRIPT_DIR")")"
COVERAGE_SCRIPT="$ROOT_DIR/scripts/coverage.sh"

WORK_DIR="$(mktemp -d)"
cleanup() { rm -rf "$WORK_DIR"; }
trap cleanup EXIT

FIXTURE_ROOT="$WORK_DIR/project"
mkdir -p "$FIXTURE_ROOT/scripts" "$FIXTURE_ROOT/frontend" "$WORK_DIR/bin"
cp "$COVERAGE_SCRIPT" "$FIXTURE_ROOT/scripts/coverage.sh"
cat > "$FIXTURE_ROOT/frontend/package.json" <<'JSON'
{
  "scripts": {
    "test:coverage": "generate-coverage"
  }
}
JSON

cat > "$WORK_DIR/bin/npm" <<'STUB'
#!/usr/bin/env bash
if [[ "$PWD" != "$EXPECTED_FRONTEND_DIR" ]]; then
  echo "npm ran outside the fixture frontend: $PWD" >&2
  exit 1
fi
if [[ "$#" -ne 2 || "$1" != "run" || "$2" != "test:coverage" ]]; then
  echo "unexpected npm arguments: $*" >&2
  exit 1
fi
if [[ ! -f package.json ]]; then
  echo "fixture package.json was not found" >&2
  exit 1
fi
mkdir -p coverage/lcov-report
: > coverage/lcov-report/index.html
STUB
chmod +x "$WORK_DIR/bin/npm"

EXPECTED_FRONTEND_DIR="$FIXTURE_ROOT/frontend" \
  PATH="$WORK_DIR/bin:$PATH" \
  "$FIXTURE_ROOT/scripts/coverage.sh" > "$WORK_DIR/output.log" 2>&1

assert_contains() {
  if ! grep -Fq -- "$1" "$WORK_DIR/output.log"; then
    echo "expected script output to contain: $1" >&2
    cat "$WORK_DIR/output.log" >&2
    exit 1
  fi
}

assert_contains "Coverage report generated successfully"
assert_contains "$FIXTURE_ROOT/frontend/coverage/lcov-report/index.html"
assert_contains "Coverage reporting complete"
echo "coverage.sh smoke test passed"
