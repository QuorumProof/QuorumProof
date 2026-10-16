import { Request, Response, NextFunction } from 'express';

export interface RateLimitConfig {
  windowMs: number;
  max: number;
  name: string;
  backoffMultiplier: number;
  maxViolations: number;
}

interface RateLimitEntry {
  count: number;
  windowResetTime: number;
  violations: number;
  backoffEndTime: number | null;
  permanentlyBlocked: boolean;
}

export type KeyFn = (req: Request) => string;

function clientIp(req: Request): string {
  return (req.ip ?? req.socket.remoteAddress ?? 'unknown');
}

export function ipKey(req: Request): string {
  return `ip:${clientIp(req)}`;
}

export function userKey(req: Request): string | null {
  const addr = req.headers['x-stellar-address'];
  if (typeof addr === 'string' && addr.length > 0) {
    return `user:${addr}`;
  }
  return null;
}

export function combinedKey(req: Request): string {
  const user = userKey(req);
  if (user) return user;
  return ipKey(req);
}

interface CheckResult {
  allowed: boolean;
  remaining: number;
  resetTime: number;
  retryAfter: number | undefined;
}

export function createRateLimiter(config: RateLimitConfig, keyFn: KeyFn = combinedKey) {
  const store = new Map<string, RateLimitEntry>();

  const trustedIps = new Set<string>(
    (process.env.TRUSTED_IPS ?? '').split(',').map((s) => s.trim()).filter(Boolean)
  );
  const trustedHeaderName = process.env.TRUSTED_HEADER_NAME ?? 'x-internal-request';
  const trustedHeaderValue = process.env.TRUSTED_HEADER_VALUE ?? '';

  function isTrusted(req: Request): boolean {
    const ip = clientIp(req);
    if (trustedIps.has(ip)) return true;
    if (trustedHeaderValue) {
      const header = req.headers[trustedHeaderName.toLowerCase()];
      if (header === trustedHeaderValue) return true;
    }
    return false;
  }

  function check(key: string): CheckResult {
    const now = Date.now();
    let entry = store.get(key);

    if (!entry) {
      entry = {
        count: 1,
        windowResetTime: now + config.windowMs,
        violations: 0,
        backoffEndTime: null,
        permanentlyBlocked: false,
      };
      store.set(key, entry);
      return { allowed: true, remaining: config.max - 1, resetTime: entry.windowResetTime, retryAfter: undefined };
    }

    if (entry.permanentlyBlocked) {
      return { allowed: false, remaining: 0, resetTime: Date.now() + 3600000, retryAfter: 3600 };
    }

    // If in backoff and still within backoff period
    if (entry.backoffEndTime !== null && now < entry.backoffEndTime) {
      const retryAfter = Math.ceil((entry.backoffEndTime - now) / 1000);
      return { allowed: false, remaining: 0, resetTime: entry.backoffEndTime, retryAfter };
    }

    // Backoff expired or no backoff - check if window expired
    if (now >= entry.windowResetTime) {
      entry.count = 0;
      entry.windowResetTime = now + config.windowMs;
      entry.backoffEndTime = null;
    }

    entry.count++;

    if (entry.count > config.max) {
      entry.violations++;

      if (entry.violations >= config.maxViolations) {
        entry.permanentlyBlocked = true;
        return { allowed: false, remaining: 0, resetTime: Date.now() + 3600000, retryAfter: 3600 };
      }

      const backoffMs = config.windowMs * Math.pow(config.backoffMultiplier, entry.violations - 1);
      entry.backoffEndTime = now + backoffMs;
      const retryAfter = Math.ceil(backoffMs / 1000);

      return { allowed: false, remaining: 0, resetTime: entry.backoffEndTime, retryAfter };
    }

    return { allowed: true, remaining: config.max - entry.count, resetTime: entry.windowResetTime, retryAfter: undefined };
  }

  const middleware = (req: Request, res: Response, next: NextFunction): void => {
    if (isTrusted(req)) {
      next();
      return;
    }

    const key = keyFn(req);
    const result = check(key);

    res.setHeader('X-RateLimit-Limit', String(config.max));
    res.setHeader('X-RateLimit-Remaining', String(result.remaining));
    res.setHeader('X-RateLimit-Reset', String(Math.ceil(result.resetTime / 1000)));

    if (!result.allowed) {
      if (result.retryAfter !== undefined) {
        res.setHeader('Retry-After', String(result.retryAfter));
      }
      res.status(429).json({
        error: 'Rate limit exceeded',
        message: `Too many requests. Limit: ${config.max} per ${config.windowMs / 1000}s.${result.retryAfter ? ` Retry after ${result.retryAfter}s.` : ''}`,
        retryAfter: result.retryAfter,
        limit: config.max,
        windowMs: config.windowMs,
      });
      return;
    }

    next();
  };

  middleware.reset = () => store.clear();
  middleware.store = store;

  return middleware;
}

export interface ConcurrencyLimitConfig {
  /** Maximum number of requests allowed to be in-flight at once. */
  maxConcurrent: number;
  /** Maximum number of requests allowed to wait in the queue before rejecting. */
  maxQueue: number;
  /** Maximum time (ms) a request may wait in the queue before being rejected. */
  queueTimeoutMs: number;
  /** Optional per-endpoint overrides keyed by `${method} ${path}` or by path. */
  perEndpoint?: Record<string, Partial<Omit<ConcurrencyLimitConfig, 'perEndpoint'>>>;
  /** Name used for metrics/logging. */
  name: string;
}

