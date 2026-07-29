/**
 * Issue #1313 — Gzip Compression Middleware
 *
 * Adds response compression to the Express server using the `compression`
 * package (zlib-backed).  Only responses larger than the configured threshold
 * are compressed, so small payloads (e.g. 204 No Content or tiny JSON) are
 * sent as-is to avoid the overhead of calling zlib for negligible savings.
 *
 * ## Configuration (environment variables)
 *
 *   COMPRESSION_LEVEL   — zlib compression level, 0–9 (default: 6).
 *                          0 = no compression (store only), 9 = maximum.
 *                          Use -1 to accept zlib's default.
 *   COMPRESSION_THRESHOLD — minimum response size in bytes before compression
 *                           is applied (default: 1024 = 1 KB).
 *   COMPRESSION_ENABLED — set to "false" to disable entirely (useful in dev
 *                         environments where CPU is precious and payloads are
 *                         small).
 *
 * ## How it works
 *
 * The middleware wraps the standard `compression` npm package, which
 * inspects the outgoing `Content-Type` and `Content-Length` headers before
 * deciding whether to compress.  Binary content types (`image/*`,
 * `video/*`, `audio/*`) are never compressed because they are already
 * encoded and additional compression would expand the payload.
 *
 * The `filter` function below encodes these rules.  It is called once per
 * response, before any body bytes are flushed.
 *
 * ## Usage
 *
 * ```ts
 * import { createCompressionMiddleware } from './middleware/compression.js';
 * app.use(createCompressionMiddleware());
 * ```
 */

import compression from 'compression';
import type { Request, Response } from 'express';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CompressionConfig {
  /**
   * zlib compression level, 0–9.
   * 0  = no compression (passthrough, but adds zlib framing — use enabled=false
   *      to skip entirely).
   * 1  = fastest, largest output.
   * 6  = balanced default (same as zlib's Z_DEFAULT_COMPRESSION).
   * 9  = slowest, smallest output.
   * -1 = let zlib pick (resolves to 6 in current versions).
   */
  level?: number;

  /**
   * Minimum response size (bytes) before compression is applied.
   * Responses smaller than this are sent uncompressed.
   * Default: 1024 (1 KB).
   */
  threshold?: number;

  /**
   * Whether compression is enabled at all.
   * Default: true.  Set to false to disable without removing the middleware.
   */
  enabled?: boolean;

  /**
   * Content-type patterns that should NEVER be compressed.
   * The built-in `compression` package already skips binary formats, but
   * this list lets callers add application-specific exclusions (e.g. SSE
   * streams that must not be buffered).
   *
   * Each entry is compared as a substring of the lower-cased Content-Type.
   * Default: ['text/event-stream'].
   */
  excludeContentTypes?: string[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Content-type substrings that should never be compressed.
 * Media that is already encoded gains nothing and may even grow slightly.
 */
const ALWAYS_EXCLUDE_PREFIXES = [
  'image/',
  'video/',
  'audio/',
  'font/',
  'application/zip',
  'application/gzip',
  'application/x-brotli',
  'application/x-7z-compressed',
  'application/x-rar-compressed',
];

/**
 * Decide whether a response should be compressed.
 *
 * The `compression` package calls this function with the request and the
 * response.  Returning `false` disables compression for that response;
 * returning `true` defers to the package's own size threshold check.
 */
function shouldCompress(
  req: Request,
  res: Response,
  excludeContentTypes: string[]
): boolean {
  const contentType = ((res.getHeader('Content-Type') as string | undefined) ?? '').toLowerCase();

  // Never compress already-encoded / binary formats.
  for (const prefix of ALWAYS_EXCLUDE_PREFIXES) {
    if (contentType.startsWith(prefix)) return false;
  }

  // Never compress caller-specified exclusions.
  for (const excluded of excludeContentTypes) {
    if (contentType.includes(excluded.toLowerCase())) return false;
  }

  // Defer to the package's threshold check.
  return compression.filter(req, res);
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a configured compression middleware instance.
 *
 * Call once at startup and pass the result to `app.use()`.
 *
 * @example
 * ```ts
 * app.use(createCompressionMiddleware({ level: 6, threshold: 1024 }));
 * ```
 */
export function createCompressionMiddleware(config: CompressionConfig = {}) {
  const enabled = config.enabled !== false;

  if (!enabled) {
    // Return a no-op middleware so callers never need to conditionalise.
    return (_req: Request, _res: Response, next: () => void) => next();
  }

  const level = config.level ?? parseInt(process.env.COMPRESSION_LEVEL ?? '6', 10);
  const threshold = config.threshold ?? parseInt(process.env.COMPRESSION_THRESHOLD ?? '1024', 10);
  const excludeContentTypes = config.excludeContentTypes ?? ['text/event-stream'];

  return compression({
    level,
    threshold,
    filter: (req, res) => shouldCompress(req, res, excludeContentTypes),
  });
}

/**
 * Create a compression middleware from environment variables.
 *
 * Environment variables:
 *   COMPRESSION_ENABLED   — 'true' | 'false' (default: true)
 *   COMPRESSION_LEVEL     — integer 0–9 (default: 6)
 *   COMPRESSION_THRESHOLD — bytes (default: 1024)
 */
export function createCompressionFromEnv(): ReturnType<typeof createCompressionMiddleware> {
  const enabled = process.env.COMPRESSION_ENABLED !== 'false';
  const level = parseInt(process.env.COMPRESSION_LEVEL ?? '6', 10);
  const threshold = parseInt(process.env.COMPRESSION_THRESHOLD ?? '1024', 10);

  return createCompressionMiddleware({ enabled, level, threshold });
}

export default createCompressionFromEnv;
