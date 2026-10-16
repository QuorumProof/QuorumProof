# Automated Scaling Guide

Issue #1658 — Automated Scaling

This document covers the autoscaling policy for `quorumproof-api-server`,
the metrics that drive it, how to tune thresholds, and how to validate the
system under load.

---

## Table of Contents

1. [Overview](#overview)
2. [Architecture](#architecture)
3. [Autoscaling Policy](#autoscaling-policy)
4. [Metrics Pipeline](#metrics-pipeline)
5. [Threshold Tuning](#threshold-tuning)
6. [Load Testing](#load-testing)
7. [Operational Runbook](#operational-runbook)
8. [Troubleshooting](#troubleshooting)

---

## Overview

QuorumProof's API server handles two primary workload shapes:

- **Verification bursts** — a relying party integration issues thousands of
  `POST /api/credentials/verify-batch` calls in a short window. CPU and
  request-rate rise sharply.
- **Issuance backlog** — a university or licensing body batch-issues
  credentials. CPU is moderate but the search-index write path saturates
  memory.

Manual scaling cannot react fast enough to either pattern. The Kubernetes
Horizontal Pod Autoscaler (HPA) reacts to CPU utilisation and HTTP request
rate in near-real-time and keeps p95 API latency below the 500 ms SLO.

---

## Architecture

```
Prometheus  ──scrapes──►  quorumproof-exporter (metrics.py)
     │
     ▼
Prometheus Adapter  ──custom-metrics API──►  HPA
                                               │
                                    scales ▼
                             quorumproof-api-server (Deployment)
                               minReplicas: 2  maxReplicas: 10
```

Files:

| File | Purpose |
|---|---|
| `k8s/hpa.yaml` | HPA definition — thresholds, scale behaviours |
| `k8s/prometheus-adapter-config.yaml` | Bridges Prometheus series into k8s custom-metrics API |
| `scripts/scaling_load_test.sh` | Load driver + HPA validation script |

---

## Autoscaling Policy

### Scaling triggers (any one is sufficient to trigger scale-up)

| Metric | Type | Target | Rationale |
|---|---|---|---|
| CPU utilisation | Resource | 50 % average | Leaves headroom before the 500 m limit; avoids throttling during ZK-proof verification. |
| Memory utilisation | Resource | 70 % average | Prevents OOM kills during batch-verification bursts (search-index writes). |
| `quorumproof_http_requests_per_second` | Pods (custom) | 200 req/s per replica | Above this threshold the p95 latency breaches 500 ms (see §Threshold Tuning). |

### Scale-up behaviour

```yaml
scaleUp:
  stabilizationWindowSeconds: 60    # react within 60 s of sustained load
  policies:
    - type: Percent   value: 100    periodSeconds: 60   # double pod count per minute
    - type: Pods      value: 2      periodSeconds: 60   # always add ≥ 2 pods
  selectPolicy: Max
```

### Scale-down behaviour

```yaml
scaleDown:
  stabilizationWindowSeconds: 300   # don't scale down for 5 min after metric drops
  policies:
    - type: Percent   value: 20     periodSeconds: 60   # remove ≤ 20 % per minute
  selectPolicy: Min
```

The conservative scale-down prevents flapping during bursty credential
verification traffic where a relying party fires waves of requests with
short gaps.

---

## Metrics Pipeline

### Prometheus exporter metrics used

The following Prometheus counters/gauges are consumed by the HPA. They are
emitted by `monitoring/exporter/exporter.py` and `monitoring/exporter/metrics.py`.

| Prometheus metric | Kind | Description |
|---|---|---|
| `quorumproof_api_requests_total` | Counter | Total HTTP requests received. Used to derive per-pod request rate via Prometheus Adapter recording rule `rate(...[2m])`. |
| `quorumproof_api_errors_total` | Counter | Total error responses. Not used by HPA directly but exposed as `quorumproof_error_rate_per_second` for dashboards. |
| `quorumproof_pending_attestations` | Gauge | Queued attestation requests. Available as a custom metric for queue-depth-based scaling if needed. |

### Prometheus Adapter recording rule

The adapter config in `k8s/prometheus-adapter-config.yaml` registers:

```
quorumproof_http_requests_per_second
  = rate(quorumproof_api_requests_total{namespace, pod}[2m])
```

Verify the metric is visible in the custom-metrics API:

```bash
kubectl get --raw /apis/custom.metrics.k8s.io/v1beta1/namespaces/quorumproof/pods/*/quorumproof_http_requests_per_second | jq .
```

---

## Threshold Tuning

Thresholds were derived from load tests run against a single replica with
`scripts/scaling_load_test.sh` and `api-server/loadtest/credentialLoadTest.ts`.

### Methodology

1. Run `LOAD_RPS=50 LOAD_DURATION=120 ./scripts/scaling_load_test.sh --dry-run`
   to verify config, then increase `LOAD_RPS` in steps of 50.
2. Record p95 latency from Grafana → API Latency dashboard for each step.
3. The threshold is the RPS where p95 first exceeds 500 ms.

### Results (single replica, `requests.cpu: 100m`, `memory: 256Mi`)

| RPS per replica | CPU util | p95 latency | Status |
|---|---|---|---|
| 100 | ~20 % | 120 ms | ✅ within SLO |
| 150 | ~35 % | 220 ms | ✅ within SLO |
| 200 | ~48 % | 430 ms | ⚠️ near threshold |
| 250 | ~60 % | 680 ms | ❌ breaches SLO |

→ **CPU target 50 %** and **request-rate target 200 req/s** were chosen as
the scale-up triggers. Both thresholds allow some headroom before SLO
breach, and the HPA's 60 s scale-up window means a new replica is usually
ready before p95 hits 500 ms.

### Re-tuning after a resource change

If you change the pod's CPU/memory requests or the application's profile
(e.g. enabling in-process ZK verification), re-run the load test at each
RPS step and update the targets in `k8s/hpa.yaml`.

---

## Load Testing

### Quick run (against local api-server)

```bash
# Start the api-server locally
cd api-server && npm run dev &

# Run the load test (dry-run to validate prerequisites)
./scripts/scaling_load_test.sh --dry-run

# Real run: 500 req/s for 120 s
LOAD_RPS=500 LOAD_DURATION=120 API_URL=http://localhost:3001 \
  ./scripts/scaling_load_test.sh
```

### Against a Kubernetes cluster

```bash
# Port-forward the service
kubectl -n quorumproof port-forward svc/quorumproof-api-server 8080:80 &

# Run the HPA validation
NAMESPACE=quorumproof API_URL=http://localhost:8080 \
  LOAD_RPS=600 LOAD_DURATION=180 \
  ./scripts/scaling_load_test.sh
```

### Credential-specific load test

For a more realistic load pattern (issuance + verification):

```bash
cd api-server
LOAD_ISSUE_COUNT=2000 LOAD_VERIFY_COUNT=20000 LOAD_RPC_LATENCY_MS=80 \
  npm run loadtest:credentials
```

---

## Operational Runbook

### Manually override replica count

```bash
# Scale to 5 replicas immediately (bypasses HPA temporarily)
kubectl -n quorumproof scale deployment quorumproof-api-server --replicas=5

# After the incident, re-enable HPA control by restoring min/max:
kubectl -n quorumproof patch hpa quorumproof-api-server \
  -p '{"spec":{"minReplicas":2,"maxReplicas":10}}'
```

### Disable autoscaling temporarily

```bash
kubectl -n quorumproof delete hpa quorumproof-api-server
# Re-enable:
kubectl apply -f k8s/hpa.yaml
```

### Raise the max replicas for a planned event

```bash
kubectl -n quorumproof patch hpa quorumproof-api-server \
  -p '{"spec":{"maxReplicas":20}}'
# Revert after the event:
kubectl -n quorumproof patch hpa quorumproof-api-server \
  -p '{"spec":{"maxReplicas":10}}'
```

### Check HPA status

```bash
kubectl -n quorumproof describe hpa quorumproof-api-server
```

Key fields to check:
- `Conditions` — `AbleToScale: True`, `ScalingActive: True`
- `Events` — any recent scale events with reasons
- `Current/Desired Replicas` — should converge within 2 min of a load change

---

## Troubleshooting

### HPA shows `<unknown>` for custom metrics

The Prometheus Adapter is not running or not configured correctly.

```bash
# Check adapter pods
kubectl -n monitoring get pods -l app=prometheus-adapter

# Check adapter logs
kubectl -n monitoring logs -l app=prometheus-adapter --tail=50

# Verify the metric is registered
kubectl get --raw /apis/custom.metrics.k8s.io/v1beta1 | jq '.resources[].name'
```

### HPA is not scaling up under load

1. Check that the Prometheus exporter is scraping correctly:
   `curl http://localhost:3001/metrics/events | grep quorumproof_api_requests_total`
2. Confirm the Prometheus Adapter config matches the metric labels in your
   cluster (namespace and pod label names must align).
3. Ensure `metrics-server` is installed and healthy:
   `kubectl -n kube-system get pods -l k8s-app=metrics-server`

### Pods crash-loop during scale-up

The `initialDelaySeconds` on the liveness probe (15 s) should cover Node.js
startup + DB migrations. If pods crash before they pass the probe, increase
`initialDelaySeconds` in `k8s/api-server-deployment.yaml` and re-apply.

### Scale-down never happens

The `stabilizationWindowSeconds: 300` intentionally delays scale-down. If
metrics remain elevated (e.g. a memory leak) the HPA will not scale down.
Check Grafana → API Latency and CPU dashboards for sustained utilisation.
