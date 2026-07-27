/**
 * Issue #1304: Adaptive Rate Limiting with Throttling
 *
 * Enhances the existing rate limiter with:
 * - Anomaly detection for unusual access patterns
 * - Temporary IP blacklisting
 * - Metrics on throttling effectiveness
 * - Path-based rate limit overrides
 *
 * This module complements (and re-exports) the base rate limiter.
 */

import { Request, Response, NextFunction } from 'express';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface AdaptiveRateLimitConfig {
  /** Time window for baseline rate (ms). */
  windowMs: number;
  /** Max requests per window before throttling. */
  max: number;
  /** Name for this limiter instance (used in metrics). */
  name: string;
  /** Exponential backoff multiplier on repeated violations. */
  backoffMultiplier: number;
  /** Violations before permanent block. */
  maxViolations: number;
  /** Anomaly detection: stddev multiplier over baseline to flag unusual traffic. */
  anomalyThreshold?: number;
  /** How long to temporarily blacklist an IP (ms). Default: 1 hour. */
  blacklistDurationMs?: number;
  /** Path-specific overrides. Key is a path prefix, value overrides max. */
  pathOverrides?: Record<string, number>;
}

export interface ThrottleMetrics {
  total_requests: number;
  blocked_requests: number;
  blacklisted_ips: number;
  active_violations: number;
  anomalies_detected: number;
  block_rate: number; // 0–1 fraction
}

