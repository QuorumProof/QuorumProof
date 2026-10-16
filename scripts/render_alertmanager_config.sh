#!/usr/bin/env bash
# scripts/render_alertmanager_config.sh — Issue #1486
#
# Materialises monitoring/prometheus/alertmanager.yml from itself by
# substituting the ${SLACK_ALERT_WEBHOOK_URL} and ${PAGERDUTY_ROUTING_KEY}
# placeholders with values from the environment.
#
# The rendered file is written to  monitoring/prometheus/alertmanager.rendered.yml
# and mounted into the Alertmanager container by docker-compose.yml in place of
# the template.  The rendered file must never be committed to the repository
# (it is in .gitignore).
#
# Required environment variables:
#   SLACK_ALERT_WEBHOOK_URL   — full Slack incoming webhook URL
#                               e.g. https://hooks.slack.com/services/T.../B.../...
#   PAGERDUTY_ROUTING_KEY     — PagerDuty Events API v2 integration key (32 hex chars)
#
# Usage:
#   export SLACK_ALERT_WEBHOOK_URL="https://hooks.slack.com/..."
#   export PAGERDUTY_ROUTING_KEY="abc123..."
#   ./scripts/render_alertmanager_config.sh
#
# Docker Compose usage (called automatically before `docker compose up`):
#   docker compose --env-file .env \
#     run --rm render-alertmanager-config  # see docker-compose.yml

set -euo pipefail

TEMPLATE="$(dirname "$0")/../monitoring/prometheus/alertmanager.yml"
OUTPUT="$(dirname "$0")/../monitoring/prometheus/alertmanager.rendered.yml"

# ── Startup check: fail loudly if required env vars are not set ────────────
missing=()

if [[ -z "${SLACK_ALERT_WEBHOOK_URL:-}" ]]; then
  missing+=("SLACK_ALERT_WEBHOOK_URL")
fi

if [[ -z "${PAGERDUTY_ROUTING_KEY:-}" ]]; then
  missing+=("PAGERDUTY_ROUTING_KEY")
fi

if [[ ${#missing[@]} -gt 0 ]]; then
  echo "ERROR: The following required environment variables are not set:" >&2
  for var in "${missing[@]}"; do
    echo "  - ${var}" >&2
  done
  echo "" >&2
  echo "Alertmanager will post notifications to the literal placeholder string" >&2
  echo "\${...} if these are left unset, meaning alerts will never be delivered." >&2
  echo "" >&2
  echo "Set the variables in your shell or in a .env file and re-run:" >&2
  echo "" >&2
  echo "  export SLACK_ALERT_WEBHOOK_URL=\"https://hooks.slack.com/services/...\"" >&2
  echo "  export PAGERDUTY_ROUTING_KEY=\"<32-char integration key>\"" >&2
  echo "" >&2
  echo "See docs/deployment-guide.md §8 (Alertmanager Configuration) for details." >&2
  exit 1
fi

# ── Render template ────────────────────────────────────────────────────────
envsubst '${SLACK_ALERT_WEBHOOK_URL} ${PAGERDUTY_ROUTING_KEY}' \
  < "${TEMPLATE}" \
  > "${OUTPUT}"

echo "Rendered alertmanager config → ${OUTPUT}"
