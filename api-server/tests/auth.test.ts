/**
 * End-to-End Route Tests for Composed Auth Flow — Issue #1439 / #1299 / #1300
 *
 * Exercises the entire auth lifecycle via HTTP endpoints:
 *  - Login without MFA enrolled
 *  - MFA setup & activation (POST /auth/mfa/enable -> POST /auth/mfa/verify)
 *  - Login with MFA required (challenge -> verify -> elevated session)
 *  - Negative test: accessing MFA-gated endpoint with pre-MFA session (403)
 *  - Refresh token rotation (POST /auth/refresh & replay rejection)
 *  - Session listing (GET /auth/sessions)
 *  - Single session revocation (DELETE /auth/sessions/:id)
 *  - Current session logout (POST /auth/logout)
 *  - Revoke all sessions / logout everywhere (DELETE /auth/sessions)
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express, { Request, Response } from 'express';
import request from 'supertest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import authRouter from '../src/routes/auth.js';
import { requireAuth, requireMfa } from '../src/middleware/auth.js';
import {
  MfaService,
  totp,
  _setDefaultMfaServiceForTest,
} from '../src/services/mfa.js';
import {
  SessionManager,
  _setDefaultSessionManagerForTest,
} from '../src/services/sessionManager.js';

describe('Auth Flow End-to-End Routes (/auth)', () => {
  let app: express.Express;
  let tempDir: string;
  let mfaService: MfaService;
  let sessionManager: SessionManager;

  beforeEach(() => {
    // Set up isolated temp state for each test run
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'auth-e2e-test-'));
    process.env.JWT_SECRET = 'test-secret-key-for-auth-e2e-tests-1234567890';

    mfaService = new MfaService({ dataDir: path.join(tempDir, 'mfa') });
    _setDefaultMfaServiceForTest(mfaService);

    sessionManager = new SessionManager({ dataDir: path.join(tempDir, 'sessions') });
    _setDefaultSessionManagerForTest(sessionManager);

    app = express();
    app.use(express.json());
    app.use('/auth', authRouter);

    // Sample protected routes to test auth middleware integration
    app.get('/api/protected/user', requireAuth, (req: Request, res: Response) => {
      res.status(200).json({ ok: true, user: req.auth });
    });

    app.get('/api/protected/mfa-gated-action', requireMfa, (req: Request, res: Response) => {
      res.status(200).json({ ok: true, secretData: 'admin-classified-payload', user: req.auth });
    });
  });

  afterEach(() => {
    try {
      if (fs.existsSync(tempDir)) {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    } catch {
      // Best-effort cleanup
    }
    _setDefaultMfaServiceForTest(undefined as any);
    _setDefaultSessionManagerForTest(undefined as any);
  });

  // ---------------------------------------------------------------------------
  // 1. Input Validation & Invalid Credentials
  // ---------------------------------------------------------------------------
  describe('POST /auth/login input validation', () => {
    it('returns 400 when userId is missing or blank', async () => {
      const res1 = await request(app).post('/auth/login').send({ password: 'changeme' });
      expect(res1.status).toBe(400);
      expect(res1.body.error).toBe('userId is required');

      const res2 = await request(app).post('/auth/login').send({ userId: '   ', password: 'changeme' });
      expect(res2.status).toBe(400);
      expect(res2.body.error).toBe('userId is required');
    });

    it('returns 400 when password is missing', async () => {
      const res = await request(app).post('/auth/login').send({ userId: 'admin' });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('password is required');
    });

    it('returns 401 for non-existent user or invalid password', async () => {
      const res1 = await request(app).post('/auth/login').send({ userId: 'nonexistent', password: 'changeme' });
      expect(res1.status).toBe(401);
      expect(res1.body.error).toBe('Invalid credentials');

      const res2 = await request(app).post('/auth/login').send({ userId: 'admin', password: 'wrongpassword' });
      expect(res2.status).toBe(401);
      expect(res2.body.error).toBe('Invalid credentials');
    });
  });

  // ---------------------------------------------------------------------------
  // 2. Login without MFA Enrolled
  // ---------------------------------------------------------------------------
  describe('Login without MFA enrolled', () => {
    it('authenticates user and returns full session with mfaRequired=false and access tokens', async () => {
      const res = await request(app).post('/auth/login').send({
        userId: 'user1',
        password: 'changeme',
      });

      expect(res.status).toBe(200);
      expect(res.body.mfaRequired).toBe(false);
      expect(res.body.userId).toBe('user1');
      expect(res.body.role).toBe('user');
      expect(res.body.accessToken).toBeDefined();
      expect(res.body.refreshToken).toBeDefined();
      expect(res.body.expiresIn).toBeDefined();

      // Verify access token can access authenticated routes
      const protectedRes = await request(app)
        .get('/api/protected/user')
        .set('Authorization', `Bearer ${res.body.accessToken}`);

      expect(protectedRes.status).toBe(200);
      expect(protectedRes.body.user.sub).toBe('user1');
      expect(protectedRes.body.user.mfaVerified).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // 3. MFA Setup and Activation Flow
  // ---------------------------------------------------------------------------
  describe('MFA Setup and Enrollment Flow', () => {
    it('allows an authenticated user to begin MFA setup and confirm with a TOTP code', async () => {
      // 1. Initial login
      const loginRes = await request(app).post('/auth/login').send({
        userId: 'admin',
        password: 'changeme',
      });
      expect(loginRes.status).toBe(200);
      const initialToken = loginRes.body.accessToken;

      // 2. POST /auth/mfa/enable without auth -> 401
      const unauthEnable = await request(app).post('/auth/mfa/enable');
      expect(unauthEnable.status).toBe(401);

      // 3. POST /auth/mfa/enable with Bearer token
      const enableRes = await request(app)
        .post('/auth/mfa/enable')
        .set('Authorization', `Bearer ${initialToken}`);

      expect(enableRes.status).toBe(200);
      expect(enableRes.body.secret).toBeDefined();
      expect(enableRes.body.otpAuthUrl).toContain('otpauth://totp/');
      expect(enableRes.body.backupCodes).toHaveLength(8);

      const secret = enableRes.body.secret;

      // 4. Invalid TOTP verification formats
      const invalidFormatRes = await request(app)
        .post('/auth/mfa/verify')
        .set('Authorization', `Bearer ${initialToken}`)
        .send({ code: '123' });
      expect(invalidFormatRes.status).toBe(400);
      expect(invalidFormatRes.body.error).toBe('code must be a 6-digit string');

      // 5. Wrong TOTP code
      const wrongCodeRes = await request(app)
        .post('/auth/mfa/verify')
        .set('Authorization', `Bearer ${initialToken}`)
        .send({ code: '000000' });
      expect(wrongCodeRes.status).toBe(401);

      // 6. Valid TOTP code to activate MFA
      const validCode = totp(secret);
      const verifyRes = await request(app)
        .post('/auth/mfa/verify')
        .set('Authorization', `Bearer ${initialToken}`)
        .send({ code: validCode });

      expect(verifyRes.status).toBe(200);
      expect(verifyRes.body.mfaEnabled).toBe(true);
      expect(verifyRes.body.accessToken).toBeDefined();
      expect(verifyRes.body.refreshToken).toBeDefined();

      // Verify MFA is now permanently marked enabled
      expect(mfaService.isMfaEnabled('admin')).toBe(true);

      // 7. Attempting to enable MFA again when already active returns 409 Conflict
      const reEnableRes = await request(app)
        .post('/auth/mfa/enable')
        .set('Authorization', `Bearer ${verifyRes.body.accessToken}`);
      expect(reEnableRes.status).toBe(409);
      expect(reEnableRes.body.error).toBe('MFA already enabled');
    });
  });

  // ---------------------------------------------------------------------------
  // 4. Login with MFA Required & Negative Test on MFA-gated Actions
  // ---------------------------------------------------------------------------
  describe('Login with MFA Required & MFA-gated Access Control', () => {
    it('requires 2nd factor on login, blocks MFA-gated routes before verification, and allows after elevation', async () => {
      // Step 1: Set up MFA for admin
      const setup = mfaService.setupMfa('admin');
      const setupCode = totp(setup.secret);
      mfaService.verifySetup('admin', setupCode);
      expect(mfaService.isMfaEnabled('admin')).toBe(true);

      // Step 2: Login as MFA-enrolled user
      const loginRes = await request(app).post('/auth/login').send({
        userId: 'admin',
        password: 'changeme',
      });

      expect(loginRes.status).toBe(200);
      expect(loginRes.body.mfaRequired).toBe(true);
      expect(loginRes.body.message).toContain('MFA required');

      const preMfaAccessToken = loginRes.body.accessToken;
      expect(preMfaAccessToken).toBeDefined();

      // Step 3: Base requireAuth route is accessible with pre-MFA token
      const userRes = await request(app)
        .get('/api/protected/user')
        .set('Authorization', `Bearer ${preMfaAccessToken}`);
      expect(userRes.status).toBe(200);
      expect(userRes.body.user.mfaVerified).toBe(false);

      // Step 4: Negative test — MFA-gated action is blocked with 403
      const mfaGatedDenied = await request(app)
        .get('/api/protected/mfa-gated-action')
        .set('Authorization', `Bearer ${preMfaAccessToken}`);

      expect(mfaGatedDenied.status).toBe(403);
      expect(mfaGatedDenied.body.error).toBe('MFA required');
      expect(mfaGatedDenied.body.message).toContain('Complete MFA via POST /auth/mfa/verify');

      // Step 5: Failed verification with wrong code
      const failedVerify = await request(app)
        .post('/auth/mfa/verify')
        .set('Authorization', `Bearer ${preMfaAccessToken}`)
        .send({ code: '999999' });
      expect(failedVerify.status).toBe(401);
      expect(failedVerify.body.error).toBe('Invalid TOTP code');

      // Step 6: Successful verification with valid TOTP code
      const currentCode = totp(setup.secret);
      const elevatedRes = await request(app)
        .post('/auth/mfa/verify')
        .set('Authorization', `Bearer ${preMfaAccessToken}`)
        .send({ code: currentCode });

      expect(elevatedRes.status).toBe(200);
      expect(elevatedRes.body.mfaVerified).toBe(true);
      expect(elevatedRes.body.accessToken).toBeDefined();

      const elevatedToken = elevatedRes.body.accessToken;

      // Step 7: MFA-gated action now succeeds with the elevated token (200)
      const mfaGatedAllowed = await request(app)
        .get('/api/protected/mfa-gated-action')
        .set('Authorization', `Bearer ${elevatedToken}`);

      expect(mfaGatedAllowed.status).toBe(200);
      expect(mfaGatedAllowed.body.secretData).toBe('admin-classified-payload');
      expect(mfaGatedAllowed.body.user.mfaVerified).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // 5. Refresh Token Rotation
  // ---------------------------------------------------------------------------
  describe('POST /auth/refresh token rotation', () => {
    it('refreshes token pair and rotates refresh token, rejecting reuse of old refresh tokens', async () => {
      // 1. Initial login
      const loginRes = await request(app).post('/auth/login').send({
        userId: 'user1',
        password: 'changeme',
      });
      const initialRefreshToken = loginRes.body.refreshToken;

      // 2. Missing refreshToken -> 400
      const missingRefresh = await request(app).post('/auth/refresh').send({});
      expect(missingRefresh.status).toBe(400);
      expect(missingRefresh.body.error).toBe('refreshToken is required');

      // 3. Invalid refreshToken -> 401
      const invalidRefresh = await request(app).post('/auth/refresh').send({ refreshToken: 'invalid-token-xyz' });
      expect(invalidRefresh.status).toBe(401);

      // 4. Valid refresh exchange
      const refreshRes = await request(app).post('/auth/refresh').send({
        refreshToken: initialRefreshToken,
      });

      expect(refreshRes.status).toBe(200);
      expect(refreshRes.body.accessToken).toBeDefined();
      expect(refreshRes.body.refreshToken).toBeDefined();
      expect(refreshRes.body.refreshToken).not.toBe(initialRefreshToken);

      const newAccessToken = refreshRes.body.accessToken;
      const newRefreshToken = refreshRes.body.refreshToken;

      // 5. New access token works
      const userRes = await request(app)
        .get('/api/protected/user')
        .set('Authorization', `Bearer ${newAccessToken}`);
      expect(userRes.status).toBe(200);

      // 6. Token rotation security: reusing the old refresh token is rejected (401)
      const reusedRes = await request(app).post('/auth/refresh').send({
        refreshToken: initialRefreshToken,
      });
      expect(reusedRes.status).toBe(401);
      expect(reusedRes.body.error).toBe('Invalid or expired refresh token');

      // 7. Second refresh with new valid refresh token works
      const secondRefresh = await request(app).post('/auth/refresh').send({
        refreshToken: newRefreshToken,
      });
      expect(secondRefresh.status).toBe(200);
    });
  });

  // ---------------------------------------------------------------------------
  // 6. Session Listing & Revocation (Single, Current Logout, and Everywhere)
  // ---------------------------------------------------------------------------
  describe('Session Management & Revocation', () => {
    it('lists sessions and supports single-session revocation', async () => {
      // Create session 1
      const login1 = await request(app).post('/auth/login').send({ userId: 'user1', password: 'changeme' });
      const token1 = login1.body.accessToken;

      // Create session 2
      const login2 = await request(app).post('/auth/login').send({ userId: 'user1', password: 'changeme' });
      const token2 = login2.body.accessToken;

      // List sessions via token 1
      const listRes = await request(app)
        .get('/auth/sessions')
        .set('Authorization', `Bearer ${token1}`);

      expect(listRes.status).toBe(200);
      expect(listRes.body.total).toBe(2);
      expect(listRes.body.data).toHaveLength(2);

      const session1Payload = sessionManager.validateAccessToken(token1)!;
      const session1Id = session1Payload.jti;

      // Revoke session 1 via session 2's token
      const revokeRes = await request(app)
        .delete(`/auth/sessions/${session1Id}`)
        .set('Authorization', `Bearer ${token2}`);

      expect(revokeRes.status).toBe(200);
      expect(revokeRes.body.message).toBe('Session revoked successfully.');

      // Token 1 is now rejected (401)
      const token1Check = await request(app)
        .get('/api/protected/user')
        .set('Authorization', `Bearer ${token1}`);
      expect(token1Check.status).toBe(401);

      // Token 2 is still valid (200)
      const token2Check = await request(app)
        .get('/api/protected/user')
        .set('Authorization', `Bearer ${token2}`);
      expect(token2Check.status).toBe(200);

      // Revoking non-existent session returns 404
      const notFoundRevoke = await request(app)
        .delete('/auth/sessions/non-existent-session-id')
        .set('Authorization', `Bearer ${token2}`);
      expect(notFoundRevoke.status).toBe(404);
    });

    it('supports current session logout (POST /auth/logout)', async () => {
      const login = await request(app).post('/auth/login').send({ userId: 'user1', password: 'changeme' });
      const token = login.body.accessToken;

      const logoutRes = await request(app)
        .post('/auth/logout')
        .set('Authorization', `Bearer ${token}`);

      expect(logoutRes.status).toBe(200);
      expect(logoutRes.body.message).toBe('Logged out successfully.');

      // Subsequent call with token fails
      const checkRes = await request(app)
        .get('/api/protected/user')
        .set('Authorization', `Bearer ${token}`);
      expect(checkRes.status).toBe(401);
    });

    it('supports logout everywhere (DELETE /auth/sessions)', async () => {
      // Create 3 sessions
      const s1 = await request(app).post('/auth/login').send({ userId: 'user1', password: 'changeme' });
      const s2 = await request(app).post('/auth/login').send({ userId: 'user1', password: 'changeme' });
      const s3 = await request(app).post('/auth/login').send({ userId: 'user1', password: 'changeme' });

      const token1 = s1.body.accessToken;
      const token2 = s2.body.accessToken;
      const token3 = s3.body.accessToken;

      // Revoke all sessions using token 3
      const revokeAllRes = await request(app)
        .delete('/auth/sessions')
        .set('Authorization', `Bearer ${token3}`);

      expect(revokeAllRes.status).toBe(200);
      expect(revokeAllRes.body.count).toBe(3);

      // All 3 tokens are now invalid
      for (const tok of [token1, token2, token3]) {
        const res = await request(app)
          .get('/api/protected/user')
          .set('Authorization', `Bearer ${tok}`);
        expect(res.status).toBe(401);
      }
    });
  });
});
