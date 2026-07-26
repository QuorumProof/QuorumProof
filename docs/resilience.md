# Resilience & Chaos Testing

Issue #1003. Documents QuorumProof's resilience requirements for network
failures (delays, packet loss, service unavailability), the chaos-testing
tooling added to verify them, and how to run it.

## Scope

Two independent layers are covered:

1. **`api-server` (Node/Express)** — the only component that makes real
   network calls (to the Soroban RPC endpoint, and optionally Redis for
   cross-instance WebSocket delivery). This is where actual network chaos
   (delay, packet loss, downtime) can occur and be tested in-process.
2. **Contracts (`contracts/`)** — Soroban contract tests run entirely against
   an in-process mock ledger (`soroban_sdk::Env::default()`); there is no
   real network layer to inject faults into at that layer. Contract-level
   chaos testing (`contracts/integration_tests/src/chaos.rs`, issue #554)
   instead covers *application-level* chaos: unexpected call ordering,
   boundary conditions, and graceful-degradation of contract state — see
   that file for details. It is out of scope for this document.

## Resilience requirements

These are the behaviors the API server MUST exhibit under network failure,
verified by `api-server/tests/chaos.test.ts`:

| Failure class | Requirement |
| --- | --- |
| **Network delay** | A slow upstream RPC call must not corrupt a response or cause partial state — the request completes correctly once the call resolves. No artificial timeout is currently enforced API-side (the RPC client itself is responsible for its own timeout budget). |
| **Packet loss / dropped connections** | A single failed upstream call must degrade to a scoped error (a `500` for single-resource endpoints, or a per-item `error`/`status: "error"` entry for batch endpoints) — it must never crash the process, hang the request, or fail unrelated items in the same batch. |
| **Sustained service unavailability** | When every upstream call fails, endpoints that aggregate multiple calls (e.g. `/api/credentials/search`, which scans every credential) must still return a well-formed response (an empty result set), not an unhandled rejection. |
| **Recovery** | Once the upstream service comes back, the very next request must succeed normally — no breaker, cache, or in-memory state may be left permanently poisoned by a prior failure. |

Existing mechanisms this relies on (already in the codebase, exercised
indirectly by the chaos tests):

- **Per-call try/catch with typed fallbacks** — every route that calls
  `soroban.simulateCall` wraps it and maps failures to a scoped error
  (`api-server/src/routes/credentials.ts`, `verify.ts`, etc.), rather than
  letting a rejection propagate unhandled.
- **Best-effort enrichment calls** — e.g. `get_supported_claim_types` in
  `verify.ts`'s batch handler degrades to "all claim types eligible" if the
  call fails, instead of failing the whole batch.
- **Webhook circuit breaker** (`api-server/src/services/webhookCircuitBreaker.ts`)
  — trips open after repeated delivery failures and self-recovers via a
  half-open trial, so a down webhook consumer can't cause unbounded retry
  storms against it.
- **RPC circuit breaker** (`api-server/src/services/rpcCircuitBreaker.ts`,
  issue #2, wraps every `simulateCall` in `soroban.ts`) — the three-state
  (closed/open/half-open) counterpart for the Soroban RPC dependency
  itself, distinct from the webhook breaker above. After
  `failureThreshold` consecutive RPC failures it trips open and serves the
  last successful result per `(method, args)` from an in-memory TTL cache
  instead of hanging on a degraded endpoint; once `resetTimeoutMs` elapses
  it moves to half-open and lets a small number of trial calls through,
  fully closing only after `halfOpenSuccessesToClose` consecutive
  successes (a failed trial reopens it with a doubled backoff, capped at
  `maxResetTimeoutMs`). State and counters are exposed at `GET
  /rpc/circuit-breaker` (JSON) and `GET /metrics/rpc` (Prometheus).
- **Rate limiting with backoff** (`api-server/src/middleware/rateLimiter.ts`)
  and **DDoS protection** (`api-server/src/middleware/ddosProtection.ts`) —
  protect the server itself from being overwhelmed, which is the inverse
  chaos scenario (too much traffic rather than too little upstream
  availability) but shares the same "fail gracefully, recover automatically"
  requirement.

## In-repo chaos test suite (CI-runnable)

`api-server/tests/chaos.test.ts` injects delay, dropped connections
(`ECONNRESET`), and sustained unavailability (`503`) directly into the mocked
Soroban RPC client and asserts each endpoint's response against the
requirements table above. This suite requires no external infrastructure and
runs in CI on every PR (see `.github/workflows/ci.yml`, job
`api-server-chaos`).

Run locally:

```bash
cd api-server
npm test -- tests/chaos.test.ts
```

## chaos-mesh manifests (cluster-level, manual/staging use)

`monitoring/chaos/` contains [Chaos Mesh](https://chaos-mesh.org/) experiment
manifests that exercise the same three failure classes against a *real*
deployed `api-server`, for staging/pre-prod verification beyond what the
in-process test suite can reach (actual TCP-level delay/loss, not simulated
rejections):

- `network-delay.yaml` — injects latency into api-server's outbound traffic.
- `packet-loss.yaml` — drops a percentage of outbound packets.
- `service-unavailable.yaml` — kills the RPC-dependent pod(s) outright.

These require a Kubernetes cluster with Chaos Mesh installed and an
`api-server` deployment labeled `app: quorumproof-api-server` — the repo does
not currently ship Kubernetes deployment manifests for `api-server` (see
`monitoring/chaos/README.md` for prerequisites and usage). They are **not**
wired into CI, since CI has no cluster to apply them to; they're for anyone
standing up a staging cluster to validate resilience beyond the mocked
in-process suite.

## Non-goals

- No client-side retry/timeout policy is specified here — that's a
  contract of whatever consumes the API server (frontend, SDK), not the
  server itself.
- No SLO/SLA numbers (e.g. "p99 latency under X ms during a chaos event")
  are defined yet — the requirements above are behavioral (correctness under
  failure), not performance targets. Adding quantitative SLOs is future work.
