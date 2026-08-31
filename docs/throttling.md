# Throttling Systems: Circuit Breaker, Rate Limiting, Congestion

The contract has three independently-configured systems that can each
restrict or reject a write call. This note lists them, their configuration
surface, and — because none of them currently defers to the others — the
precedence order that actually applies when more than one is in effect for a
single call.

## The three systems

### 1. Circuit breaker (`circuit_breaker.rs`)

- States: `Normal`, `Degraded`, `Paused`.
- Config: `CircuitBreakerConfig` (`ttl_seconds`, `degraded_write_limit`,
  `auto_recover`), set via `set_circuit_breaker_config`.
- `Paused` rejects every write with `ContractError::ContractPaused`.
- `Degraded` allows writes but caps them at `degraded_write_limit` per
  degraded window, rejecting the excess with
  `ContractError::CircuitBreakerDegradedLimitReached`.
- Auto-recovers back to `Normal` once `auto_recover_at` has passed (checked
  at the start of every call, before the state is used).

### 2. Rate limiting (`RateLimitConfig` / `IssuerQuota` in `lib.rs`)

- Per-address sliding-window call budget: `max_calls` per `window_seconds`.
- A global default (`set_rate_limit_config`) and an optional per-issuer
  override (`set_issuer_rate_limit_config`) — the per-issuer value wins when
  present.
- An issuer can be added to a whitelist (`add_rate_limit_whitelist`) that
  **bypasses rate limiting entirely** for that address.
- Violating the limit rejects with `ContractError::RateLimitExceeded`.

### 3. Congestion throttling (`CongestionConfig` / `update_congestion_and_adjust`)

- Tracks calls-per-window and classifies the network as `Low`, `Normal`, or
  `High` load (`CongestionLevel`).
- `update_congestion_and_adjust` (an explicit, separately-invoked function —
  not run automatically on every call) recomputes the level and, if it
  changed, **adjusts the global rate limit's `max_calls`** up or down by the
  configured `reduce_factor_bps` / `increase_factor_bps`, clamped to
  `[min_max_calls, max_max_calls]`.
- Congestion does not gate a call by itself — it only reshapes system #2's
  threshold, and only at the moments `update_congestion_and_adjust` is
  called (e.g. by an operator or an off-chain keeper on a schedule).

## Precedence order

For any single mutating call (e.g. `issue_credential`), the effective
checks — as they appear in `Self::require_not_paused` and the individual
entrypoints — run in this order:

1. **Circuit breaker auto-recovery check** — may flip `Degraded`/`Paused`
   back to `Normal` before anything else is evaluated.
2. **Circuit breaker `Paused` check** — hard stop, applies unconditionally
   to every address, including whitelisted issuers and admins.
3. **Circuit breaker `Degraded` write-limit check** — also unconditional;
   whitelisting an issuer for rate limiting does **not** exempt them from
   this cap.
4. **Rate limiting** (`require_rate_limit`) — per-address/per-issuer check,
   using whatever `max_calls` congestion throttling has most recently set.
   Whitelisted issuers skip this step entirely.
5. **Congestion throttling** is not a gate in this sequence — it only
   matters insofar as it already adjusted step 4's `max_calls` the last time
   `update_congestion_and_adjust` ran.

In short: **circuit breaker > rate limiting**, and **congestion only acts
through rate limiting's configuration, never as its own gate**.

### Worked examples

- *Contract is `Degraded`, congestion level is `Low`.* The degraded write
  cap (step 3) still applies. A prior `Low`-congestion adjustment may have
  raised `max_calls`, so more calls might pass rate limiting (step 4) before
  hitting the (unrelated) degraded-write cap.
- *An issuer is rate-limit-whitelisted, contract is `Degraded`.* The
  whitelist only bypasses step 4. Step 3's degraded write cap still applies
  to the whitelisted issuer's writes — whitelisting is not a circuit-breaker
  bypass.

## Reading all three systems at once

`get_throttling_status()` returns a `ThrottlingStatus` snapshot combining:

- circuit breaker state, active-activation details, degraded write limit and
  current degraded write count,
- the global rate-limit `max_calls`/`window_seconds`,
- the current congestion level and its full `CongestionConfig`.

This lets an operator or monitoring dashboard read the whole throttling
picture in one call instead of querying each system's individual getters
(`get_circuit_breaker_state`, `get_circuit_breaker_config`,
`get_rate_limit_config_pub`, `get_congestion_level`,
`get_congestion_config`, etc., which remain available individually).
