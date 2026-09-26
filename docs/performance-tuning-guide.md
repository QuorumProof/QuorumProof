# Performance Tuning Guide

> Issue #1646. How to find, tune, measure, and watch QuorumProof performance.
> Related: [capacity-planning.md](./capacity-planning.md) (sizing and load-test
> reference numbers), [perf-regression.md](./perf-regression.md) (contract
> budget regression gates), [cost-optimization-guide.md](./cost-optimization-guide.md)
> (fees), [websocket-scaling.md](./websocket-scaling.md).

Tune in this order: **measure → find the bottleneck → change one parameter →
re-measure**. Every parameter below is an environment variable or constant that
already exists; defaults are shown so you know what you're moving away from.

---

## 1. Performance bottlenecks

Ordered by how often they are the actual limit in production.

### 1.1 Soroban RPC round-trips (dominant)

Every verification, credential read and dashboard query goes through
`simulateCall` to Soroban RPC (`api-server/src/soroban.ts`). At ~80 ms per
round-trip this dwarfs Express routing and JSON work (<5 ms). The load test
shows verification throughput tracks RPC latency almost linearly — see
[capacity-planning.md](./capacity-planning.md#performance-benchmarks-reference-numbers).

Symptoms: p95 latency rises with no CPU increase; `quorumproof_rpc_circuit_breaker_failures_total`
climbs; `/api/verify` queue grows.

Levers: caching (§2.4), batching (`POST /api/credentials/verify-batch`, max 50),
a closer/dedicated RPC endpoint, the circuit breaker (§2.3).

### 1.2 On-chain resource budget (contracts)

Contract cost is CPU instructions and memory bytes metered by Soroban, not
wall-clock. The expensive paths, from `benches/tests/benchmarks.rs`:

| Operation | Why it's expensive |
|---|---|
| `verify_engineer` | Cross-contract QuorumProof → SbtRegistry → ZkVerifier. |
| `verify_plonk_proof`, `verify_aggregate_proof` | Pairing / curve arithmetic. |
| `batch_issue_credentials`, `verify_attestations_batch` | Linear in batch size; can hit the per-transaction limit. |
| Slice intersection (`benches/tests/intersection_benchmarks.rs`) | Grows with attestor count per slice. |

Symptoms: `ExceededLimit` / budget errors, rising fees, benchmark gate
failures in the Benchmarks workflow.

Levers: smaller batches, fewer attestors per slice, persistent vs temporary
storage choice, avoiding repeated `env.storage()` reads in loops (read once,
pass values), verifying proofs off-chain first where the protocol allows.

### 1.3 Concurrency queueing in the API server

`createConcurrencyLimiter` (`api-server/src/index.ts`) caps in-flight requests
and queues the excess. When RPC slows down, requests hold slots longer, the
queue fills, and callers wait up to `CONCURRENCY_MAX_WAIT_MS` before a 503.

Symptoms: latency cliff (not slope) under load; 503s with queue-full messages.

### 1.4 Database connection pool

Postgres-backed routes share the pool in `api-server/src/db.ts`. An undersized
pool shows up as `quorumproof_db_pool_waiting > 0`; an oversized one exhausts
Postgres `max_connections` once you scale replicas.

### 1.5 WebSocket fan-out

Each broadcast is serialised per subscriber. Slow consumers fill their send
queue and messages are dropped (`quorumproof_ws_messages_dropped_total`).
Cross-instance fan-out adds a Redis pub/sub hop when `REDIS_URL` is set.

### 1.6 Middleware overhead

The `/api` chain runs CORS, compression, DDoS protection, structured logging,
tracing, request dedup, request signing (HMAC), IP allow-list, PoW, adaptive
rate limiting and concurrency limiting on every request. Individually cheap;
together they matter for small, high-rate requests. Compression and HMAC
verification are the most CPU-intensive.

---

## 2. Tuning parameters

### 2.1 Request concurrency

| Variable | Default | Tune when |
|---|---|---|
| `CONCURRENCY_MAX` | `100` | Raise if CPU < 60% and requests are queuing; lower if a replica OOMs under burst. |
| `CONCURRENCY_MAX_QUEUE` | `200` | Lower to fail fast (better for clients with retries); raise to absorb short bursts. |
| `CONCURRENCY_MAX_WAIT_MS` | `5000` | Keep below the client/ingress timeout, or clients time out on requests the server still processes. |
| `CONCURRENCY_VERIFY_MAX` | `20` | Upper bound ≈ RPC endpoint's sustainable concurrency ÷ replicas. |
| `CONCURRENCY_CREDENTIALS_MAX` | `50` | Same reasoning for credential reads. |

Rule of thumb (Little's law): `CONCURRENCY_VERIFY_MAX ≈ target_rps × p95_rpc_latency_s`.
For 200 verify req/s at 80 ms → 16; the default 20 leaves headroom.

### 2.2 Rate limiting

| Variable | Default | Notes |
|---|---|---|
| `RATE_LIMIT_WINDOW_MS` | `60000` | |
| `RATE_LIMIT_MAX` | `100` | Per-client per window. Raise for trusted integrators via API keys rather than globally. |
| `RATE_LIMIT_AUTH_MAX` | `20` | Keep low — brute-force protection. |
| `RATE_LIMIT_BACKOFF` | `2` | Multiplier applied on repeated violations. |
| `RATE_LIMIT_ANOMALY_THRESHOLD` | `3` | Std-devs above baseline treated as anomalous. |
| `POW_RATE_LIMITING_ENABLED` | `true` | PoW adds client-side cost only; disable for internal load tests, never in prod. |

Load tests will hit these first — run them with an exempt API key or raised
limits in a non-production environment, or you'll be benchmarking the limiter.

### 2.3 Soroban RPC

| Parameter | Default | Where |
|---|---|---|
| `STELLAR_RPC_URL` | public testnet | Env. Use a dedicated/paid RPC provider in production; public endpoints throttle. |
| Breaker `failureThreshold` | `5` | `api-server/src/services/rpcCircuitBreaker.ts` |
| Breaker `resetTimeoutMs` | `15000` | Same file. Lower = faster recovery, more probe traffic against a sick endpoint. |
| `EVENT_LISTENER_POLL_MS` | `15000` | Critical-event polling. Lower only if alert latency matters more than RPC load. |

Multi-region: point each region at its nearest RPC
([multi-region-deployment.md](./multi-region-deployment.md)).

### 2.4 Caching

| Cache | Location | Notes |
|---|---|---|
| Proof verification memoisation | `services/metadataHashCache.ts` | Bounded LRU keyed by proof inputs. Increase `maxSize` if the hit rate is low and memory allows. Invalidation rules: [verification-cache-invalidation.md](./verification-cache-invalidation.md). |
| HTTP caching | `middleware/cacheControl.ts` | Sets `Cache-Control` on read routes; put a CDN in front of public verification endpoints. |
| Request dedup | `middleware/requestDeduplication.ts` | Collapses identical concurrent requests — most effective on hot credential ids. |

### 2.5 Database pool

| Variable | Default | Notes |
|---|---|---|
| `DATABASE_POOL_MAX` | `10` | Total across replicas must stay below Postgres `max_connections` minus admin headroom: `replicas × DATABASE_POOL_MAX ≤ max_connections − 10`. |
| `DATABASE_POOL_IDLE_TIMEOUT_MS` | `30000` | |
| `DATABASE_POOL_CONNECT_TIMEOUT_MS` | `5000` | |

Upstream connection pool (`services/connectionPool.ts`):
`POOL_MAX_SIZE=20`, `POOL_MIN_SIZE=2`, `POOL_MAX_WAIT_MS=5000`,
`POOL_IDLE_TIMEOUT_MS=30000`. Raise `POOL_MIN_SIZE` to avoid cold-connection
latency after idle periods.

### 2.6 WebSockets

| Variable | Default | Notes |
|---|---|---|
| `WS_SEND_QUEUE_MAX_MESSAGES` | `200` | Per-connection. Raise for bursty dashboards; lower to shed slow clients sooner. |
| `WS_SEND_QUEUE_MAX_BYTES` | see `ws/` | Byte cap on the same queue. |
| `WS_BACKPRESSURE_HIGH_WATER_MARK` | see `ws/` | Socket buffer level at which sends pause. |
| `WS_DASHBOARD_BROADCAST_INTERVAL_MS` | `5000` | Live-dashboard push frequency. |
| `REDIS_URL` | — | Enables cross-replica fan-out; required beyond one replica. |

### 2.7 Compression and logging

| Variable | Default | Notes |
|---|---|---|
| `COMPRESSION_LEVEL` | `6` | `1–3` trades bandwidth for CPU on CPU-bound replicas. |
| `COMPRESSION_THRESHOLD` | `1024` | Bytes; small JSON isn't worth compressing. |
| `LOG_LEVEL` | `info` | `debug` in production can cost 10–20% throughput. Use `MODULE_LOGS=<module>:debug` for targeted debugging. |
| `LOG_STDOUT` | `true` | Set `false` in Kubernetes if promtail already tails `LOG_FILE`, to avoid double writes. |

### 2.8 Node.js runtime and Kubernetes

| Setting | Recommendation |
|---|---|
| `NODE_OPTIONS=--max-old-space-size` | ~75% of the container memory limit (e.g. `384` for 512Mi). |
| CPU limits | The API is single-threaded per process; scale **out** (replicas), not up. Requests ≥ 250m avoid throttling jitter. |
| `UV_THREADPOOL_SIZE` | Raise to 8–16 if crypto/zlib dominate (`--cpu-prof` shows libuv waits). |
| HPA | Scale on p95 latency or concurrency-queue depth rather than CPU; RPC-bound pods look idle while saturated. |

### 2.9 Contracts

| Parameter | Guidance |
|---|---|
| Batch size for `batch_issue_credentials` | Start at the limits in [batch-issuance-limits.md](./batch-issuance-limits.md); reduce if simulations report budget near the cap. |
| Attestors per slice | Cost grows with slice size — prefer multiple smaller slices with weighted voting ([weighted-voting.md](./weighted-voting.md)). |
| Storage TTL / bump | Extend TTL in bulk during maintenance windows rather than on every read. |
| Proof scheme | PLONK vs Groth16 trade-offs: [groth16-migration.md](./groth16-migration.md). |

---

## 3. Benchmark methodology

### 3.1 Principles

1. **One variable at a time.** Change one parameter per run; record it.
2. **Warm up.** Discard the first 30 s (JIT, connection pools, caches).
3. **Repeat.** At least 3 runs; report the median of each percentile.
4. **Report percentiles, not averages.** p50, p95, p99, max, error rate, throughput.
5. **Same hardware.** Compare only runs on the same instance type/region.
6. **Isolate the limiter.** Raise rate limits / use an exempt key so you measure the system, not the throttle.
7. **Pin versions.** Record git SHA, Node version, contract WASM hash.

### 3.2 Contract benchmarks (deterministic)

```bash
cd benches
cargo test --release -- --nocapture            # budget gates (±10%)
cargo run --release --bin scaling_report       # complexity-class / scaling report
../scripts/benchmark_compare.sh                # compare against committed history
```

Budget numbers are deterministic, so a single run suffices and any change is
real. CI runs these in `.github/workflows/benchmarks.yml` and appends to
`benches/history/` on `main`. See [perf-regression.md](./perf-regression.md).

Contract profiling: `scripts/profile_contracts.sh`.

### 3.3 API load tests

```bash
cd api-server
npm run loadtest:credentials                       # issuance + verification
npm run loadtest:ws                                # WebSocket fan-out

# Sweep a parameter
for c in 10 25 50 100; do
  LOAD_VERIFY_CONCURRENCY=$c npm run loadtest:credentials | tee "run-verify-c$c.txt"
done

# Stress the breaker
LOAD_RPC_FAILURE_RATE=0.08 npm run loadtest:credentials
```

| Knob | Default | |
|---|---|---|
| `LOAD_ISSUE_COUNT` / `LOAD_VERIFY_COUNT` | `1000` / `10000` | Size. |
| `LOAD_ISSUE_CONCURRENCY` / `LOAD_VERIFY_CONCURRENCY` | `50` / `25` | In-flight requests. |
| `LOAD_RPC_LATENCY_MS` | `80` | Synthetic RPC latency — set to your measured production p50. |
| `LOAD_RPC_FAILURE_RATE` | `0.01` | |

The stubbed RPC makes runs reproducible; to measure end-to-end against
testnet swap in the real `simulateCall` (see the header of
`loadtest/credentialLoadTest.ts`).

### 3.4 Profiling

```bash
# CPU profile a local run under load
node --cpu-prof --cpu-prof-dir=./prof dist/index.js &
npm run loadtest:credentials
kill -INT %1          # open prof/*.cpuprofile in Chrome DevTools

# Event-loop delay
node --trace-event-categories node.perf.usertiming dist/index.js
```

Look for: synchronous JSON on large payloads, HMAC/compression hot spots,
per-request regex compilation, and unbounded `await` chains in loops that
should be `Promise.all` with a limit.

### 3.5 Recording results

Keep a table per tuning exercise in the PR description:

| Run | SHA | Change | Concurrency | req/s | p50 | p95 | p99 | Errors |
|---|---|---|---|---|---|---|---|---|
| baseline | abc123 | — | 25 | 180 | 95ms | 160ms | 210ms | 0.9% |
| 1 | abc123 | `CONCURRENCY_VERIFY_MAX=30` | 25 | … | … | … | … | … |

Accept a change only if it improves the target percentile by more than the
run-to-run variance (typically ±5%) without raising error rate.

---

## 4. Monitoring strategy

### 4.1 Signals

| Layer | Metric | Source | Dashboard |
|---|---|---|---|
| API latency | `quorumproof_api_request_duration_seconds` (p50/p95/p99) | exporter | `api-latency.json` |
| API errors | `quorumproof_api_errors_total` | exporter | `api-latency.json` |
| RPC health | `quorumproof_rpc_circuit_breaker_{state,calls_total,failures_total,trips_total}` | `/metrics/rpc` | — |
| DB pool | `quorumproof_db_pool_{active,idle,waiting,utilization_pct}` | `/metrics/db` | — |
| WebSockets | `quorumproof_ws_{connections,messages_sent_total,messages_dropped_total}` | `/metrics/ws` | — |
| Contracts | budget per op | `benches/history/` | Benchmarks workflow artifacts |
| Credential volume | issuance/verification rates | exporter | `credential-volume.json` |

Scrape every replica; aggregate with `sum by (...)` — each exposes only its
own counters.

### 4.2 Alerts

The `quorumproof-performance` group in `monitoring/prometheus/alerts.yml`:

| Alert | Condition | First response |
|---|---|---|
| `ApiLatencyP95High` | p95 > 500 ms for 10 m | Check RPC breaker and concurrency queue; see §1.1, §1.3. |
| `ApiLatencyP99Critical` | p99 > 2 s for 5 m | Same; consider scaling out; check for a slow RPC provider. |
| `RpcCircuitBreakerOpen` | breaker open 1 m | Switch/fail over `STELLAR_RPC_URL`; see §2.3. |
| `DbPoolSaturated` | utilisation > 90% or waiters for 5 m | Raise `DATABASE_POOL_MAX` within the §2.5 budget, or find slow queries. |
| `WsMessagesDropping` | > 1 drop/s for 5 m | Raise `WS_SEND_QUEUE_MAX_MESSAGES` or investigate slow consumers. |

### 4.3 SLO targets

| SLI | Target |
|---|---|
| `GET` credential / verify p95 | < 300 ms |
| Batch verify (50) p95 | < 1 s |
| Availability (non-5xx) | 99.9% monthly |
| WS delivery (not dropped) | 99.99% |

### 4.4 Continuous practice

- **Every PR**: contract budget gates (Benchmarks workflow).
- **Weekly**: `loadtest:credentials` on staging; append results to the tuning table.
- **Every release**: compare p95/p99 before and after the blue-green switch
  ([blue-green-deployment.md](./blue-green-deployment.md)); the soak gate
  catches error-rate regressions, latency needs a human look.
- **Quarterly**: re-validate the capacity model in
  [capacity-planning.md](./capacity-planning.md) against real traffic.
- **Chaos**: `monitoring/chaos/rpc-latency.yaml` and `network-delay.yaml`
  confirm the breaker and concurrency limits degrade gracefully.

---

## 5. Quick reference: symptom → knob

| Symptom | Likely bottleneck | Knob |
|---|---|---|
| p95 up, CPU flat | RPC latency | Caching, dedicated RPC, `CONCURRENCY_VERIFY_MAX` |
| Sudden 503s under burst | Concurrency queue full | `CONCURRENCY_MAX_QUEUE`, scale out |
| 429s in load tests | Rate limiter | `RATE_LIMIT_MAX`, exempt API key |
| CPU pegged, latency up | Compression / logging / HMAC | `COMPRESSION_LEVEL`, `LOG_LEVEL`, scale out |
| `db_pool_waiting > 0` | DB pool | `DATABASE_POOL_MAX` |
| WS drops | Slow consumers | `WS_SEND_QUEUE_MAX_*` |
| `ExceededLimit` on-chain | Contract budget | Smaller batches / slices |
| Latency spike after idle | Cold connections | `POOL_MIN_SIZE` |
