/**
 * API Versioning Middleware (Issue #1310)
 *
 * Extracts the API version from the URL path (e.g. /api/v1/... → "v1"),
 * attaches it to `req.apiVersion`, and adds deprecation headers when a
 * client is using an end-of-life or sunset version.
 *
 * Supported versions:
 *   v1  — current stable, enters maintenance 2026-09-01, sunset 2027-03-01
 *   v2  — current development, GA planned 2026-09-01
 *
 * Unknown version segments are rejected with 404 so clients get a clear
 * signal rather than silently falling through to unversioned routes.
 */

import { Request, Response, NextFunction, Router } from 'express';

// ─── Version catalogue ────────────────────────────────────────────────────────

export type ApiVersion = 'v1' | 'v2';

export interface VersionMeta {
  /** Human-readable stability label */
  status: 'stable' | 'maintenance' | 'deprecated' | 'sunset' | 'development';
  /** ISO-8601 date after which no new features land (maintenance-only) */
  maintenanceDate?: string;
  /** ISO-8601 sunset date — after this date the version will return 410 Gone */
  sunsetDate?: string;
  /** Short human-readable reason shown in the Deprecation header */
  deprecationReason?: string;
  /** Link to migration guide */
  migrationGuide?: string;
}

export const VERSION_CATALOGUE: Record<ApiVersion, VersionMeta> = {
  v1: {
    status: 'stable',
    maintenanceDate: '2026-09-01',
    sunsetDate: '2027-03-01',
    deprecationReason: 'v1 enters maintenance on 2026-09-01 and will be sunset on 2027-03-01.',
    migrationGuide: 'https://docs.quorumproof.io/api/migration/v1-to-v2',
  },
  v2: {
    status: 'development',
    migrationGuide: 'https://docs.quorumproof.io/api/v2',
  },
};

const SUPPORTED_VERSIONS = new Set<string>(Object.keys(VERSION_CATALOGUE));

// ─── Module augmentation ──────────────────────────────────────────────────────

declare global {
  namespace Express {
    interface Request {
      /** Parsed API version from the URL, or undefined for unversioned paths */
      apiVersion?: ApiVersion;
    }
  }
}

// ─── Middleware factory ───────────────────────────────────────────────────────

/**
 * Returns an Express middleware that:
 *   1. Parses `/api/v{N}/...` paths to extract the version segment.
 *   2. Rejects unknown versions with 404.
 *   3. Sets `req.apiVersion` for downstream handlers.
 *   4. Adds `API-Version` response header.
 *   5. Adds `Deprecation`, `Sunset`, and `Link` headers for maintenance /
 *      deprecated versions.
 */
export function createApiVersionMiddleware() {
  return function apiVersionMiddleware(req: Request, res: Response, next: NextFunction): void {
    // Match /api/vN/... or /api/vN (with optional trailing slash)
    const match = req.path.match(/^\/api\/(v\d+)(\/|$)/);

    if (!match) {
      // Unversioned path — pass through for backward-compat /api/* routes.
      next();
      return;
    }

    const versionSegment = match[1]; // e.g. "v1", "v2"

    if (!SUPPORTED_VERSIONS.has(versionSegment)) {
      res.status(404).json({
        error: 'Unknown API version',
        message: `Version "${versionSegment}" is not supported. Supported versions: ${[...SUPPORTED_VERSIONS].join(', ')}.`,
        supported_versions: [...SUPPORTED_VERSIONS],
        docs: 'https://docs.quorumproof.io/api/versioning',
      });
      return;
    }

    const version = versionSegment as ApiVersion;
    const meta = VERSION_CATALOGUE[version];

    // Attach to request so downstream handlers / middleware can branch on it.
    req.apiVersion = version;

    // Always emit the resolved version so clients know what they're talking to.
    res.setHeader('API-Version', version);

    // Emit deprecation signals for versions in maintenance or deprecated state.
    if (meta.status === 'maintenance' || meta.status === 'deprecated') {
      res.setHeader('Deprecation', meta.maintenanceDate ?? 'true');
      if (meta.sunsetDate) {
        res.setHeader('Sunset', meta.sunsetDate);
      }
      if (meta.migrationGuide) {
        res.setHeader('Link', `<${meta.migrationGuide}>; rel="successor-version"`);
      }
      if (meta.deprecationReason) {
        res.setHeader('X-API-Deprecation-Info', meta.deprecationReason);
      }
    }

    next();
  };
}

// ─── Version gate helper ──────────────────────────────────────────────────────

/**
 * Returns an Express middleware that restricts a sub-router to a specific
 * API version.  If the request version doesn't match, passes through to the
 * next handler (allows stacking version-specific routers).
 *
 * Usage:
 *   app.use('/api/v1', versionGate('v1'), v1Router);
 *   app.use('/api/v2', versionGate('v2'), v2Router);
 */
export function versionGate(expectedVersion: ApiVersion) {
  return function versionGateMiddleware(req: Request, res: Response, next: NextFunction): void {
    if (req.apiVersion === expectedVersion) {
      next();
    } else {
      next('router');
    }
  };
}

// ─── Sunset handler ───────────────────────────────────────────────────────────

/**
 * Terminates requests to sunset versions with `410 Gone` and a descriptive
 * body.  Mount this before the version's router:
 *
 *   app.use('/api/v0', sunsetHandler('v0'));
 */
export function sunsetHandler(version: string) {
  return function sunsetMiddleware(_req: Request, res: Response): void {
    res.status(410).json({
      error: 'API version sunset',
      message: `Version "${version}" has been retired and is no longer available.`,
      docs: 'https://docs.quorumproof.io/api/versioning',
    });
  };
}
