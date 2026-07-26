# QuorumProof Observability Stack Setup Guide

## Overview

This guide provides comprehensive instructions for operators to set up logging, metrics, and distributed tracing for QuorumProof. The observability stack consists of:

- **Prometheus** — Metrics collection and time-series database
- **Grafana** — Metrics visualization and dashboards
- **Loki** — Log aggregation and querying
- **Promtail** — Log forwarder to Loki
- **Jaeger** — Distributed tracing (optional, for advanced tracing)
- **AlertManager** — Alert routing and notification

---

## Table of Contents

1. [Prerequisites](#prerequisites)
2. [Quick Start](#quick-start)
3. [Detailed Configuration](#detailed-configuration)
4. [Key Metrics](#key-metrics)
5. [Logging](#logging)
6. [Alerting](#alerting)
7. [Distributed Tracing](#distributed-tracing)
8. [Dashboard Setup](#dashboard-setup)
9. [Troubleshooting](#troubleshooting)
10. [Production Deployment](#production-deployment)

---

## Prerequisites

- Docker and Docker Compose (v1.29+)
- Kubernetes 1.20+ (for Kubernetes deployments)
- 4+ GB RAM available
- 20 GB disk space (for metrics and logs storage)
- Network access to Stellar RPC endpoint

---

## Quick Start

### 1. Start the Observability Stack

```bash
cd monitoring
docker-compose up -d
```

This starts the complete observability stack:

```
Container Port Purpose
────────────────────────────────────────────────────────────
prometheus 9090 Metrics DB & scraper
grafana    3000 Visualization (admin/admin)
loki       3100 Log aggregation
promtail   —    Log shipper
alertmanager 9093 Alert routing
exporter   9101 QuorumProof metrics
```

### 2. Access Services

- **Grafana:** http://localhost:3000 (default: admin/admin)
- **Prometheus:** http://localhost:9090
- **AlertManager:** http://localhost:9093
- **Loki:** http://localhost:3100

### 3. Verify Metrics Collection

```bash
curl http://localhost:9101/metrics
```

You should see metrics like:
```
# HELP quorumproof_credentials_total Total credentials issued
quorumproof_credentials_total 125
```

---

## Detailed Configuration

### Prometheus Configuration

**File:** `monitoring/prometheus/prometheus.yml`

```yaml
global:
  scrape_interval: 15s
  evaluation_interval: 15s
  external_labels:
    monitor: 'quorumproof'

scrape_configs:
  - job_name: 'quorumproof'
    static_configs:
      - targets: ['exporter:9101']
    scrape_interval: 15s

  - job_name: 'prometheus'
    static_configs:
      - targets: ['localhost:9090']

rule_files:
  - /etc/prometheus/alerts.yml
```

**Key Configuration Parameters:**

| Parameter | Default | Description |
|-----------|---------|-------------|
| `scrape_interval` | 15s | How often to collect metrics |
| `evaluation_interval` | 15s | How often to evaluate alert rules |
| `retention.time` | 30d | How long to retain metrics data |

**To modify scrape interval (for high-frequency monitoring):**

```yaml
global:
  scrape_interval: 5s  # More frequent collection
```

### Loki Configuration

**File:** `monitoring/loki/loki.yml`

```yaml
auth_enabled: false

ingester:
  chunk_idle_period: 3m
  max_chunk_age: 1h
  max_streams_per_user: 10000

storage_config:
  filesystem:
    directory: /loki/chunks

limits_config:
  ingestion_rate_mb: 16
  ingestion_burst_size_mb: 20
```

### Promtail Configuration

**File:** `monitoring/loki/promtail.yml`

Promtail forwards application logs to Loki:

```yaml
clients:
  - url: http://loki:3100/loki/api/v1/push

scrape_configs:
  - job_name: system
    static_configs:
      - targets:
          - localhost
        labels:
          job: syslog
          __path__: /var/log/**/*.log
```

**To add custom application logs:**

```yaml
scrape_configs:
  - job_name: quorumproof-app
    static_configs:
      - targets:
          - localhost
        labels:
          job: app
          __path__: /var/log/quorumproof/*.log
```

---

## Key Metrics

### Credential Metrics

| Metric | Type | Description |
|--------|------|-------------|
| `quorumproof_credentials_total` | Counter | Total credentials issued |
| `quorumproof_credentials_revoked` | Counter | Total credentials revoked |
| `quorumproof_credentials_verified` | Counter | Total credential verifications |
| `quorumproof_credential_issuance_duration_seconds` | Histogram | Time to issue credential |

### Quorum Metrics

| Metric | Type | Description |
|--------|------|-------------|
| `quorumproof_quorum_slices_total` | Gauge | Active quorum slices |
| `quorumproof_attestations_received` | Counter | Total attestations |
| `quorumproof_consensus_lag_seconds` | Gauge | Lag in consensus |

### Smart Contract Metrics

| Metric | Type | Description |
|--------|------|-------------|
| `quorumproof_contract_calls_total` | Counter | Total contract invocations |
| `quorumproof_contract_storage_bytes` | Gauge | Contract storage usage |
| `quorumproof_contract_execution_duration_ms` | Histogram | Contract execution time |

### System Metrics

| Metric | Type | Description |
|--------|------|-------------|
| `quorumproof_api_requests_total` | Counter | API request count by endpoint |
| `quorumproof_api_duration_seconds` | Histogram | API response time |
| `quorumproof_api_errors_total` | Counter | API errors by type |

---

## Logging

### Log Levels

Configure logging verbosity via environment variables:

```bash
# Application environment
export LOG_LEVEL=info  # debug, info, warn, error
export LOG_FORMAT=json  # json, text
```

### Log Shipping

Logs are automatically shipped to Loki via Promtail. To access logs:

**Via Grafana:**
1. Open Grafana → Explore
2. Select "Loki" datasource
3. Enter a query:

```logql
{job="syslog"} | json
```

**Common log queries:**

```logql
# All credential issuance errors
{job="app"} | json | operation="issue_credential" | level="error"

# Search for a specific credential ID
{job="app"} | json | credential_id="cred_abc123"

# Slow operations (> 1 second)
{job="app"} | json | duration_ms > 1000
```

### Application Logging Integration

To instrument your application with proper logging:

```rust
// In your Rust code
use log::{info, warn, error};

info!("Credential issued: credential_id={}", credential_id);
warn!("Rate limit approaching for issuer={}", issuer_id);
error!("Contract call failed: {:?}", error);
```

---

## Alerting

### Alert Rules

**File:** `monitoring/prometheus/alerts.yml`

Common alert rules:

```yaml
groups:
  - name: quorumproof
    interval: 30s
    rules:
      - alert: HighErrorRate
        expr: rate(quorumproof_api_errors_total[5m]) > 0.05
        for: 5m
        annotations:
          summary: "High error rate ({{ $value | humanizePercentage }})"

      - alert: SlowContractExecution
        expr: histogram_quantile(0.99, quorumproof_contract_execution_duration_ms) > 5000
        for: 10m
        annotations:
          summary: "Slow contract execution (p99: {{ $value }}ms)"

      - alert: StorageAlmostFull
        expr: quorumproof_contract_storage_bytes / quorumproof_contract_storage_limit > 0.8
        for: 5m
        annotations:
          summary: "Contract storage {{ $value | humanizePercentage }} full"
```

### Configuring Notifications

**AlertManager Configuration:** `monitoring/prometheus/alertmanager.yml`

```yaml
global:
  resolve_timeout: 5m

route:
  group_by: ['alertname', 'cluster']
  group_wait: 10s
  group_interval: 10s
  repeat_interval: 24h
  receiver: 'default'

receivers:
  - name: 'default'
    webhook_configs:
      - url: 'http://alertmanager-webhook:5001/'

  - name: 'slack'
    slack_configs:
      - api_url: 'YOUR_SLACK_WEBHOOK_URL'
        channel: '#alerts'
        title: 'QuorumProof Alert'
```

**To send alerts to Slack:**

1. Create a Slack webhook: https://api.slack.com/messaging/webhooks
2. Update `alertmanager.yml`:

```yaml
receivers:
  - name: 'slack'
    slack_configs:
      - api_url: 'https://hooks.slack.com/services/YOUR/WEBHOOK/URL'
        channel: '#quorumproof-alerts'
```

3. Restart AlertManager:

```bash
docker-compose restart alertmanager
```

---

## Distributed Tracing

### Optional: Enable Jaeger Tracing

For advanced performance analysis, integrate Jaeger:

1. **Add Jaeger to docker-compose:**

```yaml
jaeger:
  image: jaegertracing/all-in-one:latest
  ports:
    - "16686:16686"
    - "14250:14250"
  environment:
    COLLECTOR_ZIPKIN_HOST_PORT: ":9411"
```

2. **Instrument application:**

```rust
use opentelemetry_jaeger::new_pipeline;
use tracing_opentelemetry::OpenTelemetryLayer;

let tracer = new_pipeline()
    .install_simple()
    .expect("Failed to initialize tracer");

// Now use spans in your code
let span = tracing::span!(tracing::Level::INFO, "issue_credential");
```

3. **Access traces:** http://localhost:16686

---

## Dashboard Setup

### Pre-configured Dashboards

Grafana comes with pre-built dashboards in `monitoring/grafana/dashboards/`:

**To add a custom dashboard:**

1. Open Grafana → Dashboards → Create Dashboard
2. Add panels with queries:

```
# Credentials issued per hour
rate(quorumproof_credentials_total[1h])

# API response time p95
histogram_quantile(0.95, quorumproof_api_duration_seconds)

# Quorum consensus lag
quorumproof_consensus_lag_seconds
```

3. Save the dashboard as JSON in `monitoring/grafana/dashboards/`

### Example Panel: Credential Issuance Rate

```json
{
  "title": "Credentials Issued (per minute)",
  "targets": [
    {
      "expr": "rate(quorumproof_credentials_total[1m])",
      "refId": "A"
    }
  ],
  "type": "graph"
}
```

---

## Troubleshooting

### Issue: No metrics appearing in Prometheus

**Solution:**
1. Verify exporter is running: `docker ps | grep exporter`
2. Check exporter logs: `docker logs monitoring_quorumproof-exporter_1`
3. Verify connectivity: `curl http://exporter:9101/metrics`

### Issue: Logs not appearing in Loki

**Solution:**
1. Check Promtail logs: `docker logs monitoring_promtail_1`
2. Verify log file paths exist and are readable
3. Check Loki configuration: `docker exec monitoring_loki_1 cat /etc/loki/loki.yml`

### Issue: High memory usage

**Solution:**
1. Reduce retention time in Prometheus:
   ```bash
   --storage.tsdb.retention.time=7d  # Default 30d
   ```

2. Limit Loki ingestion:
   ```yaml
   limits_config:
     ingestion_rate_mb: 8  # Reduce from 16
   ```

### Issue: Slow Grafana dashboards

**Solution:**
1. Reduce graph time window (e.g., last 1 hour instead of last 7 days)
2. Increase Prometheus evaluation interval to 30s
3. Add rate limiting to queries

---

## Production Deployment

### Kubernetes Deployment

For production Kubernetes environments, use Helm charts:

```bash
# Install Prometheus stack
helm repo add prometheus-community https://prometheus-community.github.io/helm-charts
helm install prometheus prometheus-community/kube-prometheus-stack -n monitoring --create-namespace

# Install Loki stack
helm repo add grafana https://grafana.github.io/helm-charts
helm install loki grafana/loki-stack -n monitoring
```

### Environment Variables

```bash
# monitoring/.env.production
STELLAR_RPC_URL=https://soroban-mainnet.stellar.org
CONTRACT_QUORUM_PROOF=CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4
SCRAPE_INTERVAL_SECONDS=30
PROMETHEUS_RETENTION_DAYS=90
LOKI_RETENTION_DAYS=30
LOG_LEVEL=warn
```

### Data Backup

```bash
# Backup Prometheus data
docker exec monitoring_prometheus_1 tar czf /prometheus-backup.tar.gz /prometheus/

# Backup Grafana dashboards
docker exec monitoring_grafana_1 grafana-cli admin export-dashboard

# Backup Loki logs
docker exec monitoring_loki_1 tar czf /loki-backup.tar.gz /loki/
```

### High Availability

For HA Prometheus:

```yaml
# Use Thanos for long-term storage
global:
  external_labels:
    cluster: 'us-east-1'

storage_config:
  s3:
    bucket: 'quorumproof-metrics'
    endpoint: 's3.amazonaws.com'
```

---

## Maintenance

### Regular Tasks

| Task | Frequency | Command |
|------|-----------|---------|
| Update container images | Monthly | `docker-compose pull && docker-compose up -d` |
| Prune old data | Quarterly | `docker system prune --volumes` |
| Rotate logs | Weekly | `logrotate /etc/logrotate.d/quorumproof` |
| Review alert rules | Monthly | Review `alerts.yml` |

### Health Checks

```bash
# Check all services are running
docker-compose ps

# Test Prometheus
curl -s http://localhost:9090/-/healthy

# Test Grafana
curl -s http://localhost:3000/api/health

# Test Loki
curl -s http://localhost:3100/ready
```

---

## Support & Resources

- **Prometheus Docs:** https://prometheus.io/docs/
- **Grafana Docs:** https://grafana.com/docs/
- **Loki Docs:** https://grafana.com/docs/loki/
- **QuorumProof GitHub:** https://github.com/QuorumProof/QuorumProof
- **Issues & Support:** https://github.com/QuorumProof/QuorumProof/issues
