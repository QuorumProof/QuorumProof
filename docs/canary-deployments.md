# Canary Deployments

**Issue #1654** — Deployments are all-or-nothing. This document describes the
QuorumProof canary deployment architecture for the Kubernetes API server, how
traffic is shifted incrementally, how promotion/rollback decisions are made, and
what triggers an automatic rollback.

## Overview

QuorumProof supports **two independent canary deployment strategies**:

| Layer | Mechanism | Script | Docs |
|-------|-----------|--------|------|
| **Soroban smart contracts** | Upload new WASM to 10% of RPC endpoints; soak; upgrade contract | `scripts/canary_deploy.sh` | `docs/blue-green-deployment.md` |
| **Kubernetes API server** | Add a canary Deployment alongside stable; weight by replica count | `scripts/canary_k8s.sh` | This document |

Both strategies follow the same principle: send a small fraction of real traffic
to the new version, measure error rate + latency, then either promote or roll back.

---

## Kubernetes Canary Architecture

Traffic splitting uses **weighted replica counts** — no Ingress annotation or
service mesh required. The main `quorumproof-api-server` Service selects all pods
with `app: quorumproof-api-server` regardless of the `track` label, so kube-proxy
distributes requests across stable and canary pods proportionally.

```
                        ┌─────────────────────────────────────┐
                        │  Service: quorumproof-api-server    │
                        │  selector: app=quorumproof-api-server │
                        └──────────────┬──────────────────────┘
                                       │ round-robin
              ┌────────────────────────┴─────────────────────┐
              │ (9 pods)                                      │ (1 pod)
    ┌─────────▼──────────┐                        ┌──────────▼──────────┐
    │  Deployment:       │                        │  Deployment:        │
    │  quorumproof-api-  │                        │  quorumproof-api-   │
    │  server (stable)   │                        │  server-canary      │
    │  image: v1.1.0     │                        │  image: v1.2.0      │
    │  replicas: 9       │                        │  replicas: 1 (10%)  │
    └────────────────────┘                        └─────────────────────┘
```

### Traffic percentages by replica count

| Stable replicas | Canary replicas | Canary % |
|----------------|-----------------|----------|
| 9 | 1 | ~10% |
| 3 | 1 | ~25% |
| 1 | 1 | ~50% |

---

## Quick Start

```bash
# 1. Deploy canary at 10% traffic
./scripts/canary_k8s.sh deploy \
  --image quorumproof/api-server:v1.2.0 \
  --pct 10

# 2. Monitor for 5 minutes (auto-rollback on breach)
./scripts/canary_k8s.sh monitor \
  --soak 300 \
  --error-threshold 0.05 \
  --p95-ms 2000

# 3a. Promote if healthy
./scripts/canary_k8s.sh promote

# 3b. Or rollback manually at any point
./scripts/canary_k8s.sh rollback

# Check current state at any time
./scripts/canary_k8s.sh status
```

---

## Deployment Workflow

### Step 1: Deploy canary

```bash
./scripts/canary_k8s.sh deploy --image quorumproof/api-server:v1.2.0 --pct 10
```

This:
1. Applies `k8s/canary/` manifests (creates `quorumproof-api-server-canary` Deployment)
2. Sets the canary image via `kubectl set image`
3. Scales the canary to achieve the requested traffic percentage
4. Waits for pods to pass readiness probes

### Step 2: Validate canary-only traffic

Before exposing to general traffic, validate via the canary-direct Service:

```bash
kubectl port-forward -n quorumproof \
  $(kubectl get pod -n quorumproof -l track=canary -o name | head -1) \
  8080:3001

curl http://localhost:8080/health/ready
curl http://localhost:8080/api/credentials
```

### Step 3: Monitor metrics

```bash
./scripts/canary_k8s.sh monitor --soak 300
```

During the soak period the script polls Prometheus every 15 seconds for:

| Metric | Threshold | Default |
|--------|-----------|---------|
| Error rate | `< error_threshold` | 5% |
| p95 latency | `< p95_ms` | 2000ms |
| Pod restarts | `< 3` | — |

