/**
 * Auth Routes — Issues #1299 / #1300 / #1426
 *
 * POST /auth/login               — Authenticate with userId + password; returns token pair
 * POST /auth/mfa/enable          — Begin TOTP MFA setup for the authenticated user
 * POST /auth/mfa/verify          — Verify TOTP code and elevate session to mfaVerified
 * POST /auth/refresh             — Refresh an expired access token via a refresh token
 * GET  /auth/sessions            — List all sessions for the authenticated user
 * DELETE /auth/sessions/:id      — Revoke a specific session
 * DELETE /auth/sessions          — Revoke all sessions for the authenticated user (logout everywhere)
 * POST /auth/logout              — Revoke the current session
 *
 * #1426: Credential store is now backed by the `users` Postgres table.
 *        Passwords are hashed with Node.js crypto.scrypt (N=16384, r=8, p=1),
 *        stored as "scrypt:<hex-salt>:<hex-hash>".
 *        SHA-256 is no longer used; USER_CREDENTIALS env var is deprecated —
 *        see docs/user-credentials-migration.md for the migration path.
 */

import { Router, Request, Response } from 'express';
import { getDefaultMfaService } from '../services/mfa.js';
import { getDefaultSessionManager } from '../services/sessionManager.js';
import { requireAuth } from '../middleware/auth.js';
import { getPool } from '../db.js';
import crypto from 'crypto';
import { promisify } from 'util';

const router = Router();
const scryptAsync = promisify(crypto.scrypt);

// ---------------------------------------------------------------------------
// Password hashing (Issue #1426)
// ---------------------------------------------------------------------------

const SCRYPT_KEYLEN = 64;
const SCRYPT_N      = 16384;
const SCRYPT_R      = 8;
const SCRYPT_P      = 1;

/**
 * Hash a plaintext password.
 * Returns a string of the form "scrypt:<hex-salt>:<hex-hash>".
 */
export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.randomBytes(16);
  const hash = await scryptAsync(password, salt, SCRYPT_KEYLEN, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
  }) as Buffer;
  return `scrypt:${salt.toString('hex')}:${hash.toString('hex')}`;
}

/**
 * Verify a plaintext password against a stored hash string.
 * Accepts both the new "scrypt:..." format and the legacy SHA-256 hex format
 * so that operators who migrated USER_CREDENTIALS entries manually still work
 * until they reprovision with the new CLI.
 */
export async function verifyPassword(password: string, storedHash: string): Promise<boolean> {
  // New scrypt format
  if (storedHash.startsWith('scrypt:')) {
    const parts = storedHash.split(':');
    if (parts.length !== 3) return false;
    const salt = Buffer.from(parts[1], 'hex');
    const expected = Buffer.from(parts[2], 'hex');
    const actual = await scryptAsync(password, salt, SCRYPT_KEYLEN, {
      N: SCRYPT_N,
      r: SCRYPT_R,
      p: SCRYPT_P,
    }) as Buffer;
    return crypto.timingSafeEqual(actual, expected);
  }

  // Legacy SHA-256 format (for accounts created before #1426 migration)
  // Accept only in non-production environments.
  if (process.env.NODE_ENV !== 'production') {
    const sha256 = crypto.createHash('sha256').update(password).digest('hex');
    return crypto.timingSafeEqual(
      Buffer.from(sha256, 'hex'),
      Buffer.from(storedHash, 'hex'),
    );
  }

  return false;
}

// ---------------------------------------------------------------------------
// User lookup (Issue #1426: Postgres-backed, replaces USER_CREDENTIALS env var)
// ---------------------------------------------------------------------------

interface UserRow {
  user_id: string;
  password_hash: string;
  role: string;
}

/**
 * Look up a user from the `users` Postgres table and verify their password.
 * Falls back to the deprecated USER_CREDENTIALS env-var in non-production
 * environments only, so that operators can migrate incrementally.
 */
