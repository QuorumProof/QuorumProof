# Cost Alert Thresholds

Issue #1661 — Add Cost Alert Thresholds

This document covers the cost monitoring setup, alert thresholds, alert
routing, and threshold tuning guidance for QuorumProof's Stellar Soroban
gas costs.

For background on the gas cost tracking implementation, see
[docs/cost-optimization-guide.md](cost-optimization-guide.md).

---

## Table of Contents

1. [Overview](#overview)
2. [Cost Metrics](#cost-metrics)
3. [Alert Thresholds](#alert-thresholds)
4. [Alert Routing](#alert-routing)
5. [Threshold Tuning](#threshold-tuning)
6. [Per-Operation Tuning](#per-operation-tuning)
7. [Reducing Cost](#reducing-cost)
8. [Emergency Response](#emergency-response)

---

## Overview

Soroban charges a `minResourceFee` (in stroops) per contract invocation,
based on CPU, memory, and ledger-entry usage. Without monitoring, cost
overruns go unnoticed until the infrastructure bill arrives.

QuorumProof records every fee via `api-server/src/services/gasCostTracker.ts`
and exposes three Prometheus metrics used by the alert rules in
`monitoring/prometheus/alerts.yml` (group: `quorumproof-cost`):

| Metric | Type | Description |
|---|---|---|
| `quorumproof_cost_operation_stroops_total` | Counter | Cumulative gas cost per operation name (stroops) |
| `quorumproof_cost_daily_budget_stroops` | Gauge | Operator-configured daily budget (default 100,000,000 stroops = 10 XLM) |
| `quorumproof_cost_total_stroops_24h` | Gauge (recorded) | Rolling 24-hour total (computed by recording rule in alerts.yml) |

1 XLM = 10,000,000 stroops. At $0.12/XLM, 100,000,000 stroops ≈ $0.12/day.

---

## Cost Metrics

### Viewing the cost report

```bash
# Full report: totals + per-operation breakdown
curl -sf http://<API_URL>/api/costs/report | jq .

# Top N operations by spend
curl -sf "http://<API_URL>/api/costs/optimizations?top=5" | jq .

# Project cost for a given volume
curl -sf "http://<API_URL>/api/costs/projection?operation=is_attested&callsPerDay=10000&days=30" | jq .
```

### Grafana dashboard

A cost panel can be added to the existing Grafana contract-health dashboard.
Import the following PromQL queries into a new panel:

```promql
# Rolling 24-hour gas cost in XLM
quorumproof_cost_total_stroops_24h / 10000000

# Per-operation cost breakdown (top 5, last 24 h)
topk(5,
  sum by (operation) (
    increase(quorumproof_cost_operation_stroops_total[24h])
  )
) / 10000000
```

---

## Alert Thresholds

Three alert rules are defined in `monitoring/prometheus/alerts.yml` under
the `quorumproof-cost` group:

### CostBudgetWarning (warning)

```yaml
expr: quorumproof_cost_total_stroops_24h > (quorumproof_cost_daily_budget_stroops * 0.80)
for: 15m
```

Fires when the rolling 24-hour cost exceeds **80 % of the daily budget**.
This gives 15–30 minutes of warning before the critical threshold is hit,
enough time to review top spenders and reduce call volume.

### CostBudgetCritical (critical → PagerDuty)

```yaml
expr: quorumproof_cost_total_stroops_24h > quorumproof_cost_daily_budget_stroops
for: 5m
```

Fires when the rolling 24-hour cost **exceeds 100 % of the daily budget**.
Routes to both `#quorumproof-cost` (Slack) and `#quorumproof-critical`
(Slack + PagerDuty) via the alertmanager routing tree.

### CostOperationSpike (warning)

```yaml
expr: increase(quorumproof_cost_operation_stroops_total[1h]) > (quorumproof_cost_daily_budget_stroops / 48)
for: 10m
```

Fires when a **single operation** consumes more than `budget / 48` stroops
in one hour (equivalent to 50 % of the hourly budget allocation). This
catches explosive call patterns from a single integration before the 24-hour
rolling window triggers.

---

## Alert Routing

Alertmanager (`monitoring/prometheus/alertmanager.yml`) routes cost alerts
as follows:

```
CostBudgetWarning (severity: warning, team: platform)
  → #quorumproof-cost (Slack)
  → repeat every 4 h

CostBudgetCritical (severity: critical, team: platform)
  → #quorumproof-cost (Slack)         ← via platform route (continue: true)
  → #quorumproof-critical (Slack)     ← via critical route
  → PagerDuty on-call                 ← via critical route

CostOperationSpike (severity: warning, team: platform)
  → #quorumproof-cost (Slack)
  → repeat every 4 h
```

The `team: platform` label on all cost alerts ensures they are routed to the
`quorumproof-platform` receiver (dedicated `#quorumproof-cost` channel)
regardless of severity, so billing alerts are separated from operational
noise in `#quorumproof-alerts`.

### Configuring the Slack channel

```bash
# Update the Kubernetes secret to set the webhook URL
kubectl -n quorumproof create secret generic quorumproof-api-server-env \
  --from-literal=SLACK_ALERT_WEBHOOK_URL=https://hooks.slack.com/... \
  --dry-run=client -o yaml | kubectl apply -f -
```

The `#quorumproof-cost` channel must exist in your Slack workspace and
the webhook must be configured to post to it. The channel name is hardcoded
in `monitoring/prometheus/alertmanager.yml`; change it to match your
workspace if needed.

---

## Threshold Tuning

### Setting the daily budget

The daily budget is controlled by the `quorumproof_cost_daily_budget_stroops`
Prometheus gauge. The exporter reads this from the environment:

```bash
# .env or Kubernetes secret
COST_DAILY_BUDGET_STROOPS=100000000   # 10 XLM/day (default)
```

Set the budget based on:
1. Run `GET /api/costs/report` for 7 days to establish a baseline.
2. Set the budget to 2× the p95 daily cost observed during that baseline.
3. Adjust upward for planned high-traffic events; adjust downward after
   optimisation work.

### Changing thresholds

The warning threshold (80 %) and critical threshold (100 %) are expressed as
multipliers in `alerts.yml`. To change:

```bash
# Example: lower warning to 70 %, raise critical to 120 %
# Edit monitoring/prometheus/alerts.yml:

# CostBudgetWarning
expr: quorumproof_cost_total_stroops_24h > (quorumproof_cost_daily_budget_stroops * 0.70)

# CostBudgetCritical
expr: quorumproof_cost_total_stroops_24h > (quorumproof_cost_daily_budget_stroops * 1.20)
```

Reload Prometheus after editing alerts.yml:

```bash
curl -X POST http://localhost:9090/-/reload
```

### Per-environment tuning

Use different budgets for staging vs production by setting different values
for `COST_DAILY_BUDGET_STROOPS` in each environment's Kubernetes secret:

```bash
# Staging: lower budget catches runaway tests early
COST_DAILY_BUDGET_STROOPS=10000000   # 1 XLM/day

# Production: budget based on measured p95 daily cost × 2
COST_DAILY_BUDGET_STROOPS=200000000  # 20 XLM/day
```

---

## Per-Operation Tuning

When `CostOperationSpike` fires for a specific operation, use the cost API
to investigate and tune:

```bash
# Which operation is spiking?
curl -sf "http://<API_URL>/api/costs/optimizations?top=10" | jq '.[].operation'

# How much is it costing?
curl -sf "http://<API_URL>/api/costs/report" | jq '.perOperation["is_attested"]'

# Project the cost at current call rate
curl -sf "http://<API_URL>/api/costs/projection?operation=is_attested&callsPerDay=50000&days=30" | jq .
```

### Common high-cost operations and mitigations

| Operation | Typical cost | Mitigation |
|---|---|---|
| `verify_groth16_proof` | High (ZK pairing) | Cache proof results for identical (credential_id, proof) pairs; use the verification cache (see docs/verification-cache-invalidation.md). |
| `is_attested` | Low-medium | Batch via `verify-batch`; avoid per-request calls from high-frequency relying parties. |
| `get_credential` | Low | Already cached by the api-server search index; ensure cache TTL is set. |
| `create_slice` / `attest` | Medium | These are write operations; cost is proportional to ledger entries written. No easy mitigation — review batch issuance limits. |

---

## Reducing Cost

When `CostBudgetWarning` or `CostBudgetCritical` fires:

1. **Check top spenders:**
   ```bash
   curl -sf "http://<API_URL>/api/costs/optimizations?top=10" | jq .
   ```

2. **Apply quick wins:**
   - Enable verification caching for `verify_groth16_proof` (biggest cost reduction).
   - Increase cache TTL for `is_attested` results.
   - Switch high-frequency relying parties to `verify-batch` instead of individual calls.

3. **Throttle abusive callers:**
   - Check rate-limit hits in Grafana.
   - Apply stricter rate limits to the offending API key (see docs/OPERATOR_RUNBOOK.md).

4. **Defer non-critical background work:**
   ```bash
   kubectl -n quorumproof set env deployment/quorumproof-api-server \
     DISABLE_BACKGROUND_JOBS=true
   ```

---

## Emergency Response

When `CostBudgetCritical` fires and on-call is paged:

1. **Assess scope** — is this a cost spike from a legitimate traffic surge, or
   an unexpected runaway process?
   ```bash
   curl -sf "http://<API_URL>/api/costs/report" | jq '.total | {calls, totalXlm}'
   ```

2. **Identify the source** — check the top-spending operation and the request
   logs in Loki for the calling integration.

3. **Immediate containment** — disable background jobs, apply throttling, or
   temporarily pause non-critical API keys.

4. **After the incident** — update the budget, apply permanent mitigations,
   and document in an incident ticket. Update this guide if a new pattern was
   found.
