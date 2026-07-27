/**
 * Issue #1303: CORS Configuration Middleware
 *
 * Provides configurable Cross-Origin Resource Sharing (CORS) headers for
 * secure browser access to the API.
 *
 * Features:
 * - Configurable allowed origins (specific list or wildcard)
 * - Credentials support for cross-origin requests
 * - Preflight (OPTIONS) request handling
 * - Configurable methods, headers, and max-age
 */

import { Request, Response, NextFunction } from 'express';

export interface CorsConfig {
  /**
   * Allowed origins. Can be:
   * - '*' for all origins (credentials will be disabled in this case)
   * - An array of specific origin strings
   * - A function for dynamic origin validation
   */
  origins: string | string[] | ((origin: string) => boolean);

  /** HTTP methods to allow. Defaults to standard REST methods. */
  methods?: string[];

  /** Headers the client is allowed to send. */
  allowedHeaders?: string[];

  /** Headers the browser is allowed to read from the response. */
  exposedHeaders?: string[];

  /** Whether to allow cookies/credentials in cross-origin requests. */
  credentials?: boolean;

  /** How long (in seconds) browsers should cache preflight results. */
  maxAge?: number;
}

const DEFAULT_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'];
const DEFAULT_ALLOWED_HEADERS = [
  'Content-Type',
  'Authorization',
  'X-Requested-With',
  'X-Role',
  'X-API-Key',
  'X-Stellar-Address',
  'X-Internal-Request',
];
const DEFAULT_EXPOSED_HEADERS = [
  'X-RateLimit-Limit',
  'X-RateLimit-Remaining',
  'X-RateLimit-Reset',
  'Retry-After',
  'Content-Disposition',
];
const DEFAULT_MAX_AGE = 86400; // 24 hours

/**
 * Determine whether a given origin is allowed by the configuration.
 */
function isOriginAllowed(origin: string, config: CorsConfig): boolean {
  const { origins } = config;

  if (origins === '*') return true;

  if (typeof origins === 'function') {
    return origins(origin);
  }

  if (Array.isArray(origins)) {
    return origins.some((allowed) => {
      // Support wildcard subdomains like *.example.com
      if (allowed.startsWith('*.')) {
        const domain = allowed.slice(2);
        return origin.endsWith(`.${domain}`) || origin === `https://${domain}`;
      }
      return allowed === origin;
    });
  }

  return false;
}

/**
 * Create a CORS middleware with the given configuration.
 */
export function createCors(config: CorsConfig) {
  const methods = (config.methods ?? DEFAULT_METHODS).join(', ');
  const allowedHeaders = (config.allowedHeaders ?? DEFAULT_ALLOWED_HEADERS).join(', ');
  const exposedHeaders = (config.exposedHeaders ?? DEFAULT_EXPOSED_HEADERS).join(', ');
  const maxAge = config.maxAge ?? DEFAULT_MAX_AGE;

  // When wildcard is used, credentials cannot be supported per CORS spec.
  const useCredentials = config.credentials !== false && config.origins !== '*';

  return function corsMiddleware(req: Request, res: Response, next: NextFunction): void {
    const origin = req.headers.origin;

    if (origin) {
      if (isOriginAllowed(origin, config)) {
        // Specific origin — required when credentials are enabled.
        res.setHeader('Access-Control-Allow-Origin', origin);
        res.setHeader('Vary', 'Origin');
      } else {
        // Origin not allowed — skip CORS headers (browser will block the request).
        if (req.method === 'OPTIONS') {
          res.status(204).end();
          return;
        }
        next();
        return;
      }
    } else if (config.origins === '*') {
      // No origin header (same-origin or non-browser) — set wildcard if configured.
      res.setHeader('Access-Control-Allow-Origin', '*');
    }

    if (useCredentials) {
      res.setHeader('Access-Control-Allow-Credentials', 'true');
    }

    res.setHeader('Access-Control-Expose-Headers', exposedHeaders);

    // Handle preflight requests.
    if (req.method === 'OPTIONS') {
      res.setHeader('Access-Control-Allow-Methods', methods);
      res.setHeader('Access-Control-Allow-Headers', allowedHeaders);
      res.setHeader('Access-Control-Max-Age', String(maxAge));
      res.status(204).end();
      return;
    }

    next();
  };
}

/**
 * Parse allowed origins from an environment variable.
 * Supports comma-separated list of origins or '*'.
 *
 * Example: CORS_ALLOWED_ORIGINS=https://app.quorumproof.io,https://staging.quorumproof.io
 */
export function parseOriginsFromEnv(envValue?: string): string | string[] {
  if (!envValue || envValue.trim() === '') {
    // Default to no origins allowed if unset (safe default).
    return [];
  }
  const trimmed = envValue.trim();
  if (trimmed === '*') return '*';
  return trimmed.split(',').map((s) => s.trim()).filter(Boolean);
}

/**
 * Create a CORS middleware from environment variables.
 *
 * Environment variables:
 * - CORS_ALLOWED_ORIGINS: comma-separated list of origins, or '*'
 * - CORS_CREDENTIALS: 'true' | 'false' (default: true)
 * - CORS_MAX_AGE: seconds (default: 86400)
 */
export function createCorsFromEnv(): ReturnType<typeof createCors> {
  const origins = parseOriginsFromEnv(process.env.CORS_ALLOWED_ORIGINS);
  const credentials = process.env.CORS_CREDENTIALS !== 'false';
  const maxAge = parseInt(process.env.CORS_MAX_AGE ?? String(DEFAULT_MAX_AGE), 10);

  return createCors({ origins, credentials, maxAge });
}
