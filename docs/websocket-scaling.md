# WebSocket Scaling Across Multiple api-server Replicas

## Problem

`api-server/src/ws/server.ts` and `ws/subscriptions.ts` used to hold all
subscriber and broadcast state in one process's memory. Once `api-server`
runs as more than one replica (the normal shape implied by
[multi-region-deployment.md](multi-region-deployment.md)), a client
connected to instance A would never receive an event only observed by
instance B, with no error surfaced to anyone.

## Architecture

```
 ┌──────────────┐        publish ws:events         ┌──────────────┐
 │  Instance A  │ ───────────────────────────────▶ │              │
 │              │                                    │    Redis     │
 │ local clients│◀─────────────────────────────────  │   Pub/Sub    │
 └──────────────┘        subscribe ws:events        │              │
                                                      │              │
 ┌──────────────┐                                    │              │
 │  Instance B  │ ◀────────────────────────────────  │              │
 │ local clients│        subscribe ws:events         └──────────────┘
 └──────────────┘
```

- Each instance keeps matching connected clients and their subscription
  filters **locally** (`ws/subscriptions.ts`, unchanged) — filter matching
  never crosses the network, only already-matched-by-filter payloads do.
- `broadcastEvent(event)` / `broadcastToAll(event)` (`ws/server.ts`):
  1. Deliver to this instance's local clients synchronously, exactly as
     before (same return value, same call sites in `routes/notifications.ts`
     etc.) — this path has zero dependency on Redis being reachable.
  2. Fire-and-forget publish the event onto the `ws:events` Redis channel,
     tagged with this instance's id.
  3. Every instance (including the publisher) subscribes to `ws:events`; the
     publisher skips its own message (already delivered in step 1), every
     *other* instance delivers it to its local matching clients.
- If Redis is unreachable, step 1 still works — same-instance delivery
  degrades gracefully to single-instance behavior, it doesn't throw or crash
  the request.
- `ws/pubsub.ts` abstracts the transport behind `PubSubBackend`. Set
  `REDIS_URL` to enable real cross-instance delivery (`RedisPubSubBackend`,
  via `ioredis`). Leaving it unset falls back to `InMemoryPubSubBackend`
  (same-process loopback) — fine for local dev/tests with a single instance,
  **not** sufficient for a multi-replica deployment.

## Filter semantics

`credential_id`, `issuer`, `holder`, `event_type` filtering is unchanged —
still implemented once, in `ws/subscriptions.ts::matchesFilter`, and applied
identically whether the event originated locally or arrived from another
instance over Redis. See `api-server/tests/ws.test.ts` (same-instance) and
`api-server/tests/wsMultiInstance.test.ts` (cross-instance) for coverage.

## Dashboard subscribers (liveDashboard.ts)