If any threshold is breached, the canary is rolled back automatically.

### Step 4: Promote or rollback

```bash
# Promote: rolls stable to the canary image, then deletes the canary
./scripts/canary_k8s.sh promote

# Rollback: deletes the canary Deployment, restoring 100% stable traffic
./scripts/canary_k8s.sh rollback
```

---

## Rollback Triggers

Automatic rollback (during `monitor`) fires when:

| Condition | Threshold |
|-----------|-----------|
| Error rate exceeds threshold | `> 0.05` (configurable) |
| p95 latency exceeds threshold | `> 2000ms` (configurable) |
| Pod restart count too high | `> 3` restarts |

Manual rollback at any time:

```bash
./scripts/canary_k8s.sh rollback
```

Emergency rollback without the script:

```bash
kubectl delete deployment quorumproof-api-server-canary -n quorumproof
# Stable continues serving 100% of traffic immediately
```

---

## Prometheus Metrics for Canary Monitoring

The canary pods expose a `track=canary` label via the `DEPLOYMENT_TRACK`
environment variable and the `deployment.kubernetes.io/track: canary` pod
annotation (scraped by Prometheus).

Useful PromQL queries:

```promql
# Error rate: canary vs stable
rate(quorumproof_api_errors_total{track="canary"}[1m])
rate(quorumproof_api_errors_total{track="stable"}[1m])

# p95 latency comparison
histogram_quantile(0.95,
  rate(quorumproof_contract_invocation_duration_seconds_bucket{track="canary"}[1m]))

# Pod restarts for canary
sum(kube_pod_container_status_restarts_total{
  namespace="quorumproof",
  pod=~"quorumproof-api-server-canary-.*"
})

# Traffic split (request rate by track)
sum by (track) (rate(quorumproof_http_requests_total[1m]))
```

---

## GitHub Actions Integration

A canary deployment GitHub Actions workflow is available at
`.github/workflows/canary-deploy.yml` (originally for Soroban contracts).
For Kubernetes canary deployments, extend the existing workflow or create
a separate one:

```yaml
# .github/workflows/k8s-canary.yml
- name: Deploy Kubernetes canary
  run: |
    chmod +x scripts/canary_k8s.sh
    NAMESPACE=quorumproof \
    PROMETHEUS_URL=${{ vars.PROMETHEUS_URL }} \
    NOTIFY_WEBHOOK=${{ secrets.NOTIFY_WEBHOOK }} \
    ./scripts/canary_k8s.sh deploy \
      --image "quorumproof/api-server:${{ github.sha }}" \
      --pct 10

- name: Monitor canary
  run: |
    ./scripts/canary_k8s.sh monitor \
      --soak 300 \
      --error-threshold 0.05 \
      --p95-ms 2000

- name: Promote on success
  if: success()
  run: ./scripts/canary_k8s.sh promote

- name: Rollback on failure
  if: failure()
  run: ./scripts/canary_k8s.sh rollback
```

---

## Relationship to Blue-Green Deployments

Blue-green and canary are complementary strategies:

| | Blue-Green | Canary |
|-|-----------|--------|
| Traffic split | 0% / 100% switch | Gradual (10% → 100%) |
| Risk | Binary (instant switch) | Lower (incremental exposure) |
| Rollback time | Instant (patch selector) | Instant (delete canary) |
| Best for | Schema migrations, major versions | Feature releases, risky changes |
| Manifests | `k8s/blue-green/` | `k8s/canary/` |

Use canary for normal releases, blue-green for zero-downtime schema changes.

---

## See Also

- [`k8s/canary/`](../k8s/canary/) — Kubernetes manifests
- [`scripts/canary_k8s.sh`](../scripts/canary_k8s.sh) — Kubernetes canary script
- [`scripts/canary_deploy.sh`](../scripts/canary_deploy.sh) — Soroban contract canary script
- [`docs/blue-green-deployment.md`](blue-green-deployment.md) — blue-green strategy guide
- [`k8s/blue-green/`](../k8s/blue-green/) — blue-green manifests
