/**
 * #1314 — Caching Headers and ETag Support
 *
 * Middleware that:
 *  1. Sets a sensible Cache-Control header on GET responses (unless the route
 *     already set one).
 *  2. Generates a deterministic ETag for every GET response body and checks
 *     the If-None-Match request header, returning 304 Not Modified when the
 *     resource has not changed.
 *  3. Exposes per-endpoint Cache-Control overrides via `cacheStrategy()`, so
 *     individual routes can opt into immutable, no-store, or custom max-age
 *     values without touching shared middleware.
 *
 * Caching strategy per endpoint class:
 *
 *   /api/credentials/*     private, max-age=30, must-revalidate
 *   /api/slices/*          private, max-age=60, must-revalidate
 *   /api/attestors/*       public,  max-age=300, stale-while-revalidate=60
 *   /api/verify/*          no-store (verification results must never be cached)
 *   /api/analytics/*       private, max-age=120, must-revalidate
 *   /health                public,  max-age=10
 *   everything else        private, max-age=30, must-revalidate  (default)
 *
 * ETag format: W/"<sha256-hex-prefix-16>"
 * The weak ETag prefix ("W/") signals that two representations are semantically
 * equivalent (same body) but may not be byte-for-byte identical, which is
 * correct here because we don't track byte-level headers like Content-Encoding.
 *
 * 304 handling:
 *   When If-None-Match matches the computed ETag the middleware:
 *     - responds with 304 (no body)
 *     - still sets Cache-Control and ETag so the client can update its cache
 *     - skips the route handler entirely (calls res.end() after setting headers)
 */

import { createHash } from 'crypto';
import { Request, Response, NextFunction } from 'express';

// ── Cache-Control strategy map ────────────────────────────────────────────────

interface CacheStrategy {
  value: string;
  /** Should we generate / check ETags for this strategy? */
  etag: boolean;
}

const PATH_STRATEGIES: Array<{ prefix: string; strategy: CacheStrategy }> = [
  // Verification results must never be cached — they carry real-time trust
  // decisions that could be stale if the credential is revoked.
  { prefix: '/api/verify', strategy: { value: 'no-store', etag: false } },

  // Attestor registry changes infrequently; public CDN caching is acceptable.
  {
    prefix: '/api/attestors',
    strategy: { value: 'public, max-age=300, stale-while-revalidate=60', etag: true },
  },

  // Analytics data is user-scoped and changes every few minutes.
  { prefix: '/api/analytics', strategy: { value: 'private, max-age=120, must-revalidate', etag: true } },

  // Slice data is moderately stable.
  { prefix: '/api/slices', strategy: { value: 'private, max-age=60, must-revalidate', etag: true } },

  // Credentials are sensitive — keep private and short-lived.
  { prefix: '/api/credentials', strategy: { value: 'private, max-age=30, must-revalidate', etag: true } },

  // Health endpoint — very short public cache for load-balancer checks.
  { prefix: '/health', strategy: { value: 'public, max-age=10', etag: false } },
];

const DEFAULT_STRATEGY: CacheStrategy = {
  value: 'private, max-age=30, must-revalidate',
  etag: true,
};

function strategyFor(path: string): CacheStrategy {
  for (const { prefix, strategy } of PATH_STRATEGIES) {
    if (path.startsWith(prefix)) return strategy;
  }
  return DEFAULT_STRATEGY;
}

// ── ETag generation ───────────────────────────────────────────────────────────

/**
 * Compute a weak ETag for `body`.
 * Uses the first 16 hex characters of a SHA-256 digest — short enough to
 * keep headers small while virtually eliminating collision probability for
 * typical API response sizes.
 */
export function computeETag(body: string | Buffer): string {
  const hash = createHash('sha256')
    .update(typeof body === 'string' ? body : body)
    .digest('hex')
    .slice(0, 16);
  return `W/"${hash}"`;
}

// ── Route-level override helper ───────────────────────────────────────────────

