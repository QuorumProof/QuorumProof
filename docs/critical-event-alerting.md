# Critical Contract Event Monitoring & Alerting

Issue #3. Prior to this, security-relevant contract activity — revocations,
disputes, contract upgrades — wasn't monitored at all; an operator would
only find out by manually querying state. This adds an event listener and
two independent alerting paths so that activity is never silent.

## Dashboard

**[monitoring/grafana/dashboards/critical-events.json](../monitoring/grafana/dashboards/critical-events.json)**
is the **pre-incident view**: it charts `quorumproof_critical_events_total` by category
over time, shows the 15-minute revocation window that drives `RevocationSpike`, and
plots the alert-dispatch failure rate that drives `CriticalEventAlertingDegraded`.

The **alerts in `monitoring/prometheus/alerts.yml`** are the **paging layer**: they fire
when a threshold is crossed and route to Slack/PagerDuty via Alertmanager. If you are
being paged, open the dashboard first to understand the trend leading up to the alert,
then use `GET /events/critical/recent` for per-event detail (topic, ledger, tx hash).

The distinction matters: an operator watching the dashboard can see a revocation count
trending toward the `RevocationSpike` threshold and investigate before being paged;
once PagerDuty fires, the dashboard is the context window that explains whether the
alert was a one-off spike or sustained activity.

## Architecture

```
Soroban RPC (getEvents)
        │
        ▼
api-server/src/services/criticalEventListener.ts   (polls every 15s, cursor-tracked)
        │
        ├─→ classify topic (revocation / dispute / upgrade)
        │
        ├─→ real-time push ──→ alertChannels.ts ──→ Slack webhook / PagerDuty Events API
        │                      (seconds-scale, per-event)
        │
        └─→ Prometheus counters (quorumproof_critical_events_total{category=...})
                   │
                   ▼
            monitoring/prometheus/alerts.yml (rule evaluation, e.g. spike detection)
                   │
                   ▼
            Alertmanager (monitoring/prometheus/alertmanager.yml) ──→ Slack / PagerDuty
                                                                        (scrape-interval-scale)
```

Two paths exist deliberately: the direct push path reacts within seconds of
the event being observed (important for disputes/upgrades, where minutes
matter), while the Prometheus/Alertmanager path is better suited to
*trend* detection (e.g. an unusual rate of revocations) that a single-event
push can't express, and gives a second, independent delivery mechanism in
case the in-process push fails (see `CriticalEventAlertingDegraded` below).

## What's monitored

Event classification is topic-pattern based, not an exact string list
(`classifyTopic` in `criticalEventListener.ts`), so it also catches
revocation/dispute/upgrade-shaped events added to the contract later
without a code change:

| Category | Topic pattern | Contract events currently matched |
|---|---|---|
| `revocation` | `/revok|suspend/i` | `RevokeCredential`, `DelegationRevoked`, `RoleRevoked`, `ConsentRevoked` |
| `dispute` | `/disput/i` | dispute-resolution events |
| `upgrade` | `/upgrad|migrat/i` | `UpgradeValidated`, `MigrationProgress`, `MetadataSchemaUpgraded` |

## Configuration

| Env var | Purpose |
|---|---|
| `CONTRACT_QUORUM_PROOF` | Required for the listener to start (same var `soroban.ts` uses). |
| `STELLAR_RPC_URL` | RPC endpoint to poll (defaults to testnet). |
| `EVENT_LISTENER_POLL_MS` | Poll interval, default 15000. |
| `CRITICAL_EVENT_MONITORING` | Set to `disabled` to opt out even when a contract id is configured. |
| `SLACK_ALERT_WEBHOOK_URL` | Slack incoming webhook for real-time push alerts. |
| `PAGERDUTY_ROUTING_KEY` | PagerDuty Events API v2 routing key, for `critical`-severity events only. |

If neither `SLACK_ALERT_WEBHOOK_URL` nor `PAGERDUTY_ROUTING_KEY` is set,
`dispatchAlert` no-ops silently (treated as success) rather than failing —
this keeps the listener usable in dev/CI without alert credentials
configured, at the cost of alerts going nowhere until a channel is added.

## Alert interpretation

**Real-time (per-event) Slack/PagerDuty push**, one message per critical
event, immediately on observation:

- **Revocation** (`warning` severity, Slack only) — a credential,
  delegation, or role was revoked. Expected in normal operation (issuers
  revoke credentials routinely); read as informational unless volume looks
  unusual (see `RevocationSpike` below).
