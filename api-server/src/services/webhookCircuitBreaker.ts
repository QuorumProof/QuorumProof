/**
 * Per-endpoint circuit breaker for webhook delivery.
 *
 * This is a direct port of the operational pattern established in
 * contracts/quorum_proof/src/circuit_breaker.rs: a persisted config, a
 * persisted "activation" record describing the current trip (state, reason,
 * timestamps), a TTL-driven `checkAndRecover` that flips the breaker back
 * open for business once its reset timeout has elapsed, and a
 * `getStateWithRecovery` wrapper that call sites use instead of touching
 * state directly. The Rust contract has three states (Normal/Degraded/Paused)
 * because it distinguishes "throttle writes" from "stop entirely"; an HTTP
 * delivery breaker only needs the binary distinction, so this uses the
 * conventional 'closed' (deliver normally) / 'open' (fail fast, skip the
 * network call) states. Recovery from 'open' is a single trial delivery
 * (classic half-open behavior) rather than a third persisted state — if that
 * trial fails, `recordFailure` re-trips the breaker and extends the timeout;
 * if it succeeds, `recordSuccess` closes it.
 */
import path from 'path';
import { DurableLog } from './durableLog.js';

export type CircuitBreakerState = 'closed' | 'open';

export interface CircuitBreakerConfig {
  /** Consecutive failures before the breaker trips open. */
  failureThreshold: number;
  /** Milliseconds before an open breaker allows a half-open trial. */
  resetTimeoutMs: number;
  /** Whether the breaker auto-recovers after resetTimeoutMs, vs. staying open until manually resumed. */
  autoRecover: boolean;
}

export const DEFAULT_CIRCUIT_BREAKER_CONFIG: CircuitBreakerConfig = {
  failureThreshold: 5,
  resetTimeoutMs: 60_000,
  autoRecover: true,
};

export interface CircuitBreakerActivation {
  state: 'open';
  trippedAt: string;
  reason: string;
  autoRecoverAt: string;
  consecutiveFailures: number;
}

interface CircuitBreakerRecord {
  state: CircuitBreakerState;
  activation?: CircuitBreakerActivation;
  consecutiveFailures: number;
}

export interface CircuitBreakerOptions {
  dataDir?: string;
  config?: Partial<CircuitBreakerConfig>;
}

/** Durable, per-endpoint circuit breaker — one record per webhook registration id. */
export class WebhookCircuitBreaker {
  readonly dataDir: string;
  private readonly log: DurableLog<CircuitBreakerRecord>;
  private readonly config: CircuitBreakerConfig;

  constructor(options: CircuitBreakerOptions = {}) {
    const dataDir =
      options.dataDir ?? process.env.WEBHOOK_STORE_DATA_DIR ?? path.join(process.cwd(), '.data', 'webhooks');
    this.dataDir = dataDir;
    this.log = new DurableLog<CircuitBreakerRecord>(path.join(dataDir, 'circuit-breaker.jsonl'));
    this.config = { ...DEFAULT_CIRCUIT_BREAKER_CONFIG, ...options.config };
  }

  private getRecord(endpointId: string): CircuitBreakerRecord {
    return this.log.get(endpointId) ?? { state: 'closed', consecutiveFailures: 0 };
  }

  private setRecord(endpointId: string, record: CircuitBreakerRecord): void {
    this.log.set(endpointId, record);
  }

  getConfig(): CircuitBreakerConfig {
    return { ...this.config };
  }

  /** Raw current state — no TTL recovery check. Prefer getStateWithRecovery for delivery decisions. */
  getState(endpointId: string): CircuitBreakerState {
    return this.getRecord(endpointId).state;
  }

  getActivation(endpointId: string): CircuitBreakerActivation | undefined {
    return this.getRecord(endpointId).activation;
  }

  /** Trip the breaker open. Mirrors emergency_pause in the Rust contract. */
  trip(endpointId: string, reason: string): void {
    const record = this.getRecord(endpointId);
    const now = Date.now();
    const activation: CircuitBreakerActivation = {
      state: 'open',
      trippedAt: new Date(now).toISOString(),
      reason,
      autoRecoverAt: new Date(now + this.config.resetTimeoutMs).toISOString(),
      consecutiveFailures: record.consecutiveFailures,
    };
    this.setRecord(endpointId, { state: 'open', activation, consecutiveFailures: record.consecutiveFailures });
  }

  /** Manually reset the breaker to closed. Mirrors resume in the Rust contract. */
  resume(endpointId: string): void {
    this.setRecord(endpointId, { state: 'closed', consecutiveFailures: 0 });
  }

  /** TTL-based auto-recovery, mirroring check_and_recover. Call before every delivery decision. */
  checkAndRecover(endpointId: string): void {
    if (!this.config.autoRecover) return;
    const record = this.getRecord(endpointId);
    if (record.state !== 'open' || !record.activation) return;

    if (Date.now() >= Date.parse(record.activation.autoRecoverAt)) {
      // Half-open trial: close the breaker but keep the failure count at the
      // threshold boundary reset to 0 so the very next call is a clean trial.
      this.setRecord(endpointId, { state: 'closed', consecutiveFailures: 0 });
    }
  }

  /** Mirrors get_state_with_recovery: check TTL, then report state. */
  getStateWithRecovery(endpointId: string): CircuitBreakerState {
    this.checkAndRecover(endpointId);
    return this.getState(endpointId);
  }

  /** Reset the consecutive-failure counter; close the breaker if it was open. */
  recordSuccess(endpointId: string): void {
    this.setRecord(endpointId, { state: 'closed', consecutiveFailures: 0 });
  }

  /** Increment the consecutive-failure counter; trip if it reaches the threshold. */
  recordFailure(endpointId: string, reason: string): void {
    const record = this.getRecord(endpointId);
    const consecutiveFailures = record.consecutiveFailures + 1;
    if (consecutiveFailures >= this.config.failureThreshold) {
      this.trip(endpointId, reason);
      return;
    }
    this.setRecord(endpointId, { state: 'closed', consecutiveFailures });
  }

  /** Reset state — for testing only. */
  _resetForTest(): void {
    for (const key of this.log.keys()) this.log.delete(key);
  }
}

let defaultBreaker: WebhookCircuitBreaker | undefined;

export function getDefaultCircuitBreaker(): WebhookCircuitBreaker {
  if (!defaultBreaker) defaultBreaker = new WebhookCircuitBreaker();
  return defaultBreaker;
}

/** Test-only: force the module to construct a fresh default breaker (e.g. pointed at a new dataDir). */
export function _setDefaultCircuitBreakerForTest(breaker: WebhookCircuitBreaker | undefined): void {
  defaultBreaker = breaker;
}
