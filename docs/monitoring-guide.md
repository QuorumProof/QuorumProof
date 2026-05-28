# Monitoring Guide

QuorumProof uses Prometheus for metrics collection and Grafana for dashboards. This guide covers setup, available metrics, dashboard descriptions, and alerting rules.

## Architecture

```
Stellar RPC / Horizon
        │
        ▼
  quorumproof-exporter   (custom event scraper, port 9101)
        │
        ▼
    Prometheus            (port 9090)
        │
        ▼
      Grafana             (port 3000)
```

The `quorumproof-exporter` polls contract events from the Stellar RPC and exposes them as Prometheus metrics. No changes to the smart contract are required.

---

## Quick Start

```bash
# Copy example env
cp .env.example .env

# Start the full monitoring stack
docker compose -f monitoring/docker-compose.yml up -d

# Open Grafana
open http://localhost:3000   # admin / admin (change on first login)
```

---

## Metrics Reference

All metrics are prefixed `quorumproof_`.

| Metric | Type | Description |
|---|---|---|
| `quorumproof_credentials_issued_total` | Counter | Total credentials issued since deployment |
| `quorumproof_credentials_revoked_total` | Counter | Total credentials revoked |
| `quorumproof_attestations_total` | Counter | Total attestation events |
| `quorumproof_attestation_success_rate` | Gauge | Ratio of attested credentials to total issued (0–1) |
| `quorumproof_api_request_duration_seconds` | Histogram | RPC call latency (buckets: 0.1, 0.5, 1, 2, 5 s) |
| `quorumproof_api_errors_total` | Counter | Total RPC / contract errors, labelled by `error_code` |
| `quorumproof_contract_paused` | Gauge | 1 if contract is paused, 0 otherwise |
| `quorumproof_active_slices_total` | Gauge | Number of quorum slices currently active |
| `quorumproof_proof_requests_total` | Counter | Total ZK proof requests generated |
| `quorumproof_rate_limit_hits_total` | Counter | Times rate limit was exceeded, labelled by `address` |

---

## Grafana Dashboards

Three dashboards are provisioned automatically from `monitoring/grafana/dashboards/`.

### 1. Credential Volume (`credential-volume.json`)

Panels:
- **Credentials issued / hour** — time-series of `rate(quorumproof_credentials_issued_total[1h])`
- **Credentials revoked / hour** — time-series of revocations
- **Cumulative credential count** — total issued over time
- **Active slices** — current slice count gauge

### 2. Attestation Health (`attestation-health.json`)

Panels:
- **Attestation success rate** — gauge showing `quorumproof_attestation_success_rate`
- **Attestations / hour** — rate of new attestations
- **Error trends** — stacked bar of `quorumproof_api_errors_total` by `error_code`
- **Fork detections** — count of `ForkDetected` error events

### 3. API Latency & Errors (`api-latency.json`)

Panels:
- **p50 / p95 / p99 RPC latency** — percentile heatmap
- **Error rate** — `rate(quorumproof_api_errors_total[5m])`
- **Contract paused status** — single-stat panel (red when paused)

---

## Alerting Rules

Alerts are defined in `monitoring/prometheus/alerts.yml`.

| Alert | Condition | Severity | Description |
|---|---|---|---|
| `HighErrorRate` | `rate(quorumproof_api_errors_total[5m]) > 0.1` | critical | More than 10% of requests are erroring |
| `APIDown` | `up{job="quorumproof-exporter"} == 0` | critical | Exporter is unreachable (contract API unavailable) |
| `ContractPaused` | `quorumproof_contract_paused == 1` | warning | Contract has been paused by admin |
| `LowAttestationRate` | `quorumproof_attestation_success_rate < 0.5` | warning | Less than 50% of credentials are attested |
| `RateLimitSpike` | `rate(quorumproof_rate_limit_hits_total[5m]) > 5` | warning | Unusual rate-limit activity |

Alerts are routed to the `quorumproof-ops` receiver (configure in `monitoring/prometheus/alertmanager.yml`).

---

## Exporter Configuration

The exporter reads from environment variables:

```env
STELLAR_RPC_URL=https://soroban-testnet.stellar.org
CONTRACT_QUORUM_PROOF=<your-contract-id>
SCRAPE_INTERVAL_SECONDS=15
EXPORTER_PORT=9101
```

---

## Adding Custom Metrics

1. Add a new metric definition in `monitoring/exporter/metrics.py`.
2. Subscribe to the relevant contract event topic (e.g. `CredentialIssued`).
3. Increment / observe the metric in the event handler.
4. Restart the exporter: `docker compose restart quorumproof-exporter`.
5. Add a panel to the relevant Grafana dashboard JSON.

---

## Troubleshooting

| Symptom | Likely Cause | Fix |
|---|---|---|
| No metrics in Prometheus | Exporter not running | `docker compose ps` — restart if stopped |
| Grafana shows "No data" | Wrong data source URL | Check Prometheus URL in Grafana data source settings |
| `ContractPaused` alert firing | Admin paused contract | Investigate reason; call `unpause` when safe |
| High error rate alert | RPC endpoint issues or contract bug | Check `error_code` label; switch RPC if needed |