The live dashboard (`services/liveDashboard.ts`) keeps a local 60-minute
sliding window per instance. `ws/dashboardSync.ts` wires
`liveDashboard.setDeltaPublisher(...)` so every `recordIssuance()` /
`recordAttestation()` / `recordApiError()` call also publishes a small delta
on the `ws:dashboard-delta` channel; every instance applies remote deltas to
its own window via `applyRemoteDelta()` (which never re-publishes, so deltas
don't loop). Each instance's periodic dashboard broadcast
(`WS_DASHBOARD_BROADCAST_INTERVAL_MS`, default 5000ms) therefore reflects a
cluster-wide, eventually consistent view regardless of which instance issued
the underlying credential event or which instance a dashboard subscriber is
connected to.

## Backpressure and the per-connection send queue

`ws/connectionQueue.ts` — every outbound message (broadcasts, dashboard
stats, control replies) is enqueued per-connection rather than written to
the socket directly.

- **Bound:** `WS_SEND_QUEUE_MAX_MESSAGES` (default 200) messages *or*
  `WS_SEND_QUEUE_MAX_BYTES` (default 1 MiB), whichever is hit first.
- **Drop policy:** when a new message would exceed either bound, the
  **oldest** queued message is dropped to make room. This is a "latest wins"
  policy — for a real-time status feed, a fresh event is more useful to a
  lagging client than a stale one, and clients are expected to reconcile via
  a REST fetch on reconnect (`frontend/src/hooks/useRealtimeUpdates.ts`)
  rather than rely on every message arriving.
- Every drop increments `messagesDropped` (visible in both metrics
  endpoints below) so operators can see when clients are falling behind.
- The queue also respects `ws.bufferedAmount`: while a socket's own OS-level
  send buffer is above `WS_BACKPRESSURE_HIGH_WATER_MARK` bytes (default
  1 MiB), draining pauses briefly instead of piling more onto it.

## Metrics

- `GET /ws/metrics` — JSON, this instance only (unchanged shape plus
  `instanceId`, `messagesDropped`, `crossInstanceMessagesReceived`,
  `crossInstanceMessagesPublished`).
- `GET /metrics/ws` — Prometheus text exposition
  (`quorumproof_ws_connections`, `quorumproof_ws_messages_sent_total`, etc.),
  each series labeled `instance="<id>"`. Scrape every replica and aggregate,
  e.g.:
  ```promql
  sum(quorumproof_ws_connections)
  sum(rate(quorumproof_ws_messages_sent_total[5m]))
  sum(rate(quorumproof_ws_messages_dropped_total[5m]))
  ```
  Set `WS_INSTANCE_ID` (e.g. to the pod name) in each replica's environment
  so the `instance` label is stable and readable; otherwise a random id is
  generated per process.

## Required configuration for multi-replica deployment

| Env var | Default | Purpose |
|---|---|---|
| `REDIS_URL` | unset (single-instance fallback) | **Required** for real cross-instance delivery. |
| `WS_INSTANCE_ID` | random UUID | Stable label for metrics/pub-sub loop suppression. |
| `WS_SEND_QUEUE_MAX_MESSAGES` | 200 | Per-connection send queue message cap. |
| `WS_SEND_QUEUE_MAX_BYTES` | 1000000 | Per-connection send queue byte cap. |
| `WS_BACKPRESSURE_HIGH_WATER_MARK` | 1000000 | Pause draining while `ws.bufferedAmount` exceeds this. |
| `WS_DASHBOARD_BROADCAST_INTERVAL_MS` | 5000 | How often each instance pushes dashboard stats to its subscribers. |

## Tests

- `api-server/tests/ws.test.ts` — unchanged same-instance behavior (filter
  matching, metrics, connection lifecycle).
- `api-server/tests/wsMultiInstance.test.ts` — real multi-process
  integration test. Spawns an ephemeral `redis-server` plus two real Node
  child processes (`tests/helpers/wsInstanceHarness.ts`), connects a client
  to one instance, triggers events from the other, and proves: cross-instance
  delivery, filter semantics (`credential_id`, `issuer`+`event_type`),
  `broadcastToAll` reaching every instance, and dashboard cross-instance
  sync. Asserts p99 delivery latency < 200ms over 50 trials. Skips itself
  (doesn't fail) if `redis-server` isn't on `PATH`.
  ```
  npm test -- tests/wsMultiInstance.test.ts
  ```
  Measured in this repo's CI-like sandbox (2 vCPU): p50=2ms, p99=54ms.

- `api-server/loadtest/wsLoadTest.ts` — standalone load test script, **not**
  part of `npm test`. Spawns N real instances behind one real Redis and
  opens a configurable number of real client connections, then broadcasts
  and measures delivery completeness and latency.
  ```
  npm run loadtest:ws                                   # 10,000 connections / 3 instances (defaults)
  WS_LOAD_CONNECTIONS=2000 WS_LOAD_INSTANCES=2 npm run loadtest:ws
  WS_LOAD_REDIS_URL=redis://localhost:6379 npm run loadtest:ws   # reuse an already-running Redis
  ```
  Measured in this repo's sandbox (2 vCPU, 10,000 connections / 3
  instances, `broadcastToAll` — the worst case, full fan-out to every
  connection at once): **100% delivery completeness** (200,000/200,000
  messages across 20 rounds), p50=84ms, p99=347ms.

  Note the gap between this and the 200ms bound proven by the correctness
  test above: the correctness test measures a single filtered event to a
  single subscriber, which is the common case. The load test's
  `broadcastToAll` round instead fans a single trigger out to all 10,000
  connections simultaneously — each instance sends to ~3,333 clients via a
  synchronous per-connection loop on one event loop, and the load-generator
  itself is a single Node process parsing up to 10,000 concurrent messages
  per round on 2 vCPUs, so both sides of this specific test are
  single-core-bottlenecked. Delivery completeness (the correctness
  guarantee this whole feature is about) holds either way. If full-fanout
  broadcast tail latency at this scale needs to be tightened further in
  production, the natural next step is parallelizing the send loop (worker
  threads, or sharding connections across multiple event loops per
  instance) — out of scope here since completeness, not raw fan-out
  throughput, was the correctness bug being fixed.

## What didn't change

- Message wire format (client and server), `ws/subscriptions.ts` filter
  matching logic, `GET /health`, and every existing call site
  (`routes/notifications.ts`, `services/webhooks.ts`) are untouched —
  `broadcastEvent`/`broadcastToAll` keep their synchronous signature and
  return the same local-recipient count as before.
