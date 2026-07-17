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
