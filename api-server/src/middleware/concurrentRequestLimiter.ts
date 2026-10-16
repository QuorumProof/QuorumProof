/**
 * #1566 — Concurrent Request Limiting Middleware
 *
 * Protects the API against resource exhaustion by capping the number of
 * requests that can be executing simultaneously.  Excess requests are queued
 * rather than rejected immediately, providing graceful degradation under load.
 *
 * Architecture
 * ────────────
 *   • A semaphore tracks available "slots" per endpoint group.
 *   • When all slots are taken, the incoming request is placed in a bounded
 *     FIFO queue and awaits release.
 *   • If the queue is also full, the request receives a 503 immediately.
 *   • Per-endpoint limits allow tight-coupling routes (e.g. ZK proof
 *     verification) to have lower concurrency ceilings than cheap routes.
 *
 * Configuration
 * ─────────────
 * Configured via environment variables with sane defaults:
 *   CONCURRENT_LIMIT_DEFAULT      – global default limit (default: 50)
 *   CONCURRENT_QUEUE_MAX          – max queue depth per group (default: 100)
 *   CONCURRENT_QUEUE_TIMEOUT_MS   – max wait in queue before 503 (default: 10000)
 *
 * Per-endpoint overrides are specified in the options object.
 *
 * Queue metrics
 * ─────────────
 * A `ConcurrentLimiterMetrics` snapshot is available via `getMetrics()` on
 * the middleware instance.  A Prometheus text exposition is provided by
 * `getMetricsPrometheus()`.
 */

import { Request, Response, NextFunction } from 'express';

// ── Semaphore ────────────────────────────────────────────────────────────────

interface QueueEntry {
  resolve: () => void;
  reject: (err: Error) => void;
  enqueuedAt: number;
  timeoutHandle: ReturnType<typeof setTimeout>;
}

class Semaphore {
  private _available: number;
  private readonly _max: number;
  private readonly _queue: QueueEntry[] = [];
  private readonly _queueMax: number;
  private readonly _queueTimeoutMs: number;

  // Metrics
  private _totalAcquired = 0;
  private _totalReleased = 0;
  private _totalQueued = 0;
  private _totalTimedOut = 0;
  private _totalRejected = 0;
  private _peakConcurrent = 0;
  private _peakQueueDepth = 0;

  constructor(max: number, queueMax: number, queueTimeoutMs: number) {
    this._max = max;
    this._available = max;
    this._queueMax = queueMax;
    this._queueTimeoutMs = queueTimeoutMs;
  }

  get currentConcurrent(): number {
    return this._max - this._available;
  }

  get currentQueueDepth(): number {
    return this._queue.length;
  }

  get maxConcurrent(): number {
    return this._max;
  }

  /**
   * Acquire a slot.  Returns a Promise that resolves when the slot is granted
   * and rejects if:
   *   • the queue is full (503-able: `reason === 'queue_full'`)
   *   • the entry waited too long in the queue (503-able: `reason === 'timeout'`)
   */
  acquire(): Promise<void> {
    if (this._available > 0) {
      this._available--;
      this._totalAcquired++;
      const current = this.currentConcurrent;
      if (current > this._peakConcurrent) this._peakConcurrent = current;
      return Promise.resolve();
    }

    // Queue is full — reject immediately.
    if (this._queue.length >= this._queueMax) {
      this._totalRejected++;
      return Promise.reject(Object.assign(new Error('Queue full'), { reason: 'queue_full' }));
    }

    // Enqueue the request.
    this._totalQueued++;
    const queueDepth = this._queue.length + 1;
    if (queueDepth > this._peakQueueDepth) this._peakQueueDepth = queueDepth;

    return new Promise<void>((resolve, reject) => {
      const entry: QueueEntry = {
        resolve,
        reject,
        enqueuedAt: Date.now(),
        timeoutHandle: setTimeout(() => {
          const idx = this._queue.indexOf(entry);
          if (idx !== -1) this._queue.splice(idx, 1);
          this._totalTimedOut++;
          reject(Object.assign(new Error('Queue timeout'), { reason: 'timeout' }));
        }, this._queueTimeoutMs),
      };
      this._queue.push(entry);
    });
  }

  /**
   * Release a slot.  If there are waiters in the queue the oldest one is
   * promoted immediately.
   */
  release(): void {
    this._totalReleased++;
    if (this._queue.length > 0) {
      const entry = this._queue.shift()!;
      clearTimeout(entry.timeoutHandle);
      this._totalAcquired++;
      const current = this.currentConcurrent;
      if (current > this._peakConcurrent) this._peakConcurrent = current;
      entry.resolve();
    } else {
      this._available++;
    }
  }

  getStats() {
    return {
      maxConcurrent: this._max,
      currentConcurrent: this.currentConcurrent,
      currentQueueDepth: this._queue.length,
      peakConcurrent: this._peakConcurrent,
      peakQueueDepth: this._peakQueueDepth,
      totalAcquired: this._totalAcquired,
      totalReleased: this._totalReleased,
      totalQueued: this._totalQueued,
      totalTimedOut: this._totalTimedOut,
      totalRejected: this._totalRejected,
    };
  }