async function findUser(userId: string, password: string): Promise<UserRow | null> {
  // ── Primary path: Postgres users table ────────────────────────────────────
  try {
    const result = await getPool().query<UserRow>(
      'SELECT user_id, password_hash, role FROM users WHERE user_id = $1',
      [userId],
    );
    if (result.rowCount && result.rowCount > 0) {
      const row = result.rows[0];
      const valid = await verifyPassword(password, row.password_hash);
      return valid ? row : null;
    }
  } catch (err) {
    // Log but fall through to env-var fallback so a DB outage during startup
    // doesn't hard-lock all operators out immediately.
    console.warn('[auth] DB lookup failed, attempting fallback:', (err as Error).message);
  }

  // ── Fallback: deprecated USER_CREDENTIALS env var (non-production only) ───
  if (process.env.NODE_ENV !== 'production') {
    const raw = process.env.USER_CREDENTIALS;
    if (raw) {
      try {
        type LegacyCredential = { userId: string; passwordHash: string; role: string };
        const creds: LegacyCredential[] = JSON.parse(raw);
        const match = creds.find((c) => c.userId === userId);
        if (match) {
          const valid = await verifyPassword(password, match.passwordHash);
          if (valid) return { user_id: match.userId, password_hash: match.passwordHash, role: match.role };
        }
      } catch {
        console.warn('[auth] Failed to parse USER_CREDENTIALS fallback');
      }
    }

    // Hard-coded dev-only account (removed in production, see NODE_ENV guard above)
    if (userId === 'admin') {
      const sha256 = crypto.createHash('sha256').update(password).digest('hex');
      const ADMIN_HASH = '3a7bd3e2360a3d29eea436fcfb7e44c735d117c42d1c1835420b6b9942dd4f1b'; // sha256("changeme")
      if (sha256 === ADMIN_HASH) {
        return { user_id: 'admin', password_hash: ADMIN_HASH, role: 'admin' };
      }
    }
    if (userId === 'user1') {
      const sha256 = crypto.createHash('sha256').update(password).digest('hex');
      const USER1_HASH = '3a7bd3e2360a3d29eea436fcfb7e44c735d117c42d1c1835420b6b9942dd4f1b';
      if (sha256 === USER1_HASH) {
        return { user_id: 'user1', password_hash: USER1_HASH, role: 'user' };
      }
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// POST /auth/login
// ---------------------------------------------------------------------------

/**
 * Primary authentication endpoint.
 *
 * If the user has MFA enabled, the response includes `mfaRequired: true` and a
 * pre-MFA access token with `mfaVerified: false`. The client must then call
 * POST /auth/mfa/verify with the TOTP code to upgrade to a fully verified session.
 *
 * If the user does NOT have MFA enabled, a fully authenticated session is returned
 * immediately.
 *
 * Body: { userId: string, password: string }
 */
router.post('/login', async (req: Request, res: Response) => {
  const { userId, password } = req.body as { userId?: unknown; password?: unknown };

  if (typeof userId !== 'string' || !userId.trim()) {
    res.status(400).json({ error: 'userId is required' });
    return;
  }
  if (typeof password !== 'string' || !password) {
    res.status(400).json({ error: 'password is required' });
    return;
  }

  const user = await findUser(userId.trim(), password);
  if (!user) {
    // Use a consistent error to avoid username enumeration
    res.status(401).json({ error: 'Invalid credentials' });
    return;
  }

  const mfaService = getDefaultMfaService();
  const sessionManager = getDefaultSessionManager();
  const mfaEnabled = mfaService.isMfaEnabled(user.user_id);

  // Create session — mfaVerified=false if MFA is enabled (requires second factor)
  const tokens = sessionManager.createSession(user.user_id, {
    mfaVerified: !mfaEnabled,
    role: user.role,
  });

  res.status(200).json({
    ...tokens,
    mfaRequired: mfaEnabled,
    userId: user.user_id,
    role: user.role,
    message: mfaEnabled
      ? 'MFA required. Submit TOTP code via POST /auth/mfa/verify.'
      : 'Login successful.',
  });
});

// ---------------------------------------------------------------------------
// POST /auth/mfa/enable — begin MFA setup (requires auth)
// ---------------------------------------------------------------------------

/**
 * Initiates TOTP MFA setup for the authenticated user.
 * Returns the base32 secret and an otpauth:// URL for QR code scanning.
 * Backup codes are returned once and should be stored by the user.
 *
 * MFA is not active until the user calls POST /auth/mfa/verify with a valid code.
 */
router.post('/mfa/enable', requireAuth, (req: Request, res: Response) => {
  const userId = req.auth!.sub;
  const mfaService = getDefaultMfaService();

  if (mfaService.isMfaEnabled(userId)) {
    res.status(409).json({
      error: 'MFA already enabled',
      message: 'Disable existing MFA before re-enrolling.',
    });
    return;
  }

  const setup = mfaService.setupMfa(userId, 'QuorumProof');

  res.status(200).json({
    secret: setup.secret,
    otpAuthUrl: setup.otpAuthUrl,
    backupCodes: setup.backupCodes,
    message: 'Scan the QR code in your authenticator app, then call POST /auth/mfa/verify with a valid code to activate MFA.',
  });
});

// ---------------------------------------------------------------------------
// POST /auth/mfa/verify — verify TOTP code (requires auth)
// ---------------------------------------------------------------------------

/**
 * Two use cases:
 *   1. MFA SETUP confirmation: If MFA is pending (enabled=false in the service),
 *      this call activates it and upgrades the current session to mfaVerified=true.
 *   2. MFA LOGIN: If the session has mfaVerified=false (post-login, MFA enabled),
 *      a valid code upgrades the session by issuing a new mfaVerified token pair.
 *
 * Body: { code: string }
 */
router.post('/mfa/verify', requireAuth, (req: Request, res: Response) => {
  const userId = req.auth!.sub;
  const { code } = req.body as { code?: unknown };

  if (typeof code !== 'string' || !/^\d{6}$/.test(code)) {
    res.status(400).json({ error: 'code must be a 6-digit string' });
    return;
  }

  const mfaService = getDefaultMfaService();
  const sessionManager = getDefaultSessionManager();

  // Case 1: MFA setup confirmation — the user has a pending (enabled=false) record
  const status = mfaService.getMfaStatus(userId);
  if (status && !status.enabled) {
    const confirmed = mfaService.verifySetup(userId, code);
    if (!confirmed) {
      res.status(401).json({ error: 'Invalid TOTP code', message: 'Code verification failed during setup.' });
      return;
    }

    // Revoke the current session and issue a new one with mfaVerified=true
    sessionManager.revokeSession(req.auth!.jti);
    const tokens = sessionManager.createSession(userId, {
      mfaVerified: true,
      role: req.auth!.role,
    });

    res.status(200).json({
      ...tokens,
      mfaEnabled: true,
      message: 'MFA activated successfully. Your session has been upgraded.',
    });
    return;
  }

  // Case 2: MFA login — verify and upgrade the session
  const valid = mfaService.verifyCode(userId, code);
  if (!valid) {
    res.status(401).json({ error: 'Invalid TOTP code', message: 'Code verification failed.' });
    return;
  }

  // Revoke current (pre-MFA) session and issue a verified one
  sessionManager.revokeSession(req.auth!.jti);
  const tokens = sessionManager.createSession(userId, {
    mfaVerified: true,
    role: req.auth!.role,
  });

  res.status(200).json({
    ...tokens,
    mfaVerified: true,
    message: 'MFA verified. Session upgraded to full access.',
  });
});

// ---------------------------------------------------------------------------
// POST /auth/refresh — refresh token rotation
// ---------------------------------------------------------------------------

/**
 * Exchange a valid refresh token for a new access + refresh token pair.
 * The old refresh token is invalidated on use (token rotation).
 *
 * Body: { refreshToken: string }
 */
router.post('/refresh', (req: Request, res: Response) => {
  const { refreshToken } = req.body as { refreshToken?: unknown };

  if (typeof refreshToken !== 'string' || !refreshToken.trim()) {
    res.status(400).json({ error: 'refreshToken is required' });
    return;
  }

  const sessionManager = getDefaultSessionManager();
  const tokens = sessionManager.refreshSession(refreshToken.trim());

  if (!tokens) {
    res.status(401).json({
      error: 'Invalid or expired refresh token',
      message: 'Please log in again.',
    });
    return;
  }

  res.status(200).json({
    ...tokens,
    message: 'Token refreshed successfully.',
  });
});

// ---------------------------------------------------------------------------
// GET /auth/sessions — list all sessions for the authenticated user
// ---------------------------------------------------------------------------

router.get('/sessions', requireAuth, (req: Request, res: Response) => {
  const userId = req.auth!.sub;
  const sessionManager = getDefaultSessionManager();
  const sessions = sessionManager.listSessions(userId);
  res.status(200).json({ data: sessions, total: sessions.length });
});

// ---------------------------------------------------------------------------
// DELETE /auth/sessions — revoke ALL sessions (logout everywhere)
// ---------------------------------------------------------------------------

router.delete('/sessions', requireAuth, (req: Request, res: Response) => {
  const userId = req.auth!.sub;
  const sessionManager = getDefaultSessionManager();
  const count = sessionManager.revokeAllSessions(userId);
  res.status(200).json({ message: `Revoked ${count} session(s).`, count });
});

// ---------------------------------------------------------------------------
// DELETE /auth/sessions/:id — revoke a specific session
// ---------------------------------------------------------------------------

router.delete('/sessions/:id', requireAuth, (req: Request, res: Response) => {
  const userId = req.auth!.sub;
  const sessionId = req.params.id as string;
  const sessionManager = getDefaultSessionManager();

  // Verify the session belongs to the requesting user
  const sessions = sessionManager.listSessions(userId);
  const owned = sessions.find((s) => s.sessionId === sessionId);
  if (!owned) {
    res.status(404).json({ error: 'Session not found or not owned by you' });
    return;
  }

  const revoked = sessionManager.revokeSession(sessionId);
  if (!revoked) {
    res.status(404).json({ error: 'Session not found' });
    return;
  }

  res.status(200).json({ message: 'Session revoked successfully.' });
});

// ---------------------------------------------------------------------------
// POST /auth/logout — revoke the current session
// ---------------------------------------------------------------------------

router.post('/logout', requireAuth, (req: Request, res: Response) => {
  const sessionId = req.auth!.jti;
  const sessionManager = getDefaultSessionManager();
  sessionManager.revokeSession(sessionId);
  res.status(200).json({ message: 'Logged out successfully.' });
});

export default router;
