# Gas Cost Tracking & Optimization Guide

Issue #4. Operators previously had no visibility into what each contract
operation costs to run — Soroban RPC returns a `minResourceFee` (the
computed resource/gas fee, in stroops) on every `simulateTransaction` call,
but nothing recorded it. This adds per-operation cost tracking, cost
projection for hypothetical volumes, and automated optimization
recommendations.

## How it works

`api-server/src/services/gasCostTracker.ts` records `minResourceFee`
against the operation name every time `soroban.ts`'s `simulateCall`
completes successfully (see the `getDefaultGasCostTracker().record(...)`
call in `soroban.ts`). Stats are persisted (via the same `DurableLog`
append-only-JSONL pattern used by the webhook store and RPC circuit
breaker) so they survive process restarts, and are keyed per operation
name (e.g. `is_attested`, `get_credential`, `get_supported_claim_types`).

Costs are reported in three units: raw stroops (the on-chain unit,
1 XLM = 10,000,000 stroops), XLM, and USD (via a configurable
`XLM_USD_PRICE` env var, default `0.12` — set this to the current market
price for accurate USD figures; it is not fetched automatically).

## Endpoints

- `GET /api/costs/report` — aggregated report: total calls, total cost, and
  a per-operation breakdown (call count, total/min/max/avg stroops),
  sorted by total contribution to spend (highest first).
- `GET /api/costs/optimizations?top=5` — ranked optimization candidates
  (see "How recommendations are ranked" below).
- `GET /api/costs/projection?operation=is_attested&callsPerDay=10000&days=30`
  — projects cost for a hypothetical volume using that operation's
  observed average fee. Returns `404` if the operation has no recorded
  calls yet (there's no fee to project from).

## Cost projections for common scenarios

Using the projection endpoint, here's how to build out the standard
scenarios operators need for budgeting. These use illustrative average fees
(~0.0000015 XLM/call is a typical Soroban read-call resource fee on
testnet; production mainnet fees are usually of the same order but should
be measured directly via `/api/costs/report` rather than assumed):

| Scenario | Operation | Volume | Illustrative monthly cost |
|---|---|---|---|
| Verification-heavy relying party | `is_attested` | 10,000 verifications/day | ~0.45 XLM/month (~$0.05 at $0.12/XLM) |
| High-volume issuer | `get_credential` + search index reads | 1,000 issuances/day | ~0.045 XLM/month |
| Analytics dashboard polling | `get_supported_claim_types` | 1 call/minute (43,200/month) | ~0.065 XLM/month |

Re-run these against `/api/costs/projection` with your actual recorded
averages before using them for real budget decisions — the numbers above
are for scale/order-of-magnitude planning, not a substitute for measurement.
Also cross-reference `docs/capacity-planning.md`, which covers the same
volume scenarios from a throughput/latency angle — cost and capacity
planning should use the same assumed call volumes.

## How recommendations are ranked

`getOptimizationRecommendations()` ranks by **total XLM contribution to
spend**, not per-call cost — a cheap operation called constantly can cost
more in aggregate than an expensive one called rarely, and only the former
is worth optimizing. For each of the top operations it reports one of
three reasons:

1. **Dominates spend** (≥30% of total) — the highest-leverage target; even
   a small per-call reduction compounds across volume.
2. **Above-average per-call cost** (>2x the overall average) — suggests
   the operation reads/writes more contract state than necessary; review
   whether it can be split into a cheaper read plus a conditional
   follow-up call.
3. **High call volume** — batching or caching may reduce redundant
   simulations.

## Cost optimization opportunities identified

Reviewing the current API surface against how `simulateCall` is invoked:

1. **`verify-batch`'s per-id fan-out** (`POST /api/credentials/verify-batch`
   in `routes/credentials.ts`) issues one `is_attested` simulation per
   credential id in the batch. Since simulation is read-only and
   idempotent within a ledger, short-lived caching (a few seconds, well
   under a ledger close) of `(is_attested, credential_id, slice_id)``
   results would cut redundant simulations when the same credential is
   checked by multiple concurrent verification requests — a natural
   extension of the RPC circuit breaker's existing fallback cache
   (`rpcCircuitBreaker.ts`), which currently only serves cached data while
   the breaker is open, not opportunistically on the happy path.
2. **Best-effort enrichment calls** like `get_supported_claim_types` (noted
   in `docs/resilience.md` as degrading gracefully on failure) are also
   good caching candidates on the happy path — this data changes rarely,
   so simulating it on every verification request is pure overhead once a
   cache is added.
3. **Batch size ceiling** (`verify-batch` caps at 50 ids) already bounds
   worst-case per-request cost; do not raise it without re-running both
   `docs/capacity-planning.md`'s load test and checking the resulting
   change in `/api/costs/report`'s per-operation averages.
4. **Track cost regressions the same way latency regressions are tracked**
   — `monitoring/exporter/performance_regression.py` already flags p95
   latency regressions against a baseline; the same pattern (baseline +
   percentage-deviation alert) applies directly to
   `quorumproof_gas_cost_avg_stroops` once this tracker's data is wired
   into the Prometheus exporter, so an unexpectedly expensive contract
   change gets caught before it reaches production traffic.
