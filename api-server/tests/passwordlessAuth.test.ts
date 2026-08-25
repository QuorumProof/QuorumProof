/**
 * Tests for Issue #1302: Passwordless Authentication
 * Tests for Issue #1366: Durable multi-instance support
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import fs from 'fs';
import path from 'path';
import {
  PasswordlessAuthService,
  createMagicLinkToken,
  verifyMagicLinkToken,
  createWebAuthnChallenge,
  verifyWebAuthnRegistration,
  verifyWebAuthnAuthentication,
  getCredentialsForUser,
  clearPasswordlessStores,
  TOKEN_EXPIRY_MS,
  CHALLENGE_EXPIRY_MS,
  _setDefaultPasswordlessAuthServiceForTest,
} from '../src/services/passwordlessAuth.js';
import passwordlessAuthRouter from '../src/routes/passwordlessAuth.js';

// ─── Service Unit Tests ────────────────────────────────────────────────────────

describe('Magic Link Service', () => {
  beforeEach(() => clearPasswordlessStores());

  it('creates a magic link token for valid email', () => {
    const { token, expires_at } = createMagicLinkToken('alice@example.com');
    expect(token).toHaveLength(64); // 32 bytes hex
    expect(expires_at).toBeGreaterThan(Date.now());
    expect(expires_at).toBeLessThanOrEqual(Date.now() + TOKEN_EXPIRY_MS + 100);
  });

  it('throws for invalid email', () => {
    expect(() => createMagicLinkToken('not-an-email')).toThrow();
    expect(() => createMagicLinkToken('')).toThrow();
  });

  it('verifies a valid token and returns email', () => {
    const { token } = createMagicLinkToken('alice@example.com');
    const result = verifyMagicLinkToken(token);
    expect(result.success).toBe(true);
    expect(result.email).toBe('alice@example.com');
  });

  it('token is single-use', () => {
    const { token } = createMagicLinkToken('alice@example.com');
    verifyMagicLinkToken(token); // First use
    const second = verifyMagicLinkToken(token);
    expect(second.success).toBe(false);
    expect(second.error).toContain('already been used');
  });

  it('rejects an invalid token', () => {
    const result = verifyMagicLinkToken('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
    expect(result.success).toBe(false);
    expect(result.error).toContain('Invalid or expired');
  });

  it('rejects empty token', () => {
    const result = verifyMagicLinkToken('');
    expect(result.success).toBe(false);
    expect(result.error).toBe('Missing token');
  });

  it('invalidates old token when new request is made for same email', () => {
    const { token: oldToken } = createMagicLinkToken('alice@example.com');
    createMagicLinkToken('alice@example.com'); // new request
    const result = verifyMagicLinkToken(oldToken);
    expect(result.success).toBe(false);
  });

  it('normalises email to lowercase', () => {
    const { token } = createMagicLinkToken('Alice@EXAMPLE.COM');
    const result = verifyMagicLinkToken(token);
    expect(result.email).toBe('alice@example.com');
  });
});

describe('WebAuthn Service', () => {
  beforeEach(() => clearPasswordlessStores());

  function makeClientDataJson(type: string, challenge: string): string {
    return Buffer.from(JSON.stringify({ type, challenge })).toString('base64url');
  }

  it('creates a registration challenge', () => {
    const record = createWebAuthnChallenge('user1', 'registration');
    expect(record.challenge).toHaveLength(43); // base64url of 32 bytes
    expect(record.user_id).toBe('user1');
    expect(record.type).toBe('registration');
    expect(record.expires_at).toBeGreaterThan(Date.now());
  });

  it('creates an authentication challenge', () => {
    const record = createWebAuthnChallenge('user1', 'authentication');
    expect(record.type).toBe('authentication');
  });

  it('throws for empty user_id', () => {
    expect(() => createWebAuthnChallenge('', 'registration')).toThrow();
  });

  it('verifies a valid registration', () => {
    const { challenge } = createWebAuthnChallenge('user1', 'registration');
    const clientDataJson = makeClientDataJson('webauthn.create', challenge);
    const result = verifyWebAuthnRegistration({
      challenge,
      credential_id: 'cred-abc-123',
      public_key: 'pubkey-xyz',
      client_data_json: clientDataJson,
      user_id: 'user1',
    });
    expect(result.success).toBe(true);
    expect(result.credential?.credential_id).toBe('cred-abc-123');
  });

  it('rejects registration with wrong challenge', () => {
    createWebAuthnChallenge('user1', 'registration');
    const clientDataJson = makeClientDataJson('webauthn.create', 'wrong-challenge');
    const result = verifyWebAuthnRegistration({
      challenge: 'wrong-challenge',
      credential_id: 'cred-abc',
      public_key: 'pubkey-xyz',
      client_data_json: clientDataJson,
      user_id: 'user1',
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain('Challenge not found');
  });

  it('rejects registration with wrong clientData type', () => {
    const { challenge } = createWebAuthnChallenge('user1', 'registration');
    const clientDataJson = makeClientDataJson('webauthn.get', challenge); // wrong type
    const result = verifyWebAuthnRegistration({
      challenge,
      credential_id: 'cred-abc',
      public_key: 'pubkey-xyz',
      client_data_json: clientDataJson,
      user_id: 'user1',
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain('clientData type');
  });

  it('rejects registration with user_id mismatch', () => {
    const { challenge } = createWebAuthnChallenge('user1', 'registration');
    const clientDataJson = makeClientDataJson('webauthn.create', challenge);
    const result = verifyWebAuthnRegistration({
      challenge,
      credential_id: 'cred-abc',
      public_key: 'pubkey-xyz',
      client_data_json: clientDataJson,
      user_id: 'user2', // different user
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain('user mismatch');
  });

  it('verifies a valid authentication', () => {
    // Register first.
    const regChallenge = createWebAuthnChallenge('user1', 'registration');
    const regClientData = makeClientDataJson('webauthn.create', regChallenge.challenge);
    verifyWebAuthnRegistration({
      challenge: regChallenge.challenge,
      credential_id: 'cred-abc',
      public_key: 'pubkey-xyz',
      client_data_json: regClientData,
      user_id: 'user1',
    });

    // Now authenticate.
    const authChallenge = createWebAuthnChallenge('user1', 'authentication');
    const authClientData = makeClientDataJson('webauthn.get', authChallenge.challenge);
    const result = verifyWebAuthnAuthentication({
      challenge: authChallenge.challenge,
      credential_id: 'cred-abc',
      client_data_json: authClientData,
      authenticator_data: 'authdata-stub',
      signature: 'sig-stub',
      sign_count: 1,
      user_id: 'user1',
    });
    expect(result.success).toBe(true);
  });

  it('rejects authentication with stale sign_count (replay attack)', () => {
    // Register.
    const regChallenge = createWebAuthnChallenge('user1', 'registration');
    const regClientData = makeClientDataJson('webauthn.create', regChallenge.challenge);
    verifyWebAuthnRegistration({
      challenge: regChallenge.challenge,
      credential_id: 'cred-replay',
      public_key: 'pubkey-xyz',
      client_data_json: regClientData,
      user_id: 'user1',
    });

    // First auth with sign_count=1.
    const ch1 = createWebAuthnChallenge('user1', 'authentication');
    verifyWebAuthnAuthentication({
      challenge: ch1.challenge,
      credential_id: 'cred-replay',
      client_data_json: makeClientDataJson('webauthn.get', ch1.challenge),
      authenticator_data: 'ad',
      signature: 'sig',
      sign_count: 1,
      user_id: 'user1',
    });

    // Replay with same sign_count=1.
    const ch2 = createWebAuthnChallenge('user1', 'authentication');
    const result = verifyWebAuthnAuthentication({
      challenge: ch2.challenge,
      credential_id: 'cred-replay',
      client_data_json: makeClientDataJson('webauthn.get', ch2.challenge),
      authenticator_data: 'ad',
      signature: 'sig',
      sign_count: 1, // not incremented
      user_id: 'user1',
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain('replay');
  });

  it('getCredentialsForUser returns registered credentials', () => {
    const { challenge } = createWebAuthnChallenge('user1', 'registration');
    const clientDataJson = makeClientDataJson('webauthn.create', challenge);
    verifyWebAuthnRegistration({
      challenge,
      credential_id: 'cred-user1',
      public_key: 'pk',
      client_data_json: clientDataJson,
      user_id: 'user1',
    });

    const creds = getCredentialsForUser('user1');
    expect(creds).toHaveLength(1);
    expect(creds[0].credential_id).toBe('cred-user1');
  });
});

// ─── Route Integration Tests ───────────────────────────────────────────────────

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/auth/passwordless', passwordlessAuthRouter);
  return app;
}

describe('POST /api/auth/passwordless/start', () => {
  beforeEach(() => clearPasswordlessStores());

  it('returns 202 for valid email', async () => {
    const res = await request(makeApp())
      .post('/api/auth/passwordless/start')
      .send({ email: 'alice@example.com' });
    expect(res.status).toBe(202);
    expect(res.body.message).toContain('Magic link');
    expect(res.body.magic_link_token).toHaveLength(64);
    expect(res.body.expires_at).toBeDefined();
  });

  it('returns 400 for missing email', async () => {
    const res = await request(makeApp())
      .post('/api/auth/passwordless/start')
      .send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('valid email');
  });

  it('returns 400 for invalid email', async () => {
    const res = await request(makeApp())
      .post('/api/auth/passwordless/start')
      .send({ email: 'notvalid' });
    expect(res.status).toBe(400);
  });
});

describe('POST /api/auth/passwordless/verify', () => {
  beforeEach(() => clearPasswordlessStores());

  it('verifies a valid magic link token', async () => {
    const startRes = await request(makeApp())
      .post('/api/auth/passwordless/start')
      .send({ email: 'bob@example.com' });

    const token = startRes.body.magic_link_token;
    const verifyRes = await request(makeApp())
      .post('/api/auth/passwordless/verify')
      .send({ token });

    expect(verifyRes.status).toBe(200);
    expect(verifyRes.body.success).toBe(true);
    expect(verifyRes.body.email).toBe('bob@example.com');
  });

  it('returns 401 for invalid token', async () => {
    const res = await request(makeApp())
      .post('/api/auth/passwordless/verify')
      .send({ token: 'a'.repeat(64) });
    expect(res.status).toBe(401);
  });

  it('returns 400 for missing token', async () => {
    const res = await request(makeApp())
      .post('/api/auth/passwordless/verify')
      .send({});
    expect(res.status).toBe(400);
  });
});

describe('WebAuthn registration routes', () => {
  beforeEach(() => clearPasswordlessStores());

  it('POST /api/auth/passwordless/webauthn/register/start returns challenge', async () => {
    const res = await request(makeApp())
      .post('/api/auth/passwordless/webauthn/register/start')
      .send({ user_id: 'user1' });
    expect(res.status).toBe(200);
    expect(res.body.challenge).toBeDefined();
    expect(res.body.rp.name).toBe('QuorumProof');
  });

  it('POST /api/auth/passwordless/webauthn/register/start returns 400 without user_id', async () => {
    const res = await request(makeApp())
      .post('/api/auth/passwordless/webauthn/register/start')
      .send({});
    expect(res.status).toBe(400);
  });

  it('POST /api/auth/passwordless/webauthn/register/verify returns 201 for valid registration', async () => {
    const startRes = await request(makeApp())
      .post('/api/auth/passwordless/webauthn/register/start')
      .send({ user_id: 'user2' });

    const challenge = startRes.body.challenge;
    const clientDataJson = Buffer.from(JSON.stringify({ type: 'webauthn.create', challenge })).toString('base64url');

    const verifyRes = await request(makeApp())
      .post('/api/auth/passwordless/webauthn/register/verify')
      .send({
        challenge,
        credential_id: 'cred-route-test',
        public_key: 'pk-test',
        client_data_json: clientDataJson,
        user_id: 'user2',
      });

    expect(verifyRes.status).toBe(201);
    expect(verifyRes.body.success).toBe(true);
    expect(verifyRes.body.credential.credential_id).toBe('cred-route-test');
  });

  it('POST /api/auth/passwordless/webauthn/register/verify returns 400 for missing fields', async () => {
    const res = await request(makeApp())
      .post('/api/auth/passwordless/webauthn/register/verify')
      .send({ user_id: 'user2' });
    expect(res.status).toBe(400);
  });
});

describe('WebAuthn authentication routes', () => {
  beforeEach(() => clearPasswordlessStores());

  it('POST /api/auth/passwordless/webauthn/authenticate/start returns challenge', async () => {
    const res = await request(makeApp())
      .post('/api/auth/passwordless/webauthn/authenticate/start')
      .send({ user_id: 'user3' });
    expect(res.status).toBe(200);
    expect(res.body.challenge).toBeDefined();
    expect(res.body.allowCredentials).toBeDefined();
  });

  it('POST /api/auth/passwordless/webauthn/authenticate/start returns 400 without user_id', async () => {
    const res = await request(makeApp())
      .post('/api/auth/passwordless/webauthn/authenticate/start')
      .send({});
    expect(res.status).toBe(400);
  });

  it('full registration + authentication flow', async () => {
    const app = makeApp();

    // Register.
    const regStart = await request(app)
      .post('/api/auth/passwordless/webauthn/register/start')
      .send({ user_id: 'flowuser' });
    const regChallenge = regStart.body.challenge;
    const regClientData = Buffer.from(JSON.stringify({ type: 'webauthn.create', challenge: regChallenge })).toString('base64url');
    await request(app)
      .post('/api/auth/passwordless/webauthn/register/verify')
      .send({
        challenge: regChallenge,
        credential_id: 'cred-flow',
        public_key: 'pk-flow',
        client_data_json: regClientData,
        user_id: 'flowuser',
      });

    // Authenticate.
    const authStart = await request(app)
      .post('/api/auth/passwordless/webauthn/authenticate/start')
      .send({ user_id: 'flowuser' });
    const authChallenge = authStart.body.challenge;
    const authClientData = Buffer.from(JSON.stringify({ type: 'webauthn.get', challenge: authChallenge })).toString('base64url');

    const authVerify = await request(app)
      .post('/api/auth/passwordless/webauthn/authenticate/verify')
      .send({
        challenge: authChallenge,
        credential_id: 'cred-flow',
        client_data_json: authClientData,
        authenticator_data: 'ad-stub',
        signature: 'sig-stub',
        sign_count: 1,
        user_id: 'flowuser',
      });

    expect(authVerify.status).toBe(200);
    expect(authVerify.body.success).toBe(true);
  });
});

// ─── Multi-Instance Tests (Issue #1366) ────────────────────────────────────────

describe('Multi-Instance Durability (Issue #1366)', () => {
  let dataDir: string;

  beforeEach(() => {
    // Use a temporary directory for each test
    dataDir = path.join(process.cwd(), '.data', `test-passwordless-${Date.now()}`);
    const service = new PasswordlessAuthService({ dataDir });
    _setDefaultPasswordlessAuthServiceForTest(service);
  });

  afterEach(() => {
    // Clean up test data directory
    if (fs.existsSync(dataDir)) {
      fs.rmSync(dataDir, { recursive: true });
    }
  });

  it('magic link token is single-use across instances (instance A creates, B redeems, A fails on second attempt)', () => {
    // Instance A process 1: create a token
    const serviceA1 = new PasswordlessAuthService({ dataDir });
    const { token } = serviceA1.createMagicLinkToken('alice@example.com');

    // Instance B process: redeem the token (same data directory, fresh instance that reloads from disk)
    const serviceB = new PasswordlessAuthService({ dataDir });
    const result1 = serviceB.verifyMagicLinkToken(token);
    expect(result1.success).toBe(true);
    expect(result1.email).toBe('alice@example.com');

    // Instance A process 2: attempt to redeem again (fresh instance that reloads from disk)
    const serviceA2 = new PasswordlessAuthService({ dataDir });
    const result2 = serviceA2.verifyMagicLinkToken(token);
    expect(result2.success).toBe(false);
    expect(result2.error).toContain('already been used');
  });

  it('WebAuthn credential registered on instance A is recognized by instance B', () => {
    // Instance A: create registration challenge and register credential
    const instanceA = new PasswordlessAuthService({ dataDir });
    const regChallenge = instanceA.createWebAuthnChallenge('user1', 'registration');
    const regClientData = Buffer.from(
      JSON.stringify({ type: 'webauthn.create', challenge: regChallenge.challenge })
    ).toString('base64url');

    const regResult = instanceA.verifyWebAuthnRegistration({
      challenge: regChallenge.challenge,
      credential_id: 'cred-multi-instance',
      public_key: 'pubkey-xyz',
      client_data_json: regClientData,
      user_id: 'user1',
    });
    expect(regResult.success).toBe(true);

    // Instance B: get credentials for user (should see the registered credential)
    const instanceB = new PasswordlessAuthService({ dataDir });
    const credentials = instanceB.getCredentialsForUser('user1');
    expect(credentials).toHaveLength(1);
    expect(credentials[0].credential_id).toBe('cred-multi-instance');

    // Instance B: authenticate with the credential (should succeed)
    const authChallenge = instanceB.createWebAuthnChallenge('user1', 'authentication');
    const authClientData = Buffer.from(
      JSON.stringify({ type: 'webauthn.get', challenge: authChallenge.challenge })
    ).toString('base64url');

    const authResult = instanceB.verifyWebAuthnAuthentication({
      challenge: authChallenge.challenge,
      credential_id: 'cred-multi-instance',
      client_data_json: authClientData,
      authenticator_data: 'authdata-stub',
      signature: 'sig-stub',
      sign_count: 1,
      user_id: 'user1',
    });
    expect(authResult.success).toBe(true);
  });

  it('WebAuthn credentials survive a simulated restart (new service instance, same data dir)', () => {
    // First instance: register credential
    const instance1 = new PasswordlessAuthService({ dataDir });
    const challenge1 = instance1.createWebAuthnChallenge('user1', 'registration');
    const clientData1 = Buffer.from(
      JSON.stringify({ type: 'webauthn.create', challenge: challenge1.challenge })
    ).toString('base64url');

    instance1.verifyWebAuthnRegistration({
      challenge: challenge1.challenge,
      credential_id: 'cred-persistent',
      public_key: 'pubkey-abc',
      client_data_json: clientData1,
      user_id: 'user1',
    });

    // Simulate restart: new instance, same data directory
    const instance2 = new PasswordlessAuthService({ dataDir });

    // Verify credential persisted
    const credentials = instance2.getCredentialsForUser('user1');
    expect(credentials).toHaveLength(1);
    expect(credentials[0].credential_id).toBe('cred-persistent');
    expect(credentials[0].public_key).toBe('pubkey-abc');
    expect(credentials[0].user_id).toBe('user1');
  });

  it('magic link token invalidation from instance A is visible to instance B', () => {
    const instanceA = new PasswordlessAuthService({ dataDir });
    const instanceB = new PasswordlessAuthService({ dataDir });

    // Create first token
    const { token: token1 } = instanceA.createMagicLinkToken('alice@example.com');

    // Create second token for same email (invalidates first)
    instanceA.createMagicLinkToken('alice@example.com');

    // Instance B attempts to redeem first token (should fail)
    const result = instanceB.verifyMagicLinkToken(token1);
    expect(result.success).toBe(false);
    expect(result.error).toContain('Invalid or expired');
  });

  it('WebAuthn sign_count update from instance A is visible to instance B', () => {
    // Register credential
    const serviceA1 = new PasswordlessAuthService({ dataDir });
    const challenge1 = serviceA1.createWebAuthnChallenge('user1', 'registration');
    const clientData1 = Buffer.from(
      JSON.stringify({ type: 'webauthn.create', challenge: challenge1.challenge })
    ).toString('base64url');

    serviceA1.verifyWebAuthnRegistration({
      challenge: challenge1.challenge,
      credential_id: 'cred-sign-count',
      public_key: 'pubkey-xyz',
      client_data_json: clientData1,
      user_id: 'user1',
    });

    // Authenticate on instance A with sign_count=1
    const serviceA2 = new PasswordlessAuthService({ dataDir });
    const authChallenge1 = serviceA2.createWebAuthnChallenge('user1', 'authentication');
    const authClientData1 = Buffer.from(
      JSON.stringify({ type: 'webauthn.get', challenge: authChallenge1.challenge })
    ).toString('base64url');

    serviceA2.verifyWebAuthnAuthentication({
      challenge: authChallenge1.challenge,
      credential_id: 'cred-sign-count',
      client_data_json: authClientData1,
      authenticator_data: 'ad',
      signature: 'sig',
      sign_count: 1,
      user_id: 'user1',
    });

    // Instance B attempts to authenticate with sign_count=1 (should fail as replay)
    const serviceB1 = new PasswordlessAuthService({ dataDir });
    const authChallenge2 = serviceB1.createWebAuthnChallenge('user1', 'authentication');
    const authClientData2 = Buffer.from(
      JSON.stringify({ type: 'webauthn.get', challenge: authChallenge2.challenge })
    ).toString('base64url');

    const result = serviceB1.verifyWebAuthnAuthentication({
      challenge: authChallenge2.challenge,
      credential_id: 'cred-sign-count',
      client_data_json: authClientData2,
      authenticator_data: 'ad',
      signature: 'sig',
      sign_count: 1, // same as before
      user_id: 'user1',
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain('replay');

    // Instance B authenticates with sign_count=2 (should succeed)
    const serviceB2 = new PasswordlessAuthService({ dataDir });
    const authChallenge3 = serviceB2.createWebAuthnChallenge('user1', 'authentication');
    const authClientData3 = Buffer.from(
      JSON.stringify({ type: 'webauthn.get', challenge: authChallenge3.challenge })
    ).toString('base64url');

    const result2 = serviceB2.verifyWebAuthnAuthentication({
      challenge: authChallenge3.challenge,
      credential_id: 'cred-sign-count',
      client_data_json: authClientData3,
      authenticator_data: 'ad',
      signature: 'sig',
      sign_count: 2,
      user_id: 'user1',
    });
    expect(result2.success).toBe(true);
  });
});