- **Dispute** (`critical`, Slack + PagerDuty) — a dispute was raised
  on-chain. Always page: disputes are rare and typically require an
  operator or arbitrator to review the underlying claim promptly.
- **Upgrade** (`critical`, Slack + PagerDuty) — a contract upgrade or
  migration event. Always page: an unexpected upgrade event is a strong
  signal of unauthorized admin action or a misfired deploy. **First
  response**: confirm with the deploying team whether this was a planned,
  authorized change before doing anything else — see
  `docs/contract-upgrade-strategy.md` for the expected upgrade procedure to
  compare against.

**Prometheus/Alertmanager rules** (`monitoring/prometheus/alerts.yml`),
evaluated on the scrape interval:

- `RevocationSpike` (`warning`) — more than 10 revocation-shaped events in
  15 minutes. Compare against known issuer batch-revocation activity before
  escalating; a bulk credential-recall operation can legitimately trigger
  this.
- `DisputeRaised` (`critical`) — any dispute event in the last 5 minutes.
  Redundant with the real-time push by design — treat a Prometheus-sourced
  page with no matching Slack message as evidence the real-time path itself
  is broken.
- `ContractUpgradeDetected` (`critical`) — any upgrade/migration event in
  the last 5 minutes. Same redundancy rationale as `DisputeRaised`.
- `CriticalEventAlertingDegraded` (`warning`) — the listener observed a
  critical event but failed to deliver it to *any* channel (both Slack and
  PagerDuty requests failed). Treat this as "alerting itself is broken,"
  not as evidence about contract state — go check `GET
  /events/critical/recent` directly, since it may hold events that never
  reached a human.

## Operational endpoints

- `GET /events/critical/recent` — JSON: listener metrics plus the most
  recent critical events (topic, category, ledger, tx hash, decoded value).
  The source of truth when triaging an alert, and the fallback view when
  `CriticalEventAlertingDegraded` fires.
- `GET /metrics/events` — Prometheus exposition of the counters consumed by
  `alerts.yml`. **Scraped** by the `api-server-critical-events` job in
  `monitoring/prometheus/prometheus.yml`, every 15s (matching
  `EVENT_LISTENER_POLL_MS`'s default) — without that job the four
  critical-event alert rules below have no data and can never fire, no
  matter how many revocations/disputes/upgrades actually occur. Expected
  alert latency once scraped: up to one scrape interval (15s) for the
  counter to land in Prometheus, plus each rule's own evaluation window —
  effectively immediate (`for: 0m` on all four) for `DisputeRaised` and
  `ContractUpgradeDetected` (5m windows), and up to 15m of accumulation for
  `RevocationSpike`'s volume threshold to be reached.

### Scrape target inventory

Every route Prometheus is meant to cover, kept here so a future new
`/metrics/*` route doesn't silently repeat this gap — cross-check against
`monitoring/prometheus/prometheus.yml`'s `scrape_configs` when adding one:

| Route | Scrape job | Consumed by |
|---|---|---|
| `GET /metrics/events` (this doc) | `api-server-critical-events` | `RevocationSpike`, `DisputeRaised`, `ContractUpgradeDetected`, `CriticalEventAlertingDegraded` |
| `quorumproof-exporter` `:9101/metrics` | `quorumproof-exporter` | `HighErrorRate`, `APIDown`, `ContractPaused`, `LowAttestationRate`, `RateLimitSpike`, and most other rules in `alerts.yml` |
| Prometheus self-scrape `:9090` | `prometheus` | Prometheus's own operational metrics |

`GET /metrics/ws` (`docs/websocket-scaling.md`) and `GET /metrics/rpc`
(`docs/resilience.md`) are exposed by api-server but are **not** currently
scraped by `monitoring/prometheus/prometheus.yml` — no `alerts.yml` rule
depends on them today, but adding one without also adding a scrape job
would reproduce this exact bug.

## Alerting channel setup

`monitoring/prometheus/alertmanager.yml` routes `severity: critical` alerts
to a receiver with both Slack and PagerDuty configured, and everything else
to Slack only. Alertmanager doesn't expand `${VAR}` placeholders on its
own — template the file at deploy time (`envsubst`, Helm, etc.) or replace
the placeholders with literal secrets from your secrets manager. The
in-process real-time path (`alertChannels.ts`) reads
`SLACK_ALERT_WEBHOOK_URL` / `PAGERDUTY_ROUTING_KEY` directly from the
api-server's environment — the two paths can point at the same or
different Slack channels/PagerDuty services depending on how much you want
to separate "live event fired" noise from "trend rule fired" noise.
