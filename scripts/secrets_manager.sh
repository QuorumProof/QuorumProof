#!/usr/bin/env bash
# scripts/secrets_manager.sh — Issue #1656: Secrets management operations.
#
# Provides a unified interface for reading, writing, rotating, and auditing
# secrets stored in AWS Secrets Manager (Vault-compatible path convention).
# All operations are logged to a structured audit log.
#
# Usage:
#   ./scripts/secrets_manager.sh <command> [options]
#
# Commands:
#   get     <secret-path>              Retrieve a secret value
#   set     <secret-path> <value>      Store or update a secret
#   rotate  <secret-path>              Trigger manual rotation
#   list    [prefix]                   List secrets matching prefix
#   audit   [--since DURATION]         Show access audit log
#   check                              Verify all required secrets exist
#
# Secret path convention (mirrors HashiCorp Vault KV-v2):
#   quorumproof/<environment>/<service>/<key>
#   e.g. quorumproof/production/stellar/deploy-key
#
# Environment variables:
#   ENVIRONMENT           — staging | production (default: staging)
#   AWS_REGION            — AWS region (default: us-east-1)
#   AUDIT_LOG_FILE        — Path to append audit log entries (default: /var/log/quorumproof/secrets-audit.log)
#   VAULT_ADDR            — If set, use HashiCorp Vault instead of Secrets Manager
#   VAULT_TOKEN           — Vault token (required when VAULT_ADDR is set)

set -euo pipefail

ENVIRONMENT="${ENVIRONMENT:-staging}"
AWS_REGION="${AWS_REGION:-us-east-1}"
AUDIT_LOG_FILE="${AUDIT_LOG_FILE:-/tmp/quorumproof-secrets-audit.log}"
VAULT_ADDR="${VAULT_ADDR:-}"
VAULT_TOKEN="${VAULT_TOKEN:-}"
PROJECT="quorumproof"

# ── Utility functions ─────────────────────────────────────────────────────────
log()   { echo "[$(date -u +%H:%M:%SZ)] $*" >&2; }
fail()  { log "ERROR: $*"; exit 1; }

require_cmd() { command -v "$1" &>/dev/null || fail "Required command not found: $1"; }

