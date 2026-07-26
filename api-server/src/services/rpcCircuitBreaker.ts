/**
 * Circuit breaker for outbound Soroban RPC calls (`simulateCall` in
 * ../soroban.ts).
 *
 * Unlike `webhookCircuitBreaker.ts` (binary closed/open, one trial call to
 * recover), RPC calls are on the hot path for every verification request,
 * so an all-or-nothing recovery risks re-tripping the breaker under load the
 * instant it reopens. This implements the classic three-state pattern:
 *
 *   CLOSED  --failureThreshold consecutive failures-->  OPEN
 *   OPEN    --resetTimeoutMs elapsed-->                  HALF_OPEN
 *   HALF_OPEN --halfOpenSuccessesToClose consecutive successes--> CLOSED
 *   HALF_OPEN --any failure-->                            OPEN (with backoff)
 *
 * In HALF_OPEN, only `halfOpenMaxConcurrentTrials` calls are allowed through
 * at a time (the rest fall back immediately) — this is the "gradual
 * recovery" piece: rather than slamming a just-recovered upstream with full
 * traffic, a small number of trial requests are let through, and the
 * breaker only fully closes after several of them succeed in a row. Each
 * reopen after a failed half-open trial doubles the reset timeout (capped
 * at maxResetTimeoutMs) so a flapping upstream backs off instead of being
 * retried every `resetTimeoutMs` indefinitely.
 */

export type CircuitState = 'closed' | 'open' | 'half-open';

export interface RpcCircuitBreakerConfig {
  /** Consecutive failures (while closed) before the breaker trips open. */
  failureThreshold: number;
  /** Base milliseconds an open breaker waits before allowing half-open trials. */
  resetTimeoutMs: number;
  /** Ceiling for the backed-off reset timeout after repeated half-open failures. */
  maxResetTimeoutMs: number;
  /** Consecutive half-open successes required to fully close the breaker. */
  halfOpenSuccessesToClose: number;
  /** Max number of trial calls let through concurrently while half-open. */
  halfOpenMaxConcurrentTrials: number;
  /** How long a successful result is retained for open-state fallback reads. */
  cacheTtlMs: number;
}

export const DEFAULT_RPC_CIRCUIT_BREAKER_CONFIG: RpcCircuitBreakerConfig = {
  failureThreshold: 5,
  resetTimeoutMs: 15_000,
  maxResetTimeoutMs: 5 * 60_000,
  halfOpenSuccessesToClose: 3,
  halfOpenMaxConcurrentTrials: 2,
  cacheTtlMs: 5 * 60_000,
};

export interface RpcCircuitBreakerMetrics {
  state: CircuitState;
  consecutiveFailures: number;
  consecutiveHalfOpenSuccesses: number;
  currentResetTimeoutMs: number;
  totalCalls: number;
  totalSuccesses: number;
  totalFailures: number;
  totalTrips: number;
  totalFallbackHits: number;
  totalRejected: number;
  lastStateChangeAt: string | null;
  lastFailureReason: string | null;
}

interface CacheEntry {
  value: unknown;
  cachedAt: number;
}

/** Thrown when a call is rejected outright (open, no cached fallback available). */
export class CircuitOpenError extends Error {
  constructor(message = 'circuit breaker open: RPC endpoint unavailable and no cached fallback') {
    super(message);
    this.name = 'CircuitOpenError';
  }
}

export class RpcCircuitBreaker {
  private readonly config: RpcCircuitBreakerConfig;
  private state: CircuitState = 'closed';
  private consecutiveFailures = 0;
  private consecutiveHalfOpenSuccesses = 0;
  private inFlightHalfOpenTrials = 0;
  private currentResetTimeoutMs: number;
  private openedAt = 0;
  private lastStateChangeAt: number | null = null;
  private lastFailureReason: string | null = null;
  private readonly cache = new Map<string, CacheEntry>();

  private totalCalls = 0;
  private totalSuccesses = 0;
  private totalFailures = 0;
  private totalTrips = 0;
  private totalFallbackHits = 0;
  private totalRejected = 0;

  constructor(config: Partial<RpcCircuitBreakerConfig> = {}) {
    this.config = { ...DEFAULT_RPC_CIRCUIT_BREAKER_CONFIG, ...config };
    this.currentResetTimeoutMs = this.config.resetTimeoutMs;
  }