  resetStats(): void {
    this._totalAcquired = 0;
    this._totalReleased = 0;
    this._totalQueued = 0;
    this._totalTimedOut = 0;
    this._totalRejected = 0;
    this._peakConcurrent = 0;
    this._peakQueueDepth = 0;
  }
}

// ── Configuration types ──────────────────────────────────────────────────────

export interface EndpointLimitConfig {
  /** Maximum concurrent requests for this endpoint group. */
  maxConcurrent: number;
  /**
   * Maximum number of requests to hold in queue while waiting for a slot.
   * Defaults to the global queueMax.
   */
  queueMax?: number;
  /**
   * Maximum time (ms) a request spends in the queue before receiving a 503.
   * Defaults to the global queueTimeoutMs.
   */
  queueTimeoutMs?: number;
}

export interface ConcurrentRequestLimiterOptions {
  /** Default concurrency limit applied when no per-endpoint override matches. */
  defaultMaxConcurrent?: number;
  /** Default max queue depth. */
  defaultQueueMax?: number;
  /** Default queue timeout in ms. */
  defaultQueueTimeoutMs?: number;
  /**
   * Per-endpoint overrides.  The key is a path prefix that the request URL
   * must start with (e.g. `/api/verify`).  The most-specific matching prefix
   * wins (longest match).
   */
  endpoints?: Record<string, EndpointLimitConfig>;
}

// ── Metrics types ────────────────────────────────────────────────────────────

export interface EndpointGroupMetrics {
  group: string;
  maxConcurrent: number;
  currentConcurrent: number;
  currentQueueDepth: number;
  peakConcurrent: number;
  peakQueueDepth: number;
  totalAcquired: number;
  totalReleased: number;
  totalQueued: number;
  totalTimedOut: number;
  totalRejected: number;
}

export interface ConcurrentLimiterMetrics {
  groups: EndpointGroupMetrics[];
}

// ── Middleware factory ───────────────────────────────────────────────────────

export interface ConcurrentRequestLimiter {
  /** Express middleware function. */
  middleware: (req: Request, res: Response, next: NextFunction) => void;
  /** Returns a snapshot of per-group metrics. */
  getMetrics(): ConcurrentLimiterMetrics;
  /** Returns a Prometheus-compatible text exposition of metrics. */
  getMetricsPrometheus(): string;
  /** Reset all per-group counters (useful for tests). */
  resetStats(): void;
}

/**
 * Create a concurrent request limiter.
 *
 * ```ts
 * const limiter = createConcurrentRequestLimiter({
 *   defaultMaxConcurrent: 50,
 *   endpoints: {
 *     '/api/verify': { maxConcurrent: 10 },
 *     '/api/credentials': { maxConcurrent: 30 },
 *   },
 * });
 * app.use(limiter.middleware);
 * app.get('/metrics/concurrent', (_req, res) => {
 *   res.set('Content-Type', 'text/plain');
 *   res.send(limiter.getMetricsPrometheus());
 * });
 * ```
 */
