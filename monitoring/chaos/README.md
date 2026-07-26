# Chaos Mesh manifests

Issue #1003. See [`docs/resilience.md`](../../docs/resilience.md) for the
full resilience requirements these exercise, and
[`api-server/tests/chaos.test.ts`](../../api-server/tests/chaos.test.ts) for
the CI-runnable, no-cluster-required counterpart to these manifests.

## Prerequisites

- A Kubernetes cluster with [Chaos Mesh](https://chaos-mesh.org/docs/quick-start/)
  installed.
- An `api-server` Deployment running in the `quorumproof` namespace, labeled
  `app: quorumproof-api-server`. The repo does not currently ship Kubernetes
  Deployment manifests for `api-server` (only `monitoring/docker-compose.yml`
  for local Prometheus/Grafana/Loki) — adapt the `namespace`/`labelSelectors`
  in these manifests to match however `api-server` is actually deployed in
  your cluster.

## Manifests

| File | Failure class | What it does |
| --- | --- | --- |
| `network-delay.yaml` | Network delay | Adds 500ms±200ms latency to api-server's outbound traffic. |
| `packet-loss.yaml` | Packet loss | Drops 15% of api-server's outbound packets. |
| `service-unavailable.yaml` | Service unavailability | Kills an api-server pod outright for 2 minutes. |

Each is scheduled (`spec.scheduler.cron`) to run periodically and
self-terminate after `spec.duration` — safe to leave applied in a staging
cluster for ongoing resilience verification rather than a one-off manual run.

## Usage

```bash
# Apply one experiment
kubectl apply -f network-delay.yaml

# Watch it take effect
kubectl get networkchaos api-server-network-delay -o yaml

# Run your smoke tests / synthetic traffic against api-server while it's active

# Remove it
kubectl delete -f network-delay.yaml
```

## Smoke-testing during an active experiment

While an experiment is applied, hit the health and search endpoints to
confirm the service stays up and responds per `docs/resilience.md`'s
requirements table:

```bash
curl -f https://<api-server-host>/health
curl -f https://<api-server-host>/api/credentials/search?limit=1
```

A failing `curl -f` (non-2xx) during `network-delay`/`packet-loss` is
expected to be rare/transient, not sustained — sustained failure indicates a
resilience gap. During `service-unavailable`, expect the health check to
fail only while the killed pod is being replaced (verify via
`kubectl get pods -n quorumproof -l app=quorumproof-api-server -w`), and to
recover automatically once the replacement pod is ready.