# Write a structured audit log entry (JSON Lines)
audit_log() {
  local action="$1"
  local secret_path="$2"
  local status="${3:-ok}"
  local actor
  actor="$(aws sts get-caller-identity --query 'Arn' --output text 2>/dev/null || echo "unknown")"

  local entry
  entry=$(jq -n \
    --arg ts "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    --arg action "$action" \
    --arg path "$secret_path" \
    --arg status "$status" \
    --arg actor "$actor" \
    --arg env "$ENVIRONMENT" \
    --arg hostname "$(hostname -f 2>/dev/null || hostname)" \
    '{timestamp: $ts, action: $action, secret_path: $path, status: $status, actor: $actor, environment: $env, hostname: $hostname}')

  # Append to audit log (create directory if needed)
  mkdir -p "$(dirname "$AUDIT_LOG_FILE")"
  echo "$entry" >> "$AUDIT_LOG_FILE"
  log "AUDIT: action=${action} path=${secret_path} status=${status}"
}

# ── Backend selection ─────────────────────────────────────────────────────────
use_vault() { [[ -n "$VAULT_ADDR" && -n "$VAULT_TOKEN" ]]; }

# Get a secret from Vault or Secrets Manager
backend_get() {
  local path="$1"
  if use_vault; then
    VAULT_ADDR="$VAULT_ADDR" VAULT_TOKEN="$VAULT_TOKEN" \
      vault kv get -mount=secret -field=value "$path" 2>/dev/null
  else
    aws secretsmanager get-secret-value \
      --region "$AWS_REGION" \
      --secret-id "$path" \
      --query 'SecretString' \
      --output text 2>/dev/null
  fi
}

# Put a secret to Vault or Secrets Manager
backend_put() {
  local path="$1"
  local value="$2"
  if use_vault; then
    VAULT_ADDR="$VAULT_ADDR" VAULT_TOKEN="$VAULT_TOKEN" \
      vault kv put -mount=secret "$path" value="$value"
  else
    # Try update first; create if not exists
    if aws secretsmanager describe-secret \
        --region "$AWS_REGION" \
        --secret-id "$path" &>/dev/null; then
      aws secretsmanager put-secret-value \
        --region "$AWS_REGION" \
        --secret-id "$path" \
        --secret-string "$value"
    else
      aws secretsmanager create-secret \
        --region "$AWS_REGION" \
        --name "$path" \
        --secret-string "$value" \
        --description "QuorumProof ${ENVIRONMENT} secret — managed by secrets_manager.sh"
    fi
  fi
}

# Trigger rotation for a secret
backend_rotate() {
  local path="$1"
  if use_vault; then
    fail "Manual rotation via Vault requires a custom rotation script; use vault lease renew or configure dynamic secrets."
  else
    aws secretsmanager rotate-secret \
      --region "$AWS_REGION" \
      --secret-id "$path" \
      --rotate-immediately
  fi
}

# List secrets under a prefix
backend_list() {
  local prefix="${1:-${PROJECT}/${ENVIRONMENT}}"
  if use_vault; then
    VAULT_ADDR="$VAULT_ADDR" VAULT_TOKEN="$VAULT_TOKEN" \
      vault kv list -mount=secret "$prefix" 2>/dev/null
  else
    aws secretsmanager list-secrets \
      --region "$AWS_REGION" \
      --filters "Key=name,Values=${prefix}" \
      --query 'SecretList[].Name' \
      --output text 2>/dev/null | tr '\t' '\n'
  fi
}

# ── Required secrets manifest ─────────────────────────────────────────────────
required_secrets() {
  echo "${PROJECT}/${ENVIRONMENT}/stellar/deploy-key"
  echo "${PROJECT}/${ENVIRONMENT}/database/url"
  echo "${PROJECT}/${ENVIRONMENT}/api-server/jwt-secret"
  echo "${PROJECT}/${ENVIRONMENT}/api-server/webhook-signing-key"
  echo "${PROJECT}/${ENVIRONMENT}/monitoring/pagerduty-routing-key"
  echo "${PROJECT}/${ENVIRONMENT}/monitoring/slack-webhook-url"
}

# ── Commands ──────────────────────────────────────────────────────────────────
cmd_get() {
  local path="${1:?get requires a secret path}"
  require_cmd jq
  log "Getting secret: ${path}"

  local value
  value=$(backend_get "$path") || {
    audit_log "get" "$path" "not-found"
    fail "Secret not found: ${path}"
  }

  audit_log "get" "$path" "ok"
  echo "$value"
}

cmd_set() {
  local path="${1:?set requires a secret path}"
  local value="${2:?set requires a value}"
  require_cmd jq

  log "Setting secret: ${path}"
  backend_put "$path" "$value" || {
    audit_log "set" "$path" "error"
    fail "Failed to set secret: ${path}"
  }
  audit_log "set" "$path" "ok"
  log "Secret set successfully: ${path}"
}

cmd_rotate() {
  local path="${1:?rotate requires a secret path}"
  require_cmd jq

  log "Triggering rotation for: ${path}"
  backend_rotate "$path" || {
    audit_log "rotate" "$path" "error"
    fail "Rotation failed: ${path}"
  }
  audit_log "rotate" "$path" "ok"
  log "Rotation triggered: ${path}"
}

cmd_list() {
  local prefix="${1:-${PROJECT}/${ENVIRONMENT}}"
  log "Listing secrets under: ${prefix}"
  audit_log "list" "$prefix" "ok"
  backend_list "$prefix"
}

cmd_audit() {
  local since_flag=""
  local since_val=""

  while [[ $# -gt 0 ]]; do
    case "$1" in
      --since) since_val="${2:?--since requires a duration (e.g. 1h, 24h)}"; shift ;;
      *) echo "Unknown option: $1" >&2; exit 1 ;;
    esac
    shift
  done

  if [[ ! -f "$AUDIT_LOG_FILE" ]]; then
    log "Audit log not found: ${AUDIT_LOG_FILE}"
    exit 0
  fi

  log "Showing audit log: ${AUDIT_LOG_FILE}"

  if [[ -n "$since_val" ]]; then
    # Filter by timestamp (requires GNU date or python3)
    local cutoff
    cutoff=$(python3 -c "
import sys, datetime, re
s = sys.argv[1]
m = re.match(r'^(\d+)(h|d|m)$', s)
if not m: sys.exit('Invalid duration: ' + s)
n, unit = int(m.group(1)), m.group(2)
delta = {'h': datetime.timedelta(hours=n), 'd': datetime.timedelta(days=n), 'm': datetime.timedelta(minutes=n)}[unit]
print((datetime.datetime.utcnow() - delta).strftime('%Y-%m-%dT%H:%M:%SZ'))
" "$since_val" 2>/dev/null) || cutoff=""

    if [[ -n "$cutoff" ]]; then
      jq -r "select(.timestamp >= \"${cutoff}\") | [.timestamp, .action, .secret_path, .status, .actor] | @tsv" \
        "$AUDIT_LOG_FILE" 2>/dev/null | column -t
      return
    fi
  fi

  jq -r '[.timestamp, .action, .secret_path, .status, .actor] | @tsv' \
    "$AUDIT_LOG_FILE" 2>/dev/null | column -t
}

cmd_check() {
  require_cmd jq
  local missing=0
  log "Checking required secrets for environment: ${ENVIRONMENT}"

  while IFS= read -r path; do
    if backend_get "$path" &>/dev/null; then
      log "  [OK]      ${path}"
    else
      log "  [MISSING] ${path}"
      missing=$((missing + 1))
    fi
  done < <(required_secrets)

  if [[ $missing -gt 0 ]]; then
    fail "${missing} required secret(s) missing. Run 'secrets_manager.sh set <path> <value>' to populate them."
  fi

  log "All required secrets present."
}

# ── Entrypoint ────────────────────────────────────────────────────────────────
COMMAND="${1:-}"
shift || true

case "$COMMAND" in
  get)    require_cmd aws; require_cmd jq; cmd_get    "$@" ;;
  set)    require_cmd aws; require_cmd jq; cmd_set    "$@" ;;
  rotate) require_cmd aws; require_cmd jq; cmd_rotate "$@" ;;
  list)   require_cmd aws;               cmd_list   "$@" ;;
  audit)  require_cmd jq;                cmd_audit  "$@" ;;
  check)  require_cmd aws; require_cmd jq; cmd_check  "$@" ;;
  ""|help|--help|-h)
    cat <<'EOF'
Usage: secrets_manager.sh <command> [options]

Commands:
  get    <path>              Retrieve a secret value
  set    <path> <value>      Store or update a secret
  rotate <path>              Trigger immediate rotation
  list   [prefix]            List secrets under prefix
  audit  [--since DURATION]  Show audit log (durations: 1h, 24h, 7d)
  check                      Verify all required secrets exist

Path convention:  quorumproof/<environment>/<service>/<key>

Examples:
  ENVIRONMENT=production ./scripts/secrets_manager.sh check
  ./scripts/secrets_manager.sh get quorumproof/staging/stellar/deploy-key
  ./scripts/secrets_manager.sh set quorumproof/staging/api-server/jwt-secret "$(openssl rand -hex 32)"
  ./scripts/secrets_manager.sh audit --since 24h
EOF
    ;;
  *)
    echo "Unknown command: $COMMAND" >&2
    echo "Run '$0 --help' for usage." >&2
    exit 1
    ;;
esac
