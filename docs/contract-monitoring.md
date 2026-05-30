# Contract Monitoring Implementation Guide

## Overview

This guide covers the automated contract monitoring system for QuorumProof, including gas usage tracking, anomaly detection, and the monitoring dashboard.

---

## Architecture

```
Stellar RPC / Soroban
        │
        ▼
  quorumproof-exporter   (event scraper, port 9101)
        │
        ├─→ Prometheus   (metrics storage, port 9090)
        │
        ├─→ Grafana      (dashboards, port 3000)
        │
        └─→ AlertManager (alerting, port 9093)
```

---

## Quick Start

### 1. Configure Environment

```bash
# Copy example env
cp .env.example .env

# Set required variables
export STELLAR_RPC_URL=https://soroban-testnet.stellar.org
export CONTRACT_QUORUM_PROOF=<your-contract-id>
export SCRAPE_INTERVAL_SECONDS=15
export EXPORTER_PORT=9101
```

### 2. Start Monitoring Stack

```bash
cd monitoring

# Build and start all services
docker compose up -d

# Verify services are running
docker compose ps

# View logs
docker compose logs -f quorumproof-exporter
```

### 3. Access Dashboards

- **Prometheus**: http://localhost:9090
- **Grafana**: http://localhost:3000 (admin/admin)
- **AlertManager**: http://localhost:9093
- **Exporter metrics**: http://localhost:9101/metrics

---

## Metrics Reference

All metrics are prefixed `quorumproof_`.

### Counters

| Metric | Description | Labels |
|---|---|---|
| `quorumproof_credentials_issued_total` | Total credentials issued | - |
| `quorumproof_credentials_revoked_total` | Total credentials revoked | - |
| `quorumproof_attestations_total` | Total attestations created | - |
| `quorumproof_proof_requests_total` | Total ZK proof requests | - |
| `quorumproof_api_errors_total` | Total API errors | `error_code` |
| `quorumproof_rate_limit_hits_total` | Rate limit exceeded events | `address` |

### Gauges

| Metric | Description | Labels |
|---|---|---|
| `quorumproof_attestation_success_rate` | Attestation success rate (0–1) | - |
| `quorumproof_contract_paused` | Contract pause status (0 or 1) | - |
| `quorumproof_active_slices_total` | Number of active quorum slices | - |
| `quorumproof_contract_gas_usage` | Gas used per operation | `operation` |
| `quorumproof_contract_state_size` | Contract state size in bytes | - |

### Histograms

| Metric | Description | Labels |
|---|---|---|
| `quorumproof_api_request_duration_seconds` | RPC call latency | - |
| `quorumproof_contract_invocation_duration_seconds` | Contract invocation latency | `operation` |

---

## Gas Usage Monitoring

### Tracking Gas Trends

The exporter tracks gas usage per operation type:

```bash
# Query gas usage for credential issuance
curl -s 'http://localhost:9090/api/v1/query' \
  --data-urlencode 'query=quorumproof_contract_gas_usage{operation="issue_credential"}' | jq .
```

### Gas Anomaly Detection

Prometheus alerts fire when gas usage exceeds thresholds:

```yaml
- alert: HighGasUsage
  expr: quorumproof_contract_gas_usage > 1000000
  for: 5m
  labels:
    severity: warning
```

### Optimization Recommendations

If gas usage is consistently high:

1. **Check contract state size**: `quorumproof_contract_state_size`
2. **Review operation frequency**: `rate(quorumproof_*_total[5m])`
3. **Analyze error patterns**: `quorumproof_api_errors_total`
4. **Profile contract code**: Use Soroban profiler on testnet

---

## Alerting Rules

Alerts are defined in `prometheus/alerts.yml` and routed to AlertManager.

### Critical Alerts

| Alert | Condition | Action |
|---|---|---|
| `HighErrorRate` | >10% of requests error | Page on-call engineer |
| `APIDown` | Exporter unreachable | Check RPC endpoint health |
| `ContractPaused` | Contract paused | Investigate pause reason |

### Warning Alerts