  getState(): CircuitState {
    this.maybeTransitionToHalfOpen();
    return this.state;
  }

  getMetrics(): RpcCircuitBreakerMetrics {
    return {
      state: this.getState(),
      consecutiveFailures: this.consecutiveFailures,
      consecutiveHalfOpenSuccesses: this.consecutiveHalfOpenSuccesses,
      currentResetTimeoutMs: this.currentResetTimeoutMs,
      totalCalls: this.totalCalls,
      totalSuccesses: this.totalSuccesses,
      totalFailures: this.totalFailures,
      totalTrips: this.totalTrips,
      totalFallbackHits: this.totalFallbackHits,
      totalRejected: this.totalRejected,
      lastStateChangeAt: this.lastStateChangeAt ? new Date(this.lastStateChangeAt).toISOString() : null,
      lastFailureReason: this.lastFailureReason,
    };
  }

  /** Prometheus exposition for this breaker's state and counters. */
  getMetricsPrometheus(name = 'rpc'): string {
    const m = this.getMetrics();
    const stateValue = { closed: 0, 'half-open': 1, open: 2 }[m.state];
    const lines = [
      `# HELP quorumproof_${name}_circuit_breaker_state Current breaker state (0=closed, 1=half-open, 2=open)`,
      `# TYPE quorumproof_${name}_circuit_breaker_state gauge`,
      `quorumproof_${name}_circuit_breaker_state ${stateValue}`,
      `# HELP quorumproof_${name}_circuit_breaker_calls_total Total calls seen by the breaker`,
      `# TYPE quorumproof_${name}_circuit_breaker_calls_total counter`,
      `quorumproof_${name}_circuit_breaker_calls_total ${m.totalCalls}`,
      `# HELP quorumproof_${name}_circuit_breaker_failures_total Total failed calls`,
      `# TYPE quorumproof_${name}_circuit_breaker_failures_total counter`,
      `quorumproof_${name}_circuit_breaker_failures_total ${m.totalFailures}`,
      `# HELP quorumproof_${name}_circuit_breaker_trips_total Total times the breaker tripped open`,
      `# TYPE quorumproof_${name}_circuit_breaker_trips_total counter`,
      `quorumproof_${name}_circuit_breaker_trips_total ${m.totalTrips}`,
      `# HELP quorumproof_${name}_circuit_breaker_fallback_hits_total Total calls served from cached fallback while open`,
      `# TYPE quorumproof_${name}_circuit_breaker_fallback_hits_total counter`,
      `quorumproof_${name}_circuit_breaker_fallback_hits_total ${m.totalFallbackHits}`,
      `# HELP quorumproof_${name}_circuit_breaker_rejected_total Total calls rejected outright (open, no fallback)`,
      `# TYPE quorumproof_${name}_circuit_breaker_rejected_total counter`,
      `quorumproof_${name}_circuit_breaker_rejected_total ${m.totalRejected}`,
    ];
    return lines.join('\n') + '\n';
  }

  private maybeTransitionToHalfOpen(): void {
    if (this.state === 'open' && Date.now() - this.openedAt >= this.currentResetTimeoutMs) {
      this.state = 'half-open';
      this.consecutiveHalfOpenSuccesses = 0;
      this.inFlightHalfOpenTrials = 0;
      this.lastStateChangeAt = Date.now();
    }
  }

  private trip(reason: string, backoff: boolean): void {
    if (backoff && this.state === 'half-open') {
      this.currentResetTimeoutMs = Math.min(this.currentResetTimeoutMs * 2, this.config.maxResetTimeoutMs);
    } else {
      this.currentResetTimeoutMs = this.config.resetTimeoutMs;
    }
    this.state = 'open';
    this.openedAt = Date.now();
    this.lastStateChangeAt = this.openedAt;
    this.lastFailureReason = reason;
    this.totalTrips++;
  }

  private close(): void {
    this.state = 'closed';
    this.consecutiveFailures = 0;
    this.consecutiveHalfOpenSuccesses = 0;
    this.inFlightHalfOpenTrials = 0;
    this.currentResetTimeoutMs = this.config.resetTimeoutMs;
    this.lastStateChangeAt = Date.now();
  }

  private cacheKey(method: string, args: unknown[]): string {
    return `${method}:${JSON.stringify(args, (_k, v) => (typeof v === 'bigint' ? v.toString() : v))}`;
  }

