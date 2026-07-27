/**
 * Issue #1302: Passwordless Authentication Routes
 *
 * POST /api/auth/passwordless/start   — initiate magic link or WebAuthn challenge
 * POST /api/auth/passwordless/verify  — verify token or WebAuthn response
 * POST /api/auth/webauthn/register/start    — begin WebAuthn registration
 * POST /api/auth/webauthn/register/verify   — complete WebAuthn registration
 * POST /api/auth/webauthn/authenticate/start    — begin WebAuthn authentication
 * POST /api/auth/webauthn/authenticate/verify  — complete WebAuthn authentication
 */

import { Router, Request, Response } from 'express';
import {
  createMagicLinkToken,
  verifyMagicLinkToken,
  createWebAuthnChallenge,
  verifyWebAuthnRegistration,
  verifyWebAuthnAuthentication,
  getCredentialsForUser,
} from '../services/passwordlessAuth.js';
import { logAuthEvent } from '../services/authAudit.js';

const router = Router();

function getIp(req: Request): string {
  return String(req.ip ?? req.socket.remoteAddress ?? 'unknown');
}

function getUserAgent(req: Request): string {
  return String(req.headers['user-agent'] ?? '');
}

// ─── Magic Link ────────────────────────────────────────────────────────────────

/**
 * POST /api/auth/passwordless/start
 * Initiates a magic-link authentication flow.
 *
 * Body: { email: string }
 *
 * In production this would dispatch an email; here we return the token
 * in the response (dev/test mode) so the flow can be tested end-to-end.
 */
