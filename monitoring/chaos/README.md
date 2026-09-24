# Chaos Mesh manifests

Issue #1003. See [`docs/resilience.md`](../../docs/resilience.md) for the
full resilience requirements these exercise, and
[`api-server/tests/chaos.test.ts`](../../api-server/tests/chaos.test.ts) for
the CI-runnable, no-cluster-required counterpart to these manifests.

## Prerequisites

- A Kubernetes cluster with [Chaos Mesh](https://chaos-mesh.org/docs/quick-start/)
  installed.
- The `quorumproof` namespace with an `api-server` Deployment labeled
  `app: quorumproof-api-server`. A canonical Deployment + Service manifest is
  shipped at **[k8s/api-server-deployment.yaml](../../k8s/api-server-deployment.yaml)**
  (issue #1482). Apply it before running any Chaos Mesh experiments:

  ```bash
  # 1. Create the namespace
  kubectl create namespace quorumproof

  # 2. Create required Secrets (see k8s/api-server-deployment.yaml header for the full list)
  kubectl -n quorumproof create secret generic quorumproof-api-server-env \
    --from-literal=STELLAR_RPC_URL=https://soroban-testnet.stellar.org \
    --from-literal=CONTRACT_QUORUM_PROOF=<contract-id> \
    # ... (other vars)

  # 3. Deploy api-server
  kubectl apply -f k8s/api-server-deployment.yaml

  # 4. Wait for the Deployment to be ready
  kubectl -n quorumproof rollout status deployment/quorumproof-api-server

  # 5. Now apply chaos experiments — they will find the labeled pods immediately
  kubectl apply -f monitoring/chaos/network-delay.yaml
  ```

  If you are running a custom Deployment (different namespace or label scheme),
  update the `namespace` and `labelSelectors` fields in the YAML files below to
  match your setup.

## Manifests

| File | Target component | Failure class | Expected / allowed blast radius |
| --- | --- | --- | --- |
| `network-delay.yaml` | `api-server` | Network delay | Adds 500ms±200ms latency to api-server's outbound traffic. Requests complete correctly (no state corruption); only latency increases. |
| `packet-loss.yaml` | `api-server` | Packet loss | Drops 15% of api-server's outbound packets. A single dropped call degrades to a scoped error; the process never crashes and unrelated batch items are unaffected. |
| `service-unavailable.yaml` | `api-server` | Pod failure | Kills one api-server pod for 2 minutes. The surviving replica continues to serve traffic; aggregate endpoints return well-formed (possibly empty) responses. |
| `rpc-latency.yaml` | `quorumproof-exporter`, `migration-orchestrator` | Soroban RPC latency | Adds 2000ms±500ms latency to outbound calls from the exporter and orchestrator pods toward the Soroban RPC URL. The exporter must continue to publish metrics (with delayed values); the orchestrator must not corrupt on-chain migration state. |
| `exporter-pod-kill.yaml` | `quorumproof-exporter` | Pod kill mid-scrape | Kills the exporter pod once per hour to verify Prometheus handles scrape gaps cleanly. `MigrationStalled`/`APIDown` alerts must **not** fire on a single missed scrape; they fire only once the gap exceeds the `for:` duration in `alerts.yml`. The pod restarts automatically and resumes exporting within two scrape intervals. |

Each is scheduled (`spec.scheduler.cron`) to run periodically and
self-terminate after `spec.duration` — safe to leave applied in a staging
cluster for ongoing resilience verification rather than a one-off manual run.

### Label requirements for `rpc-latency.yaml` and `exporter-pod-kill.yaml`

The two new manifests (issue #1488) target pods by their
`app.kubernetes.io/component: monitoring` and `app: quorumproof-exporter`
labels respectively.  Ensure your exporter Deployment carries these labels:

```yaml
metadata:
  labels:
    app: quorumproof-exporter
    app.kubernetes.io/component: monitoring
```

If you run the migration orchestrator as a Kubernetes Job or CronJob rather
than a bare pod, add the same `app.kubernetes.io/component: monitoring` label
to its pod template so `rpc-latency.yaml` also covers it.

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

## End-to-end smoke test: `k8s/` + chaos manifests together

The following sequence confirms that `k8s/api-server-deployment.yaml` and the
three chaos manifests work together end-to-end on a fresh cluster. Run it
against a staging cluster before enabling the scheduled experiments:

```bash
# 1. Deploy api-server
kubectl apply -f k8s/api-server-deployment.yaml
kubectl -n quorumproof rollout status deployment/quorumproof-api-server --timeout=120s

# 2. Confirm /health before any chaos
API_HOST=$(kubectl -n quorumproof get svc quorumproof-api-server -o jsonpath='{.spec.clusterIP}')
curl -sf http://${API_HOST}/health | jq .

# 3. Network delay — api-server must still respond, just slower
kubectl apply -f monitoring/chaos/network-delay.yaml
sleep 5
time curl -sf http://${API_HOST}/health   # expect ~500ms added latency, still 200
kubectl delete -f monitoring/chaos/network-delay.yaml

# 4. Packet loss — api-server must still respond without hanging
kubectl apply -f monitoring/chaos/packet-loss.yaml
sleep 5
curl -sf http://${API_HOST}/health        # may retry internally, should still 200
kubectl delete -f monitoring/chaos/packet-loss.yaml

# 5. Pod failure — exactly one pod is killed; the other (replicas: 2) keeps serving
kubectl apply -f monitoring/chaos/service-unavailable.yaml
kubectl -n quorumproof get pods -l app=quorumproof-api-server -w &
WATCH_PID=$!
sleep 10
curl -sf http://${API_HOST}/health        # should succeed via the surviving replica
wait $WATCH_PID 2>/dev/null || true
kubectl delete -f monitoring/chaos/service-unavailable.yaml

# 6. Confirm full recovery
kubectl -n quorumproof rollout status deployment/quorumproof-api-server --timeout=60s
curl -sf http://${API_HOST}/health | jq .
echo "Smoke test passed"
```

> **CI note**: The in-process chaos tests in
> `api-server/tests/chaos.test.ts` cover the same failure classes without a
> real Kubernetes cluster (using mocked RPC clients). The script above is
> intended for pre-production cluster validation, not for CI.
