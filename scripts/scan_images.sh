#!/usr/bin/env bash
# scripts/scan_images.sh — #1651 Container image vulnerability scanning.
#
# Scans a container image (and optionally its Dockerfile) with Trivy and
# writes machine- and human-readable reports. Used by
# .github/workflows/container-scan.yml and runnable locally.
#
# Usage:
#   scripts/scan_images.sh --image <ref> [--dockerfile <path>] [--name <label>]
#                          [--output <dir>] [--fail-on <SEVERITIES>]
#                          [--skip-db-update]
#   scripts/scan_images.sh --all            # build + scan every image in the repo
#
# Outputs (in --output, default scan-reports/<name>/):
#   trivy-image.json     full Trivy JSON report (vulns + secrets)
#   trivy-image.sarif    SARIF for GitHub code scanning
#   trivy-config.json    Dockerfile misconfiguration report (if --dockerfile)
#   counts.json          {"critical":N,"high":N,"medium":N,"low":N,"unknown":N,"fixable_blocking":N}
#   summary.md           Markdown summary table + blocking findings
#
# Policy: exits 1 when there are vulnerabilities at a severity in --fail-on
# (default CRITICAL,HIGH; env SCAN_FAIL_SEVERITY) that have a fixed version
# available, or any secret is found. Unfixed vulns are reported but do not
# block. Accepted risks go in .trivyignore with an expiry.
#
# Exit codes: 0 clean, 1 policy violation, 2 usage / scanner error.

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

IMAGE=""
DOCKERFILE=""
NAME=""
OUTPUT=""
FAIL_ON="${SCAN_FAIL_SEVERITY:-CRITICAL,HIGH}"
SKIP_DB_UPDATE=0
ALL=0

usage() { sed -n '2,30p' "$0" | sed 's/^# \{0,1\}//'; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    --image) IMAGE="$2"; shift 2 ;;
    --dockerfile) DOCKERFILE="$2"; shift 2 ;;
    --name) NAME="$2"; shift 2 ;;
    --output) OUTPUT="$2"; shift 2 ;;
    --fail-on) FAIL_ON="$2"; shift 2 ;;
    --skip-db-update) SKIP_DB_UPDATE=1; shift ;;
    --all) ALL=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "unknown argument: $1" >&2; usage >&2; exit 2 ;;
  esac
done

for bin in trivy jq; do
  if ! command -v "$bin" >/dev/null 2>&1; then
    echo "error: '$bin' is required (https://aquasecurity.github.io/trivy/)" >&2
    exit 2
  fi
done

# ── --all: build and scan every image, aggregate exit code ──────────────────
if [[ $ALL -eq 1 ]]; then
  command -v docker >/dev/null 2>&1 || { echo "error: docker is required for --all" >&2; exit 2; }
  overall=0
  while IFS='|' read -r name context dockerfile; do
    ref="quorumproof/${name}:scan-local"
    echo "==> Building $name"
    docker build -q -t "$ref" -f "$ROOT_DIR/$dockerfile" "$ROOT_DIR/$context" >/dev/null
    set +e
    "$0" --image "$ref" --dockerfile "$ROOT_DIR/$dockerfile" --name "$name" \
      --fail-on "$FAIL_ON" $([[ $SKIP_DB_UPDATE -eq 1 ]] && echo --skip-db-update)
    code=$?
    set -e
    [[ $code -gt $overall ]] && overall=$code
    SKIP_DB_UPDATE=1 # DB only needs refreshing once per run
  done <<'IMAGES'
api-server|api-server|api-server/Dockerfile
exporter|monitoring/exporter|monitoring/exporter/Dockerfile
tts|services/tts|services/tts/Dockerfile
IMAGES
  exit "$overall"
fi

[[ -n "$IMAGE" ]] || { echo "error: --image is required" >&2; usage >&2; exit 2; }
NAME="${NAME:-$(basename "${IMAGE%%[:@]*}")}"
OUTPUT="${OUTPUT:-scan-reports/$NAME}"
mkdir -p "$OUTPUT"

common=(--config "$ROOT_DIR/trivy.yaml" --ignorefile "$ROOT_DIR/.trivyignore" --quiet)
[[ $SKIP_DB_UPDATE -eq 1 ]] && common+=(--skip-db-update --skip-java-db-update)

echo "==> Scanning image $IMAGE"
trivy image "${common[@]}" --scanners vuln,secret --format json \
  --output "$OUTPUT/trivy-image.json" "$IMAGE" || exit 2

