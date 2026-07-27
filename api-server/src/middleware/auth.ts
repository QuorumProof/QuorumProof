/**
 * Auth Middleware — Issues #1299 / #1300
 *
 * Provides two Express middleware functions:
 *
 *  requireAuth    — validates the Bearer access token; attaches the JWT payload
 *                   to req.auth for downstream handlers.
 *
 *  requireMfa     — extends requireAuth by additionally checking that the
 *                   mfaVerified flag is set in the token. Use this for admin
 *                   endpoints that require MFA.
 *
 * The authenticated user is available as:
 *   req.auth.sub          → userId
 *   req.auth.role         → role
 *   req.auth.mfaVerified  → boolean
 *   req.auth.jti          → sessionId
 */

import { Request, Response, NextFunction } from 'express';
import { getDefaultSessionManager, type JwtPayload } from '../services/sessionManager.js';

// ---------------------------------------------------------------------------
// Augment Express Request type
// ---------------------------------------------------------------------------
declare global {
  namespace Express {
    interface Request {
      auth?: JwtPayload;
    }
  }
}

// ---------------------------------------------------------------------------
// Token extraction helper
// ---------------------------------------------------------------------------
function extractBearerToken(req: Request): string | null {
  const authHeader = req.headers['authorization'];
  if (!authHeader || !authHeader.startsWith('Bearer ')) return null;
  const token = authHeader.slice(7).trim();
  return token.length > 0 ? token : null;
}

// ---------------------------------------------------------------------------
// requireAuth middleware
// ---------------------------------------------------------------------------

/**
 * Validates the Bearer JWT in the Authorization header.
 * Sets req.auth with the decoded payload on success.
 * Returns 401 if the token is missing, invalid, expired, or revoked.
 */
export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  const token = extractBearerToken(req);
  if (!token) {
    res.status(401).json({ error: 'Authentication required', message: 'Missing Bearer token' });
    return;
  }

  const sessionManager = getDefaultSessionManager();
  const payload = sessionManager.validateAccessToken(token);
  if (!payload) {
    res.status(401).json({ error: 'Authentication failed', message: 'Invalid, expired, or revoked token' });
    return;
  }

  req.auth = payload;
  next();
}

// ---------------------------------------------------------------------------
// requireMfa middleware
// ---------------------------------------------------------------------------

/**
 * Requires a valid access token AND that MFA was verified during login.
 * Use this to protect admin-only endpoints.
 *
 * Returns 401 if the token is missing/invalid.
 * Returns 403 if the token is valid but MFA was not completed.
 */
export function requireMfa(req: Request, res: Response, next: NextFunction): void {
  const token = extractBearerToken(req);
  if (!token) {
    res.status(401).json({ error: 'Authentication required', message: 'Missing Bearer token' });
    return;
  }

  const sessionManager = getDefaultSessionManager();
  const payload = sessionManager.validateAccessToken(token);
  if (!payload) {
    res.status(401).json({ error: 'Authentication failed', message: 'Invalid, expired, or revoked token' });
    return;
  }

  if (!payload.mfaVerified) {
    res.status(403).json({
      error: 'MFA required',
      message: 'This endpoint requires multi-factor authentication. Complete MFA via POST /auth/mfa/verify.',
    });
    return;
  }

  req.auth = payload;
  next();
}

// ---------------------------------------------------------------------------
// optionalAuth middleware
// ---------------------------------------------------------------------------

/**
 * Attempts to validate the Bearer token but does NOT reject the request on
 * failure. Use this for endpoints that behave differently for authenticated
 * vs anonymous callers.
 */
export function optionalAuth(req: Request, _res: Response, next: NextFunction): void {
  const token = extractBearerToken(req);
  if (token) {
    const sessionManager = getDefaultSessionManager();
    const payload = sessionManager.validateAccessToken(token);
    if (payload) req.auth = payload;
  }
  next();
}