/**
 * Express middleware factory for per-route cache strategy overrides.
 *
 * Usage:
 *   router.get('/expensive', cacheStrategy('public, max-age=3600, immutable'), handler);
 */
export function cacheStrategy(value: string): (req: Request, res: Response, next: NextFunction) => void {
  return (_req: Request, res: Response, next: NextFunction) => {
    res.setHeader('Cache-Control', value);
    next();
  };
}

// ── Main middleware ────────────────────────────────────────────────────────────

/**
 * Apply Cache-Control, ETag, and 304 Not Modified handling to all GET responses.
 *
 * This replaces the simpler one-liner that existed before #1314. The old
 * single-constant `CACHE_CONTROL_VALUE` is gone; strategy selection is now
 * path-based (see `strategyFor()` above).
 */
export function cacheControl(req: Request, res: Response, next: NextFunction): void {
  // For non-GET/HEAD requests: strip any ETag that Express's built-in etag
  // generator might have set and move on — we don't cache mutations.
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    const originalEnd = res.end.bind(res);
    let cleared = false;
    (res.end as Function) = function clearETagOnMutation(
      chunk?: unknown,
      encodingOrCb?: unknown,
      cb?: () => void,
    ): Response {
      if (!cleared) {
        cleared = true;
        res.removeHeader('ETag');
      }
      return originalEnd(chunk, encodingOrCb as BufferEncoding, cb);
    };
    next();
    return;
  }

  const strategy = strategyFor(req.path);

  // Set Cache-Control unless the route already provided one.
  if (!res.getHeader('Cache-Control')) {
    res.setHeader('Cache-Control', strategy.value);
  }

  // For no-etag strategies (e.g. no-store): actively remove any ETag that
  // Express's own etag generator may add after the response is sent.
  if (!strategy.etag) {
    const originalEnd = res.end.bind(res);
    let cleared = false;
    (res.end as Function) = function clearETagForNoStore(
      chunk?: unknown,
      encodingOrCb?: unknown,
      cb?: () => void,
    ): Response {
      if (!cleared) {
        cleared = true;
        res.removeHeader('ETag');
      }
      return originalEnd(chunk, encodingOrCb as BufferEncoding, cb);
    };
    next();
    return;
  }

  // Intercept res.json / res.send / res.end to inject ETag + 304 logic.
  // We wrap res.end because Express ultimately funnels all response writes
  // through it (including res.json → res.send → res.end).
  const originalEnd = res.end.bind(res);

  // Track whether we've already patched this response to avoid double-patching
  // (e.g. if both res.json and res.send call end).
  let patched = false;

  (res.end as Function) = function patchedEnd(
    chunk?: unknown,
    encodingOrCb?: unknown,
    cb?: () => void,
  ): Response {
    if (patched) {
      // Already handled — pass through to avoid infinite recursion.
      return originalEnd(chunk, encodingOrCb as BufferEncoding, cb);
    }
    patched = true;

    // Only inject ETag for 2xx responses with a body.
    if (res.statusCode >= 200 && res.statusCode < 300 && chunk) {
      const body = chunk instanceof Buffer ? chunk : Buffer.from(String(chunk));
      const etag = computeETag(body);

      // Set ETag regardless (client may store it for future requests).
      res.setHeader('ETag', etag);

      // Check If-None-Match.
      const ifNoneMatch = req.headers['if-none-match'];
      if (ifNoneMatch && (ifNoneMatch === etag || ifNoneMatch === '*')) {
        // Resource hasn't changed — send 304.
        res.statusCode = 304;
        // Strip body-related headers that are invalid on 304.
        res.removeHeader('Content-Type');
        res.removeHeader('Content-Length');
        res.removeHeader('Transfer-Encoding');
        return originalEnd(undefined, encodingOrCb as BufferEncoding, cb);
      }
    }

    return originalEnd(chunk, encodingOrCb as BufferEncoding, cb);
  };

  next();
}