router.post('/start', (req: Request, res: Response): void => {
  const { email } = req.body as { email?: string };

  if (!email || typeof email !== 'string' || !email.includes('@')) {
    res.status(400).json({ error: 'A valid email address is required' });
    return;
  }

  try {
    const { token, expires_at } = createMagicLinkToken(email);

    logAuthEvent('magic_link_requested', {
      user_id: email,
      ip_address: getIp(req),
      user_agent: getUserAgent(req),
      status: 'info',
      metadata: { email },
    });

    // NOTE: In production, send the token via email only.
    // The magic_link_token field is included here for development/testing convenience.
    res.status(202).json({
      message: 'Magic link sent. Check your email.',
      expires_at: new Date(expires_at).toISOString(),
      // Dev/test only — remove in production:
      magic_link_token: token,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    res.status(400).json({ error: message });
  }
});

/**
 * POST /api/auth/passwordless/verify
 * Verifies a magic-link token.
 *
 * Body: { token: string }
 */
router.post('/verify', (req: Request, res: Response): void => {
  const { token } = req.body as { token?: string };

  if (!token || typeof token !== 'string') {
    res.status(400).json({ error: 'token is required' });
    return;
  }

  const result = verifyMagicLinkToken(token);

  if (!result.success) {
    logAuthEvent('magic_link_failed', {
      ip_address: getIp(req),
      user_agent: getUserAgent(req),
      status: 'failure',
      metadata: { error: result.error },
    });
    res.status(401).json({ error: result.error });
    return;
  }

  logAuthEvent('magic_link_verified', {
    user_id: result.email,
    ip_address: getIp(req),
    user_agent: getUserAgent(req),
    status: 'success',
    metadata: { email: result.email },
  });

  res.json({
    success: true,
    email: result.email,
    message: 'Authentication successful',
  });
});

// ─── WebAuthn Registration ─────────────────────────────────────────────────────

/**
 * POST /api/auth/webauthn/register/start
 * Returns a registration challenge for WebAuthn.
 *
 * Body: { user_id: string }
 */
router.post('/webauthn/register/start', (req: Request, res: Response): void => {
  const { user_id } = req.body as { user_id?: string };

  if (!user_id || typeof user_id !== 'string') {
    res.status(400).json({ error: 'user_id is required' });
    return;
  }

  try {
    const challengeRecord = createWebAuthnChallenge(user_id, 'registration');
    res.json({
      challenge: challengeRecord.challenge,
      user_id: challengeRecord.user_id,
      expires_at: new Date(challengeRecord.expires_at).toISOString(),
      rp: {
        name: 'QuorumProof',
        id: process.env.WEBAUTHN_RP_ID ?? 'localhost',
      },
      user: {
        id: Buffer.from(user_id).toString('base64url'),
        name: user_id,
        displayName: user_id,
      },
      pubKeyCredParams: [
        { type: 'public-key', alg: -7 },   // ES256
        { type: 'public-key', alg: -257 },  // RS256
      ],
      timeout: 60000,
      attestation: 'none',
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    res.status(400).json({ error: message });
  }
});

/**
 * POST /api/auth/webauthn/register/verify
 * Completes WebAuthn registration.
 *
 * Body: {
 *   challenge: string,
 *   credential_id: string,
 *   public_key: string,
 *   client_data_json: string,   // base64url
 *   user_id: string
 * }
 */
router.post('/webauthn/register/verify', (req: Request, res: Response): void => {
  const { challenge, credential_id, public_key, client_data_json, user_id } =
    req.body as Record<string, string | undefined>;

  if (!challenge || !credential_id || !public_key || !client_data_json || !user_id) {
    res.status(400).json({
      error: 'challenge, credential_id, public_key, client_data_json, and user_id are required',
    });
    return;
  }

  const result = verifyWebAuthnRegistration({
    challenge,
    credential_id,
    public_key,
    client_data_json,
    user_id,
  });

  if (!result.success) {
    logAuthEvent('webauthn_failed', {
      user_id,
      ip_address: getIp(req),
      user_agent: getUserAgent(req),
      status: 'failure',
      metadata: { error: result.error, phase: 'registration' },
    });
    res.status(401).json({ error: result.error });
    return;
  }

  logAuthEvent('webauthn_registered', {
    user_id,
    ip_address: getIp(req),
    user_agent: getUserAgent(req),
    status: 'success',
    metadata: { credential_id: result.credential?.credential_id },
  });

  res.status(201).json({
    success: true,
    credential: result.credential,
    message: 'WebAuthn credential registered successfully',
  });
});

// ─── WebAuthn Authentication ───────────────────────────────────────────────────

/**
 * POST /api/auth/webauthn/authenticate/start
 * Returns an authentication challenge for WebAuthn.
 *
 * Body: { user_id: string }
 */
router.post('/webauthn/authenticate/start', (req: Request, res: Response): void => {
  const { user_id } = req.body as { user_id?: string };

  if (!user_id || typeof user_id !== 'string') {
    res.status(400).json({ error: 'user_id is required' });
    return;
  }

  try {
    const challengeRecord = createWebAuthnChallenge(user_id, 'authentication');
    const userCredentials = getCredentialsForUser(user_id);

    res.json({
      challenge: challengeRecord.challenge,
      user_id: challengeRecord.user_id,
      expires_at: new Date(challengeRecord.expires_at).toISOString(),
      timeout: 60000,
      rpId: process.env.WEBAUTHN_RP_ID ?? 'localhost',
      allowCredentials: userCredentials.map((c) => ({
        type: 'public-key',
        id: c.credential_id,
      })),
      userVerification: 'preferred',
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    res.status(400).json({ error: message });
  }
});

/**
 * POST /api/auth/webauthn/authenticate/verify
 * Completes WebAuthn authentication.
 *
 * Body: {
 *   challenge: string,
 *   credential_id: string,
 *   client_data_json: string,      // base64url
 *   authenticator_data: string,    // base64url
 *   signature: string,             // base64url
 *   sign_count: number,
 *   user_id: string
 * }
 */
router.post('/webauthn/authenticate/verify', (req: Request, res: Response): void => {
  const {
    challenge, credential_id, client_data_json,
    authenticator_data, signature, user_id,
  } = req.body as Record<string, string | undefined>;
  const sign_count = Number(req.body.sign_count);

  if (!challenge || !credential_id || !client_data_json || !authenticator_data || !signature || !user_id) {
    res.status(400).json({
      error: 'challenge, credential_id, client_data_json, authenticator_data, signature, and user_id are required',
    });
    return;
  }

  if (!Number.isFinite(sign_count) || sign_count < 0) {
    res.status(400).json({ error: 'sign_count must be a non-negative number' });
    return;
  }

  const result = verifyWebAuthnAuthentication({
    challenge,
    credential_id,
    client_data_json,
    authenticator_data,
    signature,
    sign_count,
    user_id,
  });

  if (!result.success) {
    logAuthEvent('webauthn_failed', {
      user_id,
      ip_address: getIp(req),
      user_agent: getUserAgent(req),
      status: 'failure',
      metadata: { error: result.error, phase: 'authentication' },
    });
    res.status(401).json({ error: result.error });
    return;
  }

  logAuthEvent('webauthn_verified', {
    user_id,
    ip_address: getIp(req),
    user_agent: getUserAgent(req),
    status: 'success',
    metadata: { credential_id },
  });

  res.json({
    success: true,
    message: 'WebAuthn authentication successful',
  });
});

export default router;