trivy convert --format sarif --output "$OUTPUT/trivy-image.sarif" \
  "$OUTPUT/trivy-image.json" || exit 2

if [[ -n "$DOCKERFILE" ]]; then
  echo "==> Scanning Dockerfile $DOCKERFILE"
  trivy config "${common[@]}" --format json \
    --output "$OUTPUT/trivy-config.json" "$DOCKERFILE" || exit 2
fi

# ── Counts + policy evaluation ───────────────────────────────────────────────
fail_json=$(jq -Rc 'split(",") | map(ascii_upcase)' <<<"$FAIL_ON")

jq --argjson fail "$fail_json" '
  [.Results[]?.Vulnerabilities[]?] as $v
  | [.Results[]?.Secrets[]?] as $s
  | {
      critical: ($v | map(select(.Severity == "CRITICAL")) | length),
      high:     ($v | map(select(.Severity == "HIGH"))     | length),
      medium:   ($v | map(select(.Severity == "MEDIUM"))   | length),
      low:      ($v | map(select(.Severity == "LOW"))      | length),
      unknown:  ($v | map(select(.Severity == "UNKNOWN"))  | length),
      secrets:  ($s | length),
      fixable_blocking: ($v | map(select((.Severity as $sev | $fail | index($sev)) and ((.FixedVersion // "") != ""))) | length)
    }' "$OUTPUT/trivy-image.json" > "$OUTPUT/counts.json"

misconfig_count=0
if [[ -f "$OUTPUT/trivy-config.json" ]]; then
  misconfig_count=$(jq '[.Results[]?.Misconfigurations[]? | select(.Status == "FAIL")] | length' "$OUTPUT/trivy-config.json")
fi

read -r critical high medium low unknown secrets blocking < <(
  jq -r '"\(.critical) \(.high) \(.medium) \(.low) \(.unknown) \(.secrets) \(.fixable_blocking)"' "$OUTPUT/counts.json"
)

# ── Markdown report ──────────────────────────────────────────────────────────
{
  echo "### Container scan: \`$NAME\`"
  echo
  echo "Image: \`$IMAGE\` · Policy: fail on fixable \`$FAIL_ON\` or any secret"
  echo
  echo "| Critical | High | Medium | Low | Unknown | Secrets | Dockerfile misconfigs |"
  echo "|---:|---:|---:|---:|---:|---:|---:|"
  echo "| $critical | $high | $medium | $low | $unknown | $secrets | $misconfig_count |"
  echo
  if [[ "$blocking" -gt 0 ]]; then
    echo "#### Blocking findings ($blocking)"
    echo
    echo "| Severity | ID | Package | Installed | Fixed | Target |"
    echo "|---|---|---|---|---|---|"
    jq -r --argjson fail "$fail_json" '
      .Results[]? | .Target as $t | .Vulnerabilities[]?
      | select((.Severity as $sev | $fail | index($sev)) and ((.FixedVersion // "") != ""))
      | "| \(.Severity) | [\(.VulnerabilityID)](\(.PrimaryURL // "")) | \(.PkgName) | \(.InstalledVersion) | \(.FixedVersion) | \($t) |"
    ' "$OUTPUT/trivy-image.json" | sort -u | head -200
    echo
  fi
  if [[ "$secrets" -gt 0 ]]; then
    echo "#### Secrets found ($secrets)"
    echo
    jq -r '.Results[]? | .Target as $t | .Secrets[]? | "- `\(.RuleID)` in `\($t)` (\(.Severity))"' "$OUTPUT/trivy-image.json"
    echo
  fi
  if [[ "$misconfig_count" -gt 0 ]]; then
    echo "#### Dockerfile misconfigurations ($misconfig_count, advisory)"
    echo
    jq -r '.Results[]?.Misconfigurations[]? | select(.Status == "FAIL") | "- **\(.Severity)** `\(.ID)` — \(.Title)"' "$OUTPUT/trivy-config.json"
    echo
  fi
} > "$OUTPUT/summary.md"

cat "$OUTPUT/summary.md"

if [[ "$blocking" -gt 0 || "$secrets" -gt 0 ]]; then
  echo "==> POLICY VIOLATION: $blocking fixable $FAIL_ON vulnerabilities, $secrets secrets in $NAME" >&2
  exit 1
fi

echo "==> $NAME passed the scan policy"
