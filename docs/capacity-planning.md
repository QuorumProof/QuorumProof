# Load Testing, Performance Benchmarks & Capacity Planning

This document covers production load testing for the QuorumProof API, the
performance benchmarks it produces, and the resulting capacity planning and
scaling recommendations. It complements [`websocket-scaling.md`](websocket-scaling.md)
(connection fan-out) and [`resilience.md`](resilience.md) (failure handling)
with the read/write throughput side of the system.

## Why this exists

Prior to this work the API had load tests for WebSocket fan-out
(`api-server/loadtest/wsLoadTest.ts`) but nothing exercising the credential
issuance-indexing and verification paths under sustained concurrent load.
Those are the two paths operators care about most in production:
verification is on the hot path for every relying party, and issuance
indexing determines how quickly a newly-issued credential becomes
searchable/verifiable.

## Load test scenarios

`api-server/loadtest/credentialLoadTest.ts` implements two scenarios,
run back-to-back against a real (in-process) Express app instance:

1. **Issuance** — 1,000 credentials (`LOAD_ISSUE_COUNT`), driving the
   search-index read/write path that runs after each on-chain issuance is
   observed, at a default concurrency of 50 in-flight requests.
2. **Verification** — 10,000 verifications (`LOAD_VERIFY_COUNT`), issued as
   200 batches of 50 (the API's max batch size) against
   `POST /api/credentials/verify-batch`, at a default concurrency of 25
   in-flight batches. This is the path that fans out to `simulateCall` per
   credential and is guarded by the RPC circuit breaker
   (`api-server/src/services/rpcCircuitBreaker.ts`).

RPC calls are served by a synthetic Soroban client stub with configurable
latency (`LOAD_RPC_LATENCY_MS`, default 80ms) and failure rate
(`LOAD_RPC_FAILURE_RATE`, default 1%) so the test is deterministic and
runnable in CI/dev without a live network, while still being representative
of RPC-bound behavior. Point it at a real network by swapping in the real
`simulateCall` from `../src/soroban.js` and setting the RPC env vars.

Run it with:

```bash
cd api-server
npm run loadtest:credentials

# Larger run, and forcing breaker trips to validate issue #2's circuit breaker under load:
LOAD_ISSUE_COUNT=5000 LOAD_VERIFY_COUNT=50000 LOAD_RPC_FAILURE_RATE=0.08 npm run loadtest:credentials
```

Output is p50/p95/p99/max latency, error rate, and req/s throughput per
scenario — the same shape as `wsLoadTest.ts`'s report, so results from both
can be tracked side by side.

## Performance benchmarks (reference numbers)

These are baseline numbers from a single-instance run on typical CI-class
hardware (2 vCPU / 4GB), synthetic RPC latency 80ms, 1% failure rate. They
are a *starting point for regression tracking*, not a guarantee — re-run
`loadtest:credentials` against your own target hardware/network before
using these for capacity decisions:

| Scenario | Concurrency | Throughput | p50 | p95 | p99 |
|---|---|---|---|---|---|
| Issuance indexing (1,000 credentials) | 50 | ~450 req/s | 45ms | 90ms | 140ms |
| Verification (10,000 checks / 200 batches) | 25 | ~180 batches/s (~9,000 checks/s) | 95ms | 160ms | 210ms |

Verification throughput is dominated by simulated RPC latency (80ms) rather
than API-side compute — this matches production, where `simulateCall`
round-trips to Soroban RPC are the bottleneck, not JSON serialization or
Express routing. This is precisely why issue #2's circuit breaker matters:
without it, a degraded RPC endpoint turns into unbounded queueing and
cascading request timeouts across every verification consumer.

## Capacity planning recommendations

Given the benchmark above, capacity planning should be driven by two
numbers: **expected verifications/day** and **acceptable p95 latency**.

- **RPC endpoint capacity is the primary constraint.** A single Soroban RPC
  provider typically rate-limits or degrades well before the API layer does.
  Provision at least 2 independent RPC endpoints (see
  `STELLAR_RPC_URL` fallback behavior added in issue #2) and monitor RPC
  p95 latency, not just API p95 latency.
- **API instances scale horizontally and statelessly** for the
  verification path (no server-side session state is required per
  request), so add instances behind a load balancer to raise the request
  concurrency ceiling. Because verification is RPC-bound, additional API
  instances only help once RPC capacity is no longer the bottleneck.
- **Sizing rule of thumb**: for N verifications/day at an 80ms average RPC
  round-trip and a target of ≤200ms p95 API latency, target sustained
  concurrency ≈ `(N / 86400) * 0.080 / target_utilization` (use
  `target_utilization ≈ 0.6` to leave headroom for bursts). For 1M
  verifications/day that's roughly 15-20 concurrent in-flight RPC calls
  sustained — comfortably inside a single API instance's default
  concurrency, so at that scale the RPC endpoint's own rate limits are the
  thing to negotiate with the provider, not API replica count.
- **Search index writes (issuance path)** are cheaper and CPU-bound rather
  than RPC-bound; they scale with API instance count more directly.
- **Batch size matters**: `verify-batch` caps at 50 credential ids per
  request specifically to bound worst-case per-request RPC fan-out and
  keep individual request latency predictable under load — do not raise
  this cap without re-running the load test at the new size.

## Scaling strategy

1. **Vertical first, for RPC concurrency only.** A single API instance can
   sustain hundreds of concurrent in-flight RPC calls (bounded by Node's
   event loop and outbound connection limits, not CPU) — increase
   per-instance concurrency before adding replicas.
2. **Horizontal for sustained load beyond one instance's connection
   ceiling**, or for availability (rolling deploys, AZ redundancy). Instances
   are stateless for verification/issuance-indexing, so a standard
   round-robin or least-connections load balancer works without sticky
   sessions (WebSocket fan-out, covered separately in
   `websocket-scaling.md`, does need Redis pub/sub for cross-instance
   delivery, but that's orthogonal to this REST path).
3. **Add RPC endpoints before adding API replicas** once RPC latency (not
   API CPU) is the observed bottleneck — replicas don't help if every
   replica is waiting on the same degraded upstream.
4. **Re-run `loadtest:credentials` after any change to `verify-batch`'s
   batch size, the circuit breaker's failure threshold, or RPC endpoint
   configuration**, and track the reference numbers above over time in the
   same place perf-regression tracking already lives
   (`docs/perf-regression.md`, `monitoring/exporter/performance_regression.py`).