export function createConcurrentRequestLimiter(
  opts: ConcurrentRequestLimiterOptions = {},
): ConcurrentRequestLimiter {
  const defaultMax = opts.defaultMaxConcurrent
    ?? parseInt(process.env.CONCURRENT_LIMIT_DEFAULT ?? '50', 10);
  const defaultQueueMax = opts.defaultQueueMax
    ?? parseInt(process.env.CONCURRENT_QUEUE_MAX ?? '100', 10);
  const defaultQueueTimeoutMs = opts.defaultQueueTimeoutMs
    ?? parseInt(process.env.CONCURRENT_QUEUE_TIMEOUT_MS ?? '10000', 10);

  // Build a map of endpoint-prefix → Semaphore, sorted longest-first so the
  // most-specific prefix wins.
  const endpointEntries: Array<{ prefix: string; semaphore: Semaphore }> = [];
  if (opts.endpoints) {
    for (const [prefix, cfg] of Object.entries(opts.endpoints)) {
      endpointEntries.push({
        prefix,
        semaphore: new Semaphore(
          cfg.maxConcurrent,
          cfg.queueMax ?? defaultQueueMax,
          cfg.queueTimeoutMs ?? defaultQueueTimeoutMs,
        ),
      });
    }
    // Longest prefix first → most-specific match wins.
    endpointEntries.sort((a, b) => b.prefix.length - a.prefix.length);
  }

  // Default semaphore for unmatched paths.
  const defaultSemaphore = new Semaphore(defaultMax, defaultQueueMax, defaultQueueTimeoutMs);

  function resolveSemaphore(path: string): { semaphore: Semaphore; group: string } {
    for (const entry of endpointEntries) {
      if (path.startsWith(entry.prefix)) {
        return { semaphore: entry.semaphore, group: entry.prefix };
      }
    }
    return { semaphore: defaultSemaphore, group: '__default__' };
  }

  const middleware = (req: Request, res: Response, next: NextFunction): void => {
    const { semaphore } = resolveSemaphore(req.path);

    semaphore.acquire().then(
      () => {
        // Release the slot when the response finishes (whether success, error,
        // or client disconnect).
        res.on('finish', () => semaphore.release());
        res.on('close', () => {
          // 'close' fires on client disconnect before 'finish'; guard against
          // double-release by checking if release was already counted.
          if (!res.writableEnded) semaphore.release();
        });
        next();
      },
      (err: Error & { reason?: string }) => {
        const isTimeout = err.reason === 'timeout';
        const retryAfterSec = Math.ceil(defaultQueueTimeoutMs / 1000);

        res.set('Retry-After', String(retryAfterSec));
        res.status(503).json({
          error: isTimeout
            ? 'Server busy — request timed out in queue'
            : 'Server busy — concurrent request limit reached',
          retry_after_seconds: retryAfterSec,
          current_concurrent: semaphore.currentConcurrent,
          queue_depth: semaphore.currentQueueDepth,
        });
      },
    );
  };

  function getMetrics(): ConcurrentLimiterMetrics {
    const groups: EndpointGroupMetrics[] = endpointEntries.map(({ prefix, semaphore: s }) => ({
      group: prefix,
      ...s.getStats(),
    }));
    groups.push({ group: '__default__', ...defaultSemaphore.getStats() });
    return { groups };
  }

  function getMetricsPrometheus(): string {
    const lines: string[] = [
      '# HELP quorumproof_concurrent_requests Current number of requests being processed.',
      '# TYPE quorumproof_concurrent_requests gauge',
      '# HELP quorumproof_concurrent_queue_depth Current number of requests waiting in queue.',
      '# TYPE quorumproof_concurrent_queue_depth gauge',
      '# HELP quorumproof_concurrent_requests_total Total requests that entered processing.',
      '# TYPE quorumproof_concurrent_requests_total counter',
      '# HELP quorumproof_concurrent_queued_total Total requests that were queued.',
      '# TYPE quorumproof_concurrent_queued_total counter',
      '# HELP quorumproof_concurrent_timeout_total Total requests that timed out in queue.',
      '# TYPE quorumproof_concurrent_timeout_total counter',
      '# HELP quorumproof_concurrent_rejected_total Total requests rejected (queue full).',
      '# TYPE quorumproof_concurrent_rejected_total counter',
    ];

    const { groups } = getMetrics();
    for (const g of groups) {
      const lbl = `group="${g.group}"`;
      lines.push(`quorumproof_concurrent_requests{${lbl}} ${g.currentConcurrent}`);
      lines.push(`quorumproof_concurrent_queue_depth{${lbl}} ${g.currentQueueDepth}`);
      lines.push(`quorumproof_concurrent_requests_total{${lbl}} ${g.totalAcquired}`);
      lines.push(`quorumproof_concurrent_queued_total{${lbl}} ${g.totalQueued}`);
      lines.push(`quorumproof_concurrent_timeout_total{${lbl}} ${g.totalTimedOut}`);
      lines.push(`quorumproof_concurrent_rejected_total{${lbl}} ${g.totalRejected}`);
    }
    return lines.join('\n') + '\n';
  }

  function resetStats(): void {
    for (const { semaphore: s } of endpointEntries) s.resetStats();
    defaultSemaphore.resetStats();
  }

  return { middleware, getMetrics, getMetricsPrometheus, resetStats };
}

// ── Singleton ────────────────────────────────────────────────────────────────

let _default: ConcurrentRequestLimiter | null = null;

/**
 * Return the default concurrent request limiter configured from environment
 * variables and the built-in per-endpoint limits.
 *
 * Endpoint limits (tuned for QuorumProof workloads):
 *   /api/verify     — ZK proof verification is CPU-heavy → tight limit
 *   /api/credentials — mix of reads/writes → medium limit
 *   /api/analytics  — read-heavy but can be bursty → medium limit
 */
export function getDefaultConcurrentRequestLimiter(): ConcurrentRequestLimiter {
  if (!_default) {
    _default = createConcurrentRequestLimiter({
      defaultMaxConcurrent: parseInt(process.env.CONCURRENT_LIMIT_DEFAULT ?? '50', 10),
      defaultQueueMax: parseInt(process.env.CONCURRENT_QUEUE_MAX ?? '100', 10),
      defaultQueueTimeoutMs: parseInt(process.env.CONCURRENT_QUEUE_TIMEOUT_MS ?? '10000', 10),
      endpoints: {
        '/api/verify': {
          maxConcurrent: parseInt(process.env.CONCURRENT_LIMIT_VERIFY ?? '10', 10),
        },
        '/api/credentials': {
          maxConcurrent: parseInt(process.env.CONCURRENT_LIMIT_CREDENTIALS ?? '30', 10),
        },
        '/api/analytics': {
          maxConcurrent: parseInt(process.env.CONCURRENT_LIMIT_ANALYTICS ?? '20', 10),
        },
      },
    });
  }
  return _default;
}

/** Replace the singleton (for testing). */
export function _setDefaultConcurrentRequestLimiterForTest(
  limiter: ConcurrentRequestLimiter | null,
): void {
  _default = limiter;
}