| Alert | Condition | Action |
|---|---|---|
| `LowAttestationRate` | <50% attestation success | Review attestor status |
| `RateLimitSpike` | >5 rate limit hits/s | Check for abuse patterns |
| `HighGasUsage` | >1M gas per operation | Optimize contract code |

---

## Dashboard Panels

### Credential Volume Dashboard

- **Credentials issued / hour**: Rate of new credentials
- **Credentials revoked / hour**: Revocation rate
- **Cumulative credential count**: Total issued over time
- **Active slices**: Current slice count

### Attestation Health Dashboard

- **Attestation success rate**: Gauge (target: >90%)
- **Attestations / hour**: Rate of new attestations
- **Error trends**: Stacked bar by error code
- **Fork detections**: Count of fork-related errors

### API Latency & Errors Dashboard

- **p50 / p95 / p99 RPC latency**: Percentile heatmap
- **Error rate**: Percentage of failed requests
- **Contract paused status**: Single-stat panel (red when paused)
- **Gas usage trends**: Line chart by operation

---

## Exporter Configuration

### Environment Variables

```env
# Stellar RPC endpoint
STELLAR_RPC_URL=https://soroban-testnet.stellar.org

# Contract ID to monitor
CONTRACT_QUORUM_PROOF=CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4

# Scrape interval in seconds
SCRAPE_INTERVAL_SECONDS=15

# Exporter HTTP port
EXPORTER_PORT=9101
```

### Prometheus Configuration

Edit `prometheus/prometheus.yml` to add the exporter job:

```yaml
scrape_configs:
  - job_name: 'quorumproof-exporter'
    static_configs:
      - targets: ['quorumproof-exporter:9101']
    scrape_interval: 15s
    scrape_timeout: 10s
```

---

## Troubleshooting

### No metrics appearing

1. Check exporter is running: `docker compose ps quorumproof-exporter`
2. Check logs: `docker compose logs quorumproof-exporter`
3. Verify RPC endpoint is reachable: `curl $STELLAR_RPC_URL/health`
4. Verify contract ID is correct: `echo $CONTRACT_QUORUM_PROOF`

### High error rate

1. Check RPC endpoint status
2. Verify contract is not paused
3. Check contract state size: `quorumproof_contract_state_size`
4. Review error codes: `quorumproof_api_errors_total`

### Metrics not updating

1. Check scrape interval: `SCRAPE_INTERVAL_SECONDS`
2. Verify Prometheus is scraping: http://localhost:9090/targets
3. Check exporter health: `curl http://localhost:9101/metrics`

### Grafana dashboards empty

1. Verify Prometheus data source is configured
2. Check Prometheus has data: http://localhost:9090/graph
3. Verify dashboard queries are correct
4. Check time range is not too narrow

---

## Performance Tuning

### Reduce Scrape Interval

For more frequent updates (use with caution):

```bash
export SCRAPE_INTERVAL_SECONDS=5
docker compose restart quorumproof-exporter
```

### Increase Prometheus Retention

For longer metric history:

```yaml
# In docker-compose.yml
command:
  - "--storage.tsdb.retention.time=90d"
```

### Scale Exporter

For high-volume monitoring, run multiple exporter instances:

```yaml
quorumproof-exporter-1:
  # ... config ...
  environment:
    EXPORTER_PORT: 9101

quorumproof-exporter-2:
  # ... config ...
  environment:
    EXPORTER_PORT: 9102
```

---

## Integration with Alerting

### Slack Integration

Configure AlertManager to send alerts to Slack:

```yaml
# prometheus/alertmanager.yml
receivers:
  - name: 'slack'
    slack_configs:
      - api_url: 'https://hooks.slack.com/services/YOUR/WEBHOOK/URL'
        channel: '#quorumproof-alerts'
```

### PagerDuty Integration

```yaml
receivers:
  - name: 'pagerduty'
    pagerduty_configs:
      - service_key: 'YOUR_SERVICE_KEY'
```

---

## Related Documentation

- [Audit Log Format](../docs/audit-log-format.md) — Event types and parsing
- [Monitoring Guide](../docs/monitoring-guide.md) — Prometheus & Grafana setup
- [Disaster Recovery](../docs/disaster-recovery.md) — Backup and restore
