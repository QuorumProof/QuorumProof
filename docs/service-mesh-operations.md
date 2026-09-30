# Service Mesh Operations Guide

Issue #1660 — Implement Service Mesh for Observability

This guide covers the Istio service mesh deployment for QuorumProof:
installation, mTLS enforcement, traffic visualisation, and day-2 operations.

---

## Table of Contents

1. [Overview](#overview)
2. [Installation](#installation)
3. [mTLS Enforcement](#mtls-enforcement)
4. [Traffic Visualisation](#traffic-visualisation)
5. [Distributed Tracing](#distributed-tracing)
6. [Mesh Metrics](#mesh-metrics)
7. [Operations Runbook](#operations-runbook)
8. [Troubleshooting](#troubleshooting)

---

## Overview

QuorumProof uses **Istio** as its service mesh to provide:

| Capability | How it's configured |
|---|---|
| mTLS between all services | `PeerAuthentication` — STRICT mode (`k8s/istio-mesh.yaml`) |
| Traffic management (retries, timeouts) | `VirtualService` |
| Circuit breaking | `DestinationRule` outlierDetection |
| Prometheus metrics per service | `Telemetry` resource + Prometheus Adapter |
| Distributed tracing (Jaeger / Zipkin) | `Telemetry` tracing block |
| Structured access logs → Loki | Envoy access log provider |
| Traffic visualisation | Kiali dashboard |

All mesh configuration lives in `k8s/istio-mesh.yaml`.

---

## Installation

### 1. Install Istio

```bash
# Download istioctl (1.21+ recommended)
curl -L https://istio.io/downloadIstio | sh -
export PATH="$PWD/istio-*/bin:$PATH"

# Install with the default profile (includes Prometheus, Grafana, Kiali, Jaeger)
istioctl install --set profile=default -y

# Verify installation
istioctl verify-install
```

### 2. Enable sidecar injection for the quorumproof namespace

```bash
kubectl label namespace quorumproof istio-injection=enabled

# Restart the api-server so Istio injects the Envoy sidecar
kubectl -n quorumproof rollout restart deployment/quorumproof-api-server
```

### 3. Apply mesh configuration

```bash
kubectl apply -f k8s/istio-mesh.yaml
```

### 4. Verify sidecar injection

```bash
kubectl -n quorumproof get pods -o jsonpath='{range .items[*]}{.metadata.name}: {.spec.containers[*].name}{"\n"}{end}'
# Expected: api-server pod shows two containers (api-server + istio-proxy)
```

---

## mTLS Enforcement

The `PeerAuthentication` resource in `k8s/istio-mesh.yaml` sets mTLS to
`STRICT` for the entire `quorumproof` namespace. All pod-to-pod
communication must use workload certificates issued by Istio's internal CA
(Citadel / istiod).

### Verify mTLS is active

```bash
# Check TLS mode for api-server
istioctl authn tls-check quorumproof-api-server.quorumproof.svc.cluster.local

# Expected output:
# HOST:PORT                                          STATUS    SERVER     CLIENT     AUTHN POLICY  DESTINATION RULE
# quorumproof-api-server.quorumproof:80              OK        STRICT     ISTIO_MUTUAL  ...
```

### What mTLS protects

- Service-to-service communication within the cluster is encrypted and
  mutually authenticated — a compromised pod cannot impersonate another service.
- Workload certificates are rotated automatically by istiod (default: 24 h).
- Traffic from outside the mesh (ingress) terminates at the Ingress Gateway
  and is then re-encrypted inside the mesh.

### Certificate inspection

```bash
# View the workload certificate for an api-server pod
kubectl -n quorumproof exec -c istio-proxy \
  $(kubectl -n quorumproof get pod -l app=quorumproof-api-server -o jsonpath='{.items[0].metadata.name}') \
  -- openssl s_client -connect quorumproof-api-server:80 2>&1 | head -30
```

---

## Traffic Visualisation

### Kiali — Service mesh topology

Kiali provides a real-time graph of service-to-service traffic, request
success rates, and latency.

```bash
# Open Kiali dashboard
istioctl dashboard kiali
```

Navigate to Graph → Namespace: `quorumproof`. You should see:
- `quorumproof-api-server` as the central node
- Edges to `stellar-rpc-egress` (external Stellar RPC calls)
- Health icons (green = healthy, red = error rate elevated)

### Grafana — Istio dashboards

Istio ships pre-built Grafana dashboards:

```bash
istioctl dashboard grafana
```

Key dashboards:
- **Istio Mesh Dashboard** — global request volume, success rates, latencies
- **Istio Service Dashboard** — per-service breakdown
- **Istio Workload Dashboard** — per-pod metrics
- **Istio Performance Dashboard** — Envoy sidecar overhead

### Request routing

The `VirtualService` in `k8s/istio-mesh.yaml` applies different policies
per path:

| Path / Method | Timeout | Retries | Notes |
|---|---|---|---|
| `GET /api/credentials/*` | 10 s | 3 retries, 4 s per try | Safe to retry — read-only |
| All other routes | 30 s | None | POST/PUT are not retried (non-idempotent) |

---

## Distributed Tracing

The mesh automatically propagates `x-b3-traceid`, `x-b3-spanid`, and
`x-request-id` headers. The api-server reads and forwards these headers via
the distributed tracing middleware (`api-server/src/middleware/`).

### Access Jaeger

```bash
istioctl dashboard jaeger
```

Search by:
- `service: quorumproof-api-server`
- `operation: /api/credentials/verify-batch`
- Time range: last 15 minutes

Each trace shows the Envoy → api-server → Stellar RPC span tree, including
latency at each hop.

### Sampling rate

The `Telemetry` resource sets `randomSamplingPercentage: 100` for staging.
For production, reduce to 1–5 % to control trace volume:

```bash
kubectl -n quorumproof patch telemetry quorumproof-telemetry \
  --type merge \
  -p '{"spec":{"tracing":[{"providers":[{"name":"zipkin"}],"randomSamplingPercentage":5}]}}'
```

---

## Mesh Metrics

Istio's Envoy sidecar exports the following Prometheus metrics. These
complement the application-level metrics from `monitoring/exporter/`.

| Metric | Description |
|---|---|
| `istio_requests_total` | Total requests by source, destination, status code |
| `istio_request_duration_milliseconds` | Request latency histogram |
| `istio_request_bytes` | Request body size histogram |
| `istio_response_bytes` | Response body size histogram |
| `pilot_xds_pushes` | Control-plane config push count (health of istiod) |

### Example PromQL queries

```promql
# Request success rate for quorumproof-api-server (last 5 min)
sum(rate(istio_requests_total{destination_service="quorumproof-api-server.quorumproof.svc.cluster.local",response_code!~"5.."}[5m]))
  /
sum(rate(istio_requests_total{destination_service="quorumproof-api-server.quorumproof.svc.cluster.local"}[5m]))

# p95 request latency
histogram_quantile(0.95,
  sum by (le) (
    rate(istio_request_duration_milliseconds_bucket{destination_service=~"quorumproof.*"}[5m])
  )
)
```

---

## Operations Runbook

### Update mesh config

```bash
# Edit k8s/istio-mesh.yaml, then apply
kubectl apply -f k8s/istio-mesh.yaml

# Verify no validation errors
istioctl analyze -n quorumproof
```

### Disable mTLS temporarily (debug only)

```bash
kubectl -n quorumproof patch peerauthentication quorumproof-mtls \
  --type merge \
  -p '{"spec":{"mtls":{"mode":"PERMISSIVE"}}}'
# Re-enable:
kubectl -n quorumproof patch peerauthentication quorumproof-mtls \
  --type merge \
  -p '{"spec":{"mtls":{"mode":"STRICT"}}}'
```

### Upgrade Istio

```bash
istioctl upgrade --set profile=default
kubectl -n quorumproof rollout restart deployment/quorumproof-api-server
```

### Remove the mesh

```bash
kubectl delete -f k8s/istio-mesh.yaml
kubectl label namespace quorumproof istio-injection-
kubectl -n quorumproof rollout restart deployment/quorumproof-api-server
istioctl uninstall --purge
```

---

## Troubleshooting

### Pods stuck in `Init:0/1` after mesh install

The Istio sidecar init container failed. Check:

```bash
kubectl -n quorumproof describe pod <pod-name>
# Look for iptables errors in the istio-init container log
kubectl -n quorumproof logs <pod-name> -c istio-init
```

Common cause: the cluster node doesn't allow `NET_ADMIN` capability.
Solution: use Istio CNI plugin instead of the init container:
`istioctl install --set components.cni.enabled=true`

### mTLS check shows PERMISSIVE instead of STRICT

The `PeerAuthentication` was applied before sidecar injection was enabled.
Restart all pods in the namespace after applying the config.

### Kiali graph shows no traffic

Kiali queries Prometheus for Istio metrics. Ensure:
1. `monitoring/prometheus/prometheus.yml` scrapes the `istio-system` namespace.
2. Kiali is pointed at the correct Prometheus URL (set during Istio install).

### Circuit breaker ejecting too many pods

If `outlierDetection` is ejecting pods unexpectedly, check for downstream
Stellar RPC latency spikes. Adjust `baseEjectionTime` or
`consecutiveGatewayErrors` in the `DestinationRule` in `k8s/istio-mesh.yaml`.

### Access logs not appearing in Loki

Verify promtail is configured to scrape the Envoy access log path. The
access logs are written to stdout by default; confirm the promtail config in
`monitoring/loki/promtail.yml` targets the `quorumproof` namespace pods.