export interface ConcurrencyMetrics {
  name: string;
  active: number;
  queued: number;
  maxConcurrent: number;
  maxQueue: number;
  totalProcessed: number;
  totalQueued: number;
  totalRejected: number;
  totalTimedOut: number;
  totalWaitMs: number;
  averageWaitMs: number;
}

interface EndpointState {
  active: number;
  queue: Array<() => void>;
  totalProcessed: number;
  totalQueued: number;
  totalRejected: number;
  totalTimedOut: number;
  totalWaitMs: number;
}

function endpointKey(req: Request): string {
  const path = req.route?.path ?? req.path ?? req.url;
  return `${req.method} ${path}`;
}

function resolveLimits(
  config: ConcurrencyLimitConfig,
  req: Request
): { maxConcurrent: number; maxQueue: number; queueTimeoutMs: number } {
  const overrides = config.perEndpoint ?? {};
  const key = endpointKey(req);
  const override = overrides[key] ?? overrides[req.path] ?? overrides[req.url];
  return {
    maxConcurrent: override?.maxConcurrent ?? config.maxConcurrent,
    maxQueue: override?.maxQueue ?? config.maxQueue,
    queueTimeoutMs: override?.queueTimeoutMs ?? config.queueTimeoutMs,
  };
}

/**
 * Semaphore-based concurrency limiter. When the in-flight limit is reached,
 * requests are queued (graceful degradation) up to `maxQueue`; queued requests
 * that exceed `queueTimeoutMs` are rejected with 503.
 */
export function createConcurrencyLimiter(config: ConcurrencyLimitConfig) {
  const states = new Map<string, EndpointState>();

  function getState(key: string): EndpointState {
    let state = states.get(key);
    if (!state) {
      state = {
        active: 0,
        queue: [],
        totalProcessed: 0,
        totalQueued: 0,
        totalRejected: 0,
        totalTimedOut: 0,
        totalWaitMs: 0,
      };
      states.set(key, state);
    }
    return state;
  }

  function release(state: EndpointState): void {
    state.active--;
    state.totalProcessed++;
    const next = state.queue.shift();
    if (next) {
      state.active++;
      next();
    }
  }

  const middleware = (req: Request, res: Response, next: NextFunction): void => {
    const limits = resolveLimits(config, req);
    const state = getState(endpointKey(req));

    res.setHeader('X-Concurrency-Limit', String(limits.maxConcurrent));

    if (state.active < limits.maxConcurrent) {
      state.active++;
      res.setHeader('X-Concurrency-Active', String(state.active));
      res.setHeader('X-Concurrency-Queued', String(state.queue.length));
      let released = false;
      const done = () => {
        if (released) return;
        released = true;
        release(state);
      };
      res.on('finish', done);
      res.on('close', done);
      next();
      return;
    }

    if (state.queue.length >= limits.maxQueue) {
      state.totalRejected++;
      res.setHeader('Retry-After', '1');
      res.status(503).json({
        error: 'Server busy',
        message: `Concurrency limit reached (${limits.maxConcurrent}). Queue is full.`,
        limit: limits.maxConcurrent,
        queue: state.queue.length,
      });
      return;
    }

    const enqueuedAt = Date.now();
    state.totalQueued++;
    res.setHeader('X-Concurrency-Queued', String(state.queue.length + 1));

    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      const idx = state.queue.indexOf(admit);
      if (idx !== -1) state.queue.splice(idx, 1);
      state.totalTimedOut++;
      res.setHeader('Retry-After', '1');
      res.status(503).json({
        error: 'Server busy',
        message: `Request timed out waiting for a concurrency slot after ${limits.queueTimeoutMs}ms.`,
        limit: limits.maxConcurrent,
        queueTimeoutMs: limits.queueTimeoutMs,
      });
    }, limits.queueTimeoutMs);

    const admit = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      state.totalWaitMs += Date.now() - enqueuedAt;
      res.setHeader('X-Concurrency-Active', String(state.active));
      res.setHeader('X-Concurrency-Queued', String(state.queue.length));
      let released = false;
      const done = () => {
        if (released) return;
        released = true;
        release(state);
      };
      res.on('finish', done);
      res.on('close', done);
      next();
    };

    state.queue.push(admit);
  };

  middleware.metrics = (): ConcurrencyMetrics[] => {
    const result: ConcurrencyMetrics[] = [];
    for (const [key, state] of states.entries()) {
      result.push({
        name: `${config.name}:${key}`,
        active: state.active,
        queued: state.queue.length,
        maxConcurrent: config.maxConcurrent,
        maxQueue: config.maxQueue,
        totalProcessed: state.totalProcessed,
        totalQueued: state.totalQueued,
        totalRejected: state.totalRejected,
        totalTimedOut: state.totalTimedOut,
        totalWaitMs: state.totalWaitMs,
        averageWaitMs: state.totalProcessed > 0 ? state.totalWaitMs / state.totalProcessed : 0,
      });
    }
    return result;
  };

  middleware.reset = () => states.clear();
  middleware.states = states;

  return middleware;
}