  private readCache(key: string): { hit: boolean; value: unknown } {
    const entry = this.cache.get(key);
    if (!entry) return { hit: false, value: undefined };
    if (Date.now() - entry.cachedAt > this.config.cacheTtlMs) {
      this.cache.delete(key);
      return { hit: false, value: undefined };
    }
    return { hit: true, value: entry.value };
  }

  /**
   * Execute `fn` through the breaker. `cacheKeyParts`, when provided, both
   * seeds the fallback cache on success and is used to serve a cached value
   * when the breaker is open and no fresh call is attempted.
   */
  async execute<T>(fn: () => Promise<T>, cacheKeyParts?: { method: string; args: unknown[] }): Promise<T> {
    this.totalCalls++;
    const key = cacheKeyParts ? this.cacheKey(cacheKeyParts.method, cacheKeyParts.args) : undefined;
    const state = this.getState();

    if (state === 'open') {
      if (key) {
        const cached = this.readCache(key);
        if (cached.hit) {
          this.totalFallbackHits++;
          return cached.value as T;
        }
      }
      this.totalRejected++;
      throw new CircuitOpenError();
    }

    if (state === 'half-open') {
      if (this.inFlightHalfOpenTrials >= this.config.halfOpenMaxConcurrentTrials) {
        if (key) {
          const cached = this.readCache(key);
          if (cached.hit) {
            this.totalFallbackHits++;
            return cached.value as T;
          }
        }
        this.totalRejected++;
        throw new CircuitOpenError('circuit breaker half-open: trial slots full, no cached fallback');
      }
      this.inFlightHalfOpenTrials++;
    }

    try {
      const result = await fn();
      this.onSuccess(state, key, result);
      return result;
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      this.onFailure(state, reason);
      if (key) {
        const cached = this.readCache(key);
        if (cached.hit) {
          this.totalFallbackHits++;
          return cached.value as T;
        }
      }
      throw err;
    } finally {
      if (state === 'half-open') this.inFlightHalfOpenTrials--;
    }
  }

  private onSuccess(stateAtCallTime: CircuitState, key: string | undefined, result: unknown): void {
    this.totalSuccesses++;
    if (key) this.cache.set(key, { value: result, cachedAt: Date.now() });

    if (stateAtCallTime === 'closed') {
      this.consecutiveFailures = 0;
      return;
    }
    if (stateAtCallTime === 'half-open') {
      this.consecutiveHalfOpenSuccesses++;
      if (this.consecutiveHalfOpenSuccesses >= this.config.halfOpenSuccessesToClose) {
        this.close();
      }
    }
  }

  private onFailure(stateAtCallTime: CircuitState, reason: string): void {
    this.totalFailures++;
    this.lastFailureReason = reason;

    if (stateAtCallTime === 'half-open') {
      this.trip(reason, true);
      return;
    }
    this.consecutiveFailures++;
    if (this.consecutiveFailures >= this.config.failureThreshold) {
      this.trip(reason, false);
    }
  }

  /** Manually force the breaker open (e.g. an operator-initiated pause). */
  forceOpen(reason: string): void {
    this.trip(reason, false);
  }

  /** Manually force the breaker closed (e.g. after confirming the upstream recovered). */
  forceClose(): void {
    this.close();
  }

  /** Reset all state and counters — for testing only. */
  _resetForTest(): void {
    this.close();
    this.cache.clear();
    this.totalCalls = 0;
    this.totalSuccesses = 0;
    this.totalFailures = 0;
    this.totalTrips = 0;
    this.totalFallbackHits = 0;
    this.totalRejected = 0;
    this.lastFailureReason = null;
    this.lastStateChangeAt = null;
  }
}

let defaultRpcBreaker: RpcCircuitBreaker | undefined;

export function getDefaultRpcCircuitBreaker(): RpcCircuitBreaker {
  if (!defaultRpcBreaker) defaultRpcBreaker = new RpcCircuitBreaker();
  return defaultRpcBreaker;
}

/** Test-only: force the module to use a fresh breaker (e.g. with test-tuned config). */
export function _setDefaultRpcCircuitBreakerForTest(breaker: RpcCircuitBreaker | undefined): void {
  defaultRpcBreaker = breaker;
}
