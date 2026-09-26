# Blue-Green Deployment

> Issue #1648. Zero-downtime releases of the api-server on Kubernetes.
> Contract (WASM) upgrades follow a different path — see
> [contract-upgrade-guide.md](./contract-upgrade-guide.md) and the canary
> pipeline in `scripts/canary_deploy.sh`.

## Why

The single `quorumproof-api-server` Deployment in
`k8s/api-server-deployment.yaml` upgrades in place. A bad image, a failed
startup migration, or a config mismatch takes live pods down with it, and
recovery means another full rollout. Blue-green keeps the previous release
running and Ready alongside the new one, so switching — and switching back —
is a single Service selector change.

---

## Infrastructure

Manifests live in [`k8s/blue-green/`](../k8s/blue-green/):

| File | Purpose |
|---|---|
| `deployment-blue.yaml` | `quorumproof-api-server-blue` — slot `blue` (2 replicas at install). |
| `deployment-green.yaml` | `quorumproof-api-server-green` — slot `green` (0 replicas at install). |
| `service.yaml` | Live `quorumproof-api-server` Service; `selector.slot` decides who gets traffic. Annotated with `quorumproof.io/active-slot`, `previous-slot`, `switched-at`. |
| `service-preview.yaml` | `quorumproof-api-server-preview` — always the idle slot, for in-cluster validation before the switch. |
| `kustomization.yaml` | `kubectl apply -k k8s/blue-green/` |

```
                ┌──────────── Service: quorumproof-api-server ───────────┐
 Ingress ─────▶ │ selector: app=quorumproof-api-server, slot=<active>    │
                └───────────────┬────────────────────────────────────────┘
                                │
           ┌────────────────────┴───────────┐
           ▼                                ▼
  Deployment -blue  (slot=blue)     Deployment -green (slot=green)
           ▲                                ▲
           └──── Service: -preview (slot=<idle>) ── smoke tests only
```

Each slot is identical to the original Deployment plus:

- a `slot` label (in selector and pod template) and `DEPLOYMENT_SLOT` env var;
- a `startupProbe` on `/health/live` so slow startups (migrations) are not
  killed by the liveness probe;
- readiness on `/health/ready` rather than `/health`, so a pod only joins the
  Service once its dependencies are ready;
- a 10 s `preStop` sleep so connections drain after the selector moves away.

### First-time setup

```bash
kubectl create namespace quorumproof           # if not present
# create quorumproof-api-server-env Secret (see k8s/api-server-deployment.yaml)

# Migrating from the single Deployment: remove it and its Service first,
# otherwise the old Service (selector without `slot`) would hit both slots.
kubectl -n quorumproof delete deploy/quorumproof-api-server svc/quorumproof-api-server

kubectl apply -k k8s/blue-green/
./scripts/blue_green_deploy.sh status
```

> After setup, do not re-run `kubectl apply -k` to ship releases: it would
> reset images, replica counts and selectors. Use the script.

---

## Releasing

```bash
./scripts/blue_green_deploy.sh deploy ghcr.io/quorumproof/api-server:1.4.0
```

or run the **Blue-Green Deploy** workflow
(`.github/workflows/blue-green-deploy.yml`) with `action=deploy`.

Steps performed:

1. Detect the active slot from the live Service selector; the other is idle.
2. `kubectl set image` + scale the idle slot to the active replica count
   (minimum 2) and wait for `rollout status`.
3. Point the preview Service at the idle slot.
4. **Health check validation** (below). Any failure aborts — production
   traffic was never touched.
5. **Traffic switch**: one `kubectl patch` of the live Service selector
   (plus annotations); preview is flipped to the old slot.
6. **Soak** for `BG_POST_SWITCH_SOAK` seconds (300 s for production in CI),
   checking `/health/ready` through the live Service and, if
   `PROMETHEUS_URL` is set, the 5xx ratio for the new slot. Breaching either
   triggers an **automatic rollback**.
7. Keep the previous slot running (default) for instant manual rollback.

### Health check validation

Performed in-cluster through the preview Service using an ephemeral
`curlimages/curl` pod, so it exercises the same network path real traffic
uses:

| Check | Pass condition |
|---|---|
| Replicas | `readyReplicas == spec.replicas` and ≥ 1 |
| `GET /health/live` | 200 within `BG_HEALTH_RETRIES × BG_HEALTH_INTERVAL` |
| `GET /health/ready` | 200 (dependencies reachable) |
| `GET /health` | 200 (overall `healthy` or `degraded`) |
| Restarts | 0 container restarts in the slot |

### Tuning

| Variable | Default | Notes |
|---|---|---|
| `BG_NAMESPACE` | `quorumproof` | |
| `BG_REPLICAS` | active slot's count, min 2 | |
| `BG_ROLLOUT_TIMEOUT` | `300s` | Increase if startup migrations are slow. |
| `BG_HEALTH_RETRIES` / `BG_HEALTH_INTERVAL` | `10` / `6` | ~60 s per endpoint. |
| `BG_POST_SWITCH_SOAK` | `60` | Seconds of monitoring after the switch. |
| `BG_ERROR_THRESHOLD` | `0.05` | Max 5xx ratio during soak. |
| `BG_KEEP_PREVIOUS` | `true` | `false` scales the old slot to 0 after success. |
| `PROMETHEUS_URL` | — | Enables the error-rate gate. Requires a `slot` label on `http_requests_total` (add via relabelling from the pod label). |
| `NOTIFY_WEBHOOK` | — | Slack/Teams notifications. |

---

## Rollback procedures

### Automatic

If the soak fails, the script re-points the live Service at the previous slot
and exits non-zero. Nothing else is needed; investigate the failed slot, which
is still running and reachable through the preview Service.

### Manual — previous slot still warm (seconds)

```bash
./scripts/blue_green_deploy.sh rollback
```

Reads `quorumproof.io/previous-slot` from the live Service and switches back.
Equivalent raw command if the script is unavailable:

```bash
kubectl -n quorumproof patch svc quorumproof-api-server \
  --type merge -p '{"spec":{"selector":{"slot":"blue"}}}'   # or "green"
```

### Manual — previous slot scaled down (minutes)

`rollback` detects that the previous slot has no Ready replicas, scales it to
the active replica count, waits for rollout, then switches. The old image is
still set on that Deployment, so no image tag is needed.

### Rolling back further than one release

Only one previous release is kept warm. For older releases, deploy the known
good image tag as a normal release:

```bash
./scripts/blue_green_deploy.sh deploy ghcr.io/quorumproof/api-server:1.3.2
```

### Database migrations

Both slots share the same database, so the new release's migrations run while
the old slot is still serving. Migrations **must be backward compatible**
(expand → deploy → contract):

1. Release N adds columns/tables only; old code ignores them.
2. Release N+1 stops using the old shape.
3. Release N+2 drops it.

A rollback across a non-backward-compatible migration is not zero-downtime —
follow [database-migrations.md](./database-migrations.md) instead.

### After any rollback

1. `./scripts/blue_green_deploy.sh status` — confirm the live slot and image.
2. Capture logs from the failed slot before scaling it down:
   `kubectl -n quorumproof logs -l app=quorumproof-api-server,slot=<failed> --tail=500`.
3. `./scripts/blue_green_deploy.sh scale-down-idle` once investigation is done.
4. Record the incident per [OPERATOR_RUNBOOK.md](./OPERATOR_RUNBOOK.md).