interface TrafficEntry {
  count: number;
  windowResetTime: number;
  violations: number;
  backoffEndTime: number | null;
  permanentlyBlocked: boolean;
  blacklistedUntil: number | null;
  requestHistory: number[]; // timestamps of recent requests for anomaly detection
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function clientIp(req: Request): string {
  return String(req.ip ?? req.socket.remoteAddress ?? 'unknown');
}

function combinedKey(req: Request): string {
  const addr = req.headers['x-stellar-address'];
  if (typeof addr === 'string' && addr.length > 0) {
    return `user:${addr}`;
  }
  return `ip:${clientIp(req)}`;
}

/**
 * Calculate the request rate (requests/second) over the last N timestamps.
 */
function calculateRate(timestamps: number[], windowMs: number): number {
  const now = Date.now();
  const windowStart = now - windowMs;
  const recent = timestamps.filter((t) => t >= windowStart);
  return recent.length / (windowMs / 1000);
}

// ─── Adaptive Rate Limiter ────────────────────────────────────────────────────

export function createAdaptiveRateLimiter(config: AdaptiveRateLimitConfig) {
  const {
    windowMs,
    max,
    name,
    backoffMultiplier,
    maxViolations,
    anomalyThreshold = 3,
    blacklistDurationMs = 60 * 60 * 1000, // 1 hour
    pathOverrides = {},
  } = config;

  const store = new Map<string, TrafficEntry>();

  // Global metrics counters.
  let totalRequests = 0;
  let blockedRequests = 0;
  let anomaliesDetected = 0;

  // Trusted IPs bypass rate limiting (e.g., internal services).
  const trustedIps = new Set<string>(
    (process.env.TRUSTED_IPS ?? '').split(',').map((s) => s.trim()).filter(Boolean)
  );
  const trustedHeaderName = (process.env.TRUSTED_HEADER_NAME ?? 'x-internal-request').toLowerCase();
  const trustedHeaderValue = process.env.TRUSTED_HEADER_VALUE ?? '';

  function isTrusted(req: Request): boolean {
    const ip = clientIp(req);
    if (trustedIps.has(ip)) return true;
    if (trustedHeaderValue) {
      const header = req.headers[trustedHeaderName];
      if (header === trustedHeaderValue) return true;
    }
    return false;
  }

  /**
   * Resolve the effective max for a given request path.
   */
  function effectiveMax(path: string): number {
    for (const [prefix, limit] of Object.entries(pathOverrides)) {
      if (path.startsWith(prefix)) return limit;
    }
    return max;
  }

  /**
   * Detect anomalies: request rate significantly exceeds the configured baseline.
   */
  function isAnomaly(entry: TrafficEntry): boolean {
    if (entry.requestHistory.length < 5) return false; // not enough data
    const rate = calculateRate(entry.requestHistory, windowMs);
    const baseline = max / (windowMs / 1000);
    return rate > baseline * anomalyThreshold;
  }

  /**
   * Temporarily blacklist an IP.
   */
  function blacklist(key: string): void {
    let entry = store.get(key);
    if (!entry) {
      entry = {
        count: 0, windowResetTime: Date.now() + windowMs, violations: 0,
        backoffEndTime: null, permanentlyBlocked: false, blacklistedUntil: null, requestHistory: [],
      };
    }
    entry.blacklistedUntil = Date.now() + blacklistDurationMs;
    store.set(key, entry);
  }

  /**
   * Remove a key from the temporary blacklist (for recovery).
   */
  function unblacklist(key: string): void {
    const entry = store.get(key);
    if (entry) {
      entry.blacklistedUntil = null;
    }
  }

  /**
   * Core request check: returns whether the request is allowed.
   */
  function check(key: string, path: string): {
    allowed: boolean;
    remaining: number;
    resetTime: number;
    retryAfter: number | undefined;
    reason?: string;
  } {
    const now = Date.now();
    const limit = effectiveMax(path);

    let entry = store.get(key);
    if (!entry) {
      entry = {
        count: 1, windowResetTime: now + windowMs, violations: 0,
        backoffEndTime: null, permanentlyBlocked: false, blacklistedUntil: null,
        requestHistory: [now],
      };
      store.set(key, entry);
      return { allowed: true, remaining: limit - 1, resetTime: entry.windowResetTime, retryAfter: undefined };
    }

    // Record request for anomaly detection.
    entry.requestHistory.push(now);
    // Keep only the last 2 windows worth of history.
    const historyWindow = now - windowMs * 2;
    entry.requestHistory = entry.requestHistory.filter((t) => t >= historyWindow);

    // Permanent block.
    if (entry.permanentlyBlocked) {
      return { allowed: false, remaining: 0, resetTime: now + 3600000, retryAfter: 3600, reason: 'permanently_blocked' };
    }

    // Temporary blacklist.
    if (entry.blacklistedUntil !== null && now < entry.blacklistedUntil) {
      const retryAfter = Math.ceil((entry.blacklistedUntil - now) / 1000);
      return { allowed: false, remaining: 0, resetTime: entry.blacklistedUntil, retryAfter, reason: 'blacklisted' };
    }

    // Clear expired blacklist.
    if (entry.blacklistedUntil !== null && now >= entry.blacklistedUntil) {
      entry.blacklistedUntil = null;
    }

    // Active backoff period.
    if (entry.backoffEndTime !== null && now < entry.backoffEndTime) {
      const retryAfter = Math.ceil((entry.backoffEndTime - now) / 1000);
      return { allowed: false, remaining: 0, resetTime: entry.backoffEndTime, retryAfter, reason: 'backoff' };
    }

    // Window reset.
    if (now >= entry.windowResetTime) {
      entry.count = 0;
      entry.windowResetTime = now + windowMs;
      entry.backoffEndTime = null;
    }

    entry.count++;

    // Anomaly detection.
    if (isAnomaly(entry)) {
      anomaliesDetected++;
      // Trigger temporary blacklist for anomalous clients.
      entry.blacklistedUntil = now + blacklistDurationMs;
      entry.violations++;
      const retryAfter = Math.ceil(blacklistDurationMs / 1000);
      return { allowed: false, remaining: 0, resetTime: entry.blacklistedUntil, retryAfter, reason: 'anomaly_detected' };
    }

    // Rate limit exceeded.
    if (entry.count > limit) {
      entry.violations++;

      if (entry.violations >= maxViolations) {
        entry.permanentlyBlocked = true;
        return { allowed: false, remaining: 0, resetTime: now + 3600000, retryAfter: 3600, reason: 'permanently_blocked' };
      }

      const backoffMs = windowMs * Math.pow(backoffMultiplier, entry.violations - 1);
      entry.backoffEndTime = now + backoffMs;
      const retryAfter = Math.ceil(backoffMs / 1000);
      return { allowed: false, remaining: 0, resetTime: entry.backoffEndTime, retryAfter, reason: 'rate_limited' };
    }

    return { allowed: true, remaining: limit - entry.count, resetTime: entry.windowResetTime, retryAfter: undefined };
  }

  const middleware = (req: Request, res: Response, next: NextFunction): void => {
    totalRequests++;

    if (isTrusted(req)) {
      next();
      return;
    }

    const key = combinedKey(req);
    const result = check(key, req.path);
    const limit = effectiveMax(req.path);

    res.setHeader('X-RateLimit-Limit', String(limit));
    res.setHeader('X-RateLimit-Remaining', String(result.remaining));
    res.setHeader('X-RateLimit-Reset', String(Math.ceil(result.resetTime / 1000)));
    res.setHeader('X-RateLimit-Policy', name);

    if (!result.allowed) {
      blockedRequests++;
      if (result.retryAfter !== undefined) {
        res.setHeader('Retry-After', String(result.retryAfter));
      }
      res.status(429).json({
        error: 'Rate limit exceeded',
        reason: result.reason,
        message: `Too many requests (policy: ${name}). Retry after ${result.retryAfter ?? 0}s.`,
        retryAfter: result.retryAfter,
        limit,
        windowMs,
      });
      return;
    }

    next();
  };

  /** Get current throttling metrics. */
  middleware.getMetrics = (): ThrottleMetrics => {
    let blacklistedIps = 0;
    let activeViolations = 0;
    const now = Date.now();

    for (const entry of store.values()) {
      if (entry.blacklistedUntil !== null && now < entry.blacklistedUntil) blacklistedIps++;
      if (entry.violations > 0 && !entry.permanentlyBlocked) activeViolations++;
    }

    return {
      total_requests: totalRequests,
      blocked_requests: blockedRequests,
      blacklisted_ips: blacklistedIps,
      active_violations: activeViolations,
      anomalies_detected: anomaliesDetected,
      block_rate: totalRequests > 0 ? blockedRequests / totalRequests : 0,
    };
  };

  /** Manually blacklist a key. */
  middleware.blacklist = blacklist;

  /** Remove a key from the temporary blacklist. */
  middleware.unblacklist = unblacklist;

  /** Reset the store (for testing). */
  middleware.reset = () => {
    store.clear();
    totalRequests = 0;
    blockedRequests = 0;
    anomaliesDetected = 0;
  };

  middleware.store = store;
  middleware.limiterName = name;

  return middleware;
}
