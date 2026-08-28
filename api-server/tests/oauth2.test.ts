/**
 * Test suite for Issue #1442: OAuth2 routes, services, and identity store
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import crypto from 'crypto';
import { Keypair } from '@stellar/stellar-sdk';
import oauth2Router from '../src/routes/oauth2.js';
import { createV1Router } from '../src/routes/v1/index.js';
import { createV2Router } from '../src/routes/v2/index.js';
import {
  isSupportedProvider,
  buildAuthorizationUrl,
  getProviderConfig,
  verifyIdToken,
  resolveIdentity,
  exchangeCodeForToken,
} from '../src/services/oauth2.js';
import {
  OAuthIdentityStore,
  getDefaultOAuthIdentityStore,
  _setDefaultOAuthIdentityStoreForTest,
} from '../src/services/oauthIdentityStore.js';
import fs from 'fs';
import path from 'path';

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/auth/oauth2', oauth2Router);
  return app;
}

function makeV1App() {
  const app = express();
  app.use(express.json());
  app.use('/api/v1', createV1Router({
    simulateCall: vi.fn(),
    u64Val: vi.fn(),
    u32Val: vi.fn(),
    addressVal: vi.fn(),
  }));
  return app;
}

function makeV2App() {
  const app = express();
  app.use(express.json());
  app.use('/api/v2', createV2Router({
    simulateCall: vi.fn(),
    u64Val: vi.fn(),
    u32Val: vi.fn(),
    addressVal: vi.fn(),
  }));
  return app;
}

describe('OAuth2 Services and Routes (#1442)', () => {
  let testStoreDir: string;
  let testStore: OAuthIdentityStore;
  let originalFetch: typeof global.fetch;

  // RSA Key pair for testing OIDC ID token generation and validation
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });

  const jwk = crypto.createPublicKey(publicKey).export({ format: 'jwk' });
  const kid = 'test-key-id-1';

  function createSignedIdToken(payload: Record<string, unknown>, keyId = kid): string {
    const header = {
      alg: 'RS256',
      typ: 'JWT',
      kid: keyId,
    };
    const headerB64 = Buffer.from(JSON.stringify(header)).toString('base64url');
    const payloadB64 = Buffer.from(JSON.stringify(payload)).toString('base64url');
    const signingInput = `${headerB64}.${payloadB64}`;

    const signer = crypto.createSign('RSA-SHA256');
    signer.update(signingInput);
    const signatureB64 = signer.sign(privateKey, 'base64url');

    return `${signingInput}.${signatureB64}`;
  }

  function signLinkMessage(provider: string, subject: string, keypair: Keypair): string {
    const message = Buffer.from(
      `QuorumProof OAuth2 Identity Link\nprovider:${provider}\nsubject:${subject}\naddress:${keypair.publicKey()}`,
      'utf8'
    );
    return keypair.sign(message).toString('hex');
  }

  beforeEach(() => {
    testStoreDir = path.join(process.cwd(), '.data', `test-oauth-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    testStore = new OAuthIdentityStore({ dataDir: testStoreDir });
    _setDefaultOAuthIdentityStoreForTest(testStore);

    originalFetch = global.fetch;
  });

  afterEach(() => {
    _setDefaultOAuthIdentityStoreForTest(undefined);
    global.fetch = originalFetch;
    if (fs.existsSync(testStoreDir)) {
      fs.rmSync(testStoreDir, { recursive: true, force: true });
    }
  });

  // ─── Provider Utilities ──────────────────────────────────────────────────

  describe('isSupportedProvider & getProviderConfig', () => {
    it('identifies supported providers', () => {
      expect(isSupportedProvider('google')).toBe(true);
      expect(isSupportedProvider('microsoft')).toBe(true);
      expect(isSupportedProvider('github')).toBe(true);
      expect(isSupportedProvider('twitter')).toBe(false);
      expect(isSupportedProvider('')).toBe(false);
    });

    it('returns valid config for google', () => {
      const config = getProviderConfig('google');
      expect(config.name).toBe('google');
      expect(config.authorizationEndpoint).toBe('https://accounts.google.com/o/oauth2/v2/auth');
      expect(config.tokenEndpoint).toBe('https://oauth2.googleapis.com/token');
      expect(config.jwksUri).toBe('https://www.googleapis.com/oauth2/v3/certs');
      expect(config.issuer).toBe('https://accounts.google.com');
      expect(config.scope).toContain('openid');
    });

    it('returns valid config for microsoft', () => {
      const config = getProviderConfig('microsoft');
      expect(config.name).toBe('microsoft');
      expect(config.authorizationEndpoint).toContain('login.microsoftonline.com');
      expect(config.tokenEndpoint).toContain('login.microsoftonline.com');
      expect(config.jwksUri).toContain('login.microsoftonline.com');
    });

    it('returns valid config for github', () => {
      const config = getProviderConfig('github');
      expect(config.name).toBe('github');
      expect(config.authorizationEndpoint).toBe('https://github.com/login/oauth/authorize');
      expect(config.tokenEndpoint).toBe('https://github.com/login/oauth/access_token');
      expect(config.jwksUri).toBeUndefined();
    });
  });

  // ─── Authorization URL ───────────────────────────────────────────────────

  describe('buildAuthorizationUrl & GET /auth/oauth2/:provider/authorize', () => {
    it('builds a valid authorization url with state', () => {
      const state = 'random-state-12345';
      const url = buildAuthorizationUrl('google', state);
      const parsed = new URL(url);
      expect(parsed.origin + parsed.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
      expect(parsed.searchParams.get('state')).toBe(state);
      expect(parsed.searchParams.get('response_type')).toBe('code');
      expect(parsed.searchParams.get('scope')).toBe('openid email profile');
    });

    it('GET /auth/oauth2/google/authorize returns 200 with consent URL and state', async () => {
      const app = makeApp();
      const res = await request(app).get('/auth/oauth2/google/authorize');
      expect(res.status).toBe(200);
      expect(res.body.provider).toBe('google');
      expect(res.body.state).toHaveLength(32); // 16 bytes hex
      expect(res.body.url).toContain('https://accounts.google.com');
      expect(res.body.url).toContain(`state=${res.body.state}`);
    });

    it('GET /auth/oauth2/microsoft/authorize returns 200 with microsoft consent URL', async () => {
      const app = makeApp();
      const res = await request(app).get('/auth/oauth2/microsoft/authorize');
      expect(res.status).toBe(200);
      expect(res.body.provider).toBe('microsoft');
      expect(res.body.url).toContain('login.microsoftonline.com');
    });

    it('GET /auth/oauth2/github/authorize returns 200 with github consent URL', async () => {
      const app = makeApp();
      const res = await request(app).get('/auth/oauth2/github/authorize');
      expect(res.status).toBe(200);
      expect(res.body.provider).toBe('github');
      expect(res.body.url).toContain('github.com/login/oauth/authorize');
    });

    it('GET /auth/oauth2/unsupported/authorize returns 400', async () => {
      const app = makeApp();
      const res = await request(app).get('/auth/oauth2/unsupported/authorize');
      expect(res.status).toBe(400);
      expect(res.body.error).toContain('Unsupported OAuth2 provider');
    });
  });

  // ─── ID Token Verification ──────────────────────────────────────────────

  describe('verifyIdToken unit tests', () => {
    it('validates a valid RS256 token against JWKS', async () => {
      const now = Math.floor(Date.now() / 1000);
      const token = createSignedIdToken({
        iss: 'https://accounts.google.com',
        sub: 'google-user-123',
        aud: '', // matches empty process.env.OAUTH_GOOGLE_CLIENT_ID
        exp: now + 3600,
        iat: now,
        email: 'alice@gmail.com',
        name: 'Alice Google',
      });

      global.fetch = vi.fn().mockImplementation(async (url: string) => {
        if (url.includes('certs') || url.includes('keys')) {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              keys: [{ kty: 'RSA', kid, n: jwk.n, e: jwk.e }],
            }),
          };
        }
        return { ok: false, status: 404 };
      });

      const claims = await verifyIdToken('google', token);
      expect(claims.sub).toBe('google-user-123');
      expect(claims.email).toBe('alice@gmail.com');
      expect(claims.name).toBe('Alice Google');
    });

    it('throws when ID token has expired', async () => {
      const now = Math.floor(Date.now() / 1000);
      const token = createSignedIdToken({
        iss: 'https://accounts.google.com',
        sub: 'google-user-123',
        aud: '',
        exp: now - 100, // expired
        iat: now - 3600,
      });

      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ keys: [{ kty: 'RSA', kid, n: jwk.n, e: jwk.e }] }),
      });

      await expect(verifyIdToken('google', token)).rejects.toThrow('ID token has expired');
    });

    it('throws when issuer does not match', async () => {
      const now = Math.floor(Date.now() / 1000);
      const token = createSignedIdToken({
        iss: 'https://evil-issuer.com',
        sub: 'google-user-123',
        aud: '',
        exp: now + 3600,
        iat: now,
      });

      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ keys: [{ kty: 'RSA', kid, n: jwk.n, e: jwk.e }] }),
      });

      await expect(verifyIdToken('google', token)).rejects.toThrow('Unexpected ID token issuer');
    });

    it('throws when audience does not match', async () => {
      const now = Math.floor(Date.now() / 1000);
      const token = createSignedIdToken({
        iss: 'https://accounts.google.com',
        sub: 'google-user-123',
        aud: 'some-other-client-id',
        exp: now + 3600,
        iat: now,
      });

      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ keys: [{ kty: 'RSA', kid, n: jwk.n, e: jwk.e }] }),
      });

      await expect(verifyIdToken('google', token)).rejects.toThrow('ID token audience does not match this client');
    });

    it('throws when token is malformed', async () => {
      await expect(verifyIdToken('google', 'not.a.valid.jwt.token')).rejects.toThrow('Malformed ID token');
    });

    it('throws for provider without JWKS (github)', async () => {
      await expect(verifyIdToken('github', 'any.jwt.token')).rejects.toThrow('does not issue OIDC ID tokens');
    });
  });

  // ─── POST /auth/oauth2/callback ──────────────────────────────────────────

  describe('POST /auth/oauth2/callback', () => {
    it('successfully links Google identity with valid code and signature', async () => {
      const kp = Keypair.random();
      const stellarAddress = kp.publicKey();
      const subject = 'google-sub-456';
      const email = 'bob@example.com';
      const signature = signLinkMessage('google', subject, kp);

      const now = Math.floor(Date.now() / 1000);
      const idToken = createSignedIdToken({
        iss: 'https://accounts.google.com',
        sub: subject,
        aud: '',
        exp: now + 3600,
        iat: now,
        email,
        name: 'Bob Builder',
      });

      global.fetch = vi.fn().mockImplementation(async (url: string) => {
        if (url.includes('oauth2.googleapis.com/token')) {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              access_token: 'mock-access-token',
              id_token: idToken,
              token_type: 'Bearer',
            }),
          };
        }
        if (url.includes('certs')) {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              keys: [{ kty: 'RSA', kid, n: jwk.n, e: jwk.e }],
            }),
          };
        }
        return { ok: false, status: 404 };
      });

      const app = makeApp();
      const res = await request(app)
        .post('/auth/oauth2/callback')
        .send({
          provider: 'google',
          code: 'valid-auth-code',
          stellarAddress,
          signature,
        });

      expect(res.status).toBe(200);
      expect(res.body.provider).toBe('google');
      expect(res.body.subject).toBe(subject);
      expect(res.body.email).toBe(email);
      expect(res.body.name).toBe('Bob Builder');
      expect(res.body.stellarAddress).toBe(stellarAddress);
      expect(res.body.linkedAt).toBeDefined();

      // Verify stored in identity store
      const stored = testStore.getByIdentity('google', subject);
      expect(stored).toBeDefined();
      expect(stored?.stellarAddress).toBe(stellarAddress);
      expect(stored?.email).toBe(email);
    });

    it('successfully links GitHub identity with valid code and signature', async () => {
      const kp = Keypair.random();
      const stellarAddress = kp.publicKey();
      const githubId = 987654;
      const subject = String(githubId);
      const signature = signLinkMessage('github', subject, kp);

      global.fetch = vi.fn().mockImplementation(async (url: string) => {
        if (url.includes('github.com/login/oauth/access_token')) {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              access_token: 'gh-mock-access-token',
              token_type: 'bearer',
              scope: 'read:user,user:email',
            }),
          };
        }
        if (url.includes('api.github.com/user')) {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              id: githubId,
              login: 'octocat',
              email: 'octocat@github.com',
              name: 'The Octocat',
            }),
          };
        }
        return { ok: false, status: 404 };
      });

      const app = makeApp();
      const res = await request(app)
        .post('/auth/oauth2/callback')
        .send({
          provider: 'github',
          code: 'valid-gh-code',
          stellarAddress,
          signature,
        });

      expect(res.status).toBe(200);
      expect(res.body.provider).toBe('github');
      expect(res.body.subject).toBe(subject);
      expect(res.body.email).toBe('octocat@github.com');
      expect(res.body.name).toBe('The Octocat');
      expect(res.body.stellarAddress).toBe(stellarAddress);
    });

    it('returns 400 when required fields are missing', async () => {
      const app = makeApp();

      const resNoProvider = await request(app).post('/auth/oauth2/callback').send({
        code: 'code',
        stellarAddress: 'G...',
        signature: 'sig',
      });
      expect(resNoProvider.status).toBe(400);
      expect(resNoProvider.body.error).toContain('provider must be one of');

      const resNoCode = await request(app).post('/auth/oauth2/callback').send({
        provider: 'google',
        stellarAddress: 'G...',
        signature: 'sig',
      });
      expect(resNoCode.status).toBe(400);
      expect(resNoCode.body.error).toContain('code is required');

      const resNoAddress = await request(app).post('/auth/oauth2/callback').send({
        provider: 'google',
        code: 'code',
        signature: 'sig',
      });
      expect(resNoAddress.status).toBe(400);
      expect(resNoAddress.body.error).toContain('stellarAddress is required');

      const resNoSig = await request(app).post('/auth/oauth2/callback').send({
        provider: 'google',
        code: 'code',
        stellarAddress: 'G...',
      });
      expect(resNoSig.status).toBe(400);
      expect(resNoSig.body.error).toContain('signature is required');
    });

    it('returns 401 when code exchange or provider verification fails', async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 401,
      });

      const kp = Keypair.random();
      const app = makeApp();
      const res = await request(app)
        .post('/auth/oauth2/callback')
        .send({
          provider: 'google',
          code: 'expired-or-invalid-code',
          stellarAddress: kp.publicKey(),
          signature: signLinkMessage('google', 'some-sub', kp),
        });

      expect(res.status).toBe(401);
      expect(res.body.error).toContain('OAuth2 authentication failed');
    });

    it('returns 401 when signature verification fails', async () => {
      const kp = Keypair.random();
      const wrongKp = Keypair.random();
      const subject = 'google-sub-789';
      // Signed with a different keypair
      const wrongSignature = signLinkMessage('google', subject, wrongKp);

      const now = Math.floor(Date.now() / 1000);
      const idToken = createSignedIdToken({
        iss: 'https://accounts.google.com',
        sub: subject,
        aud: '',
        exp: now + 3600,
        iat: now,
      });

      global.fetch = vi.fn().mockImplementation(async (url: string) => {
        if (url.includes('token')) {
          return {
            ok: true,
            status: 200,
            json: async () => ({ id_token: idToken }),
          };
        }
        if (url.includes('certs')) {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              keys: [{ kty: 'RSA', kid, n: jwk.n, e: jwk.e }],
            }),
          };
        }
        return { ok: false, status: 404 };
      });

      const app = makeApp();
      const res = await request(app)
        .post('/auth/oauth2/callback')
        .send({
          provider: 'google',
          code: 'valid-code',
          stellarAddress: kp.publicKey(),
          signature: wrongSignature,
        });

      expect(res.status).toBe(401);
      expect(res.body.error).toContain('Invalid signature');
    });
  });

  // ─── GET /auth/oauth2/identities/:stellarAddress ─────────────────────────

  describe('GET /auth/oauth2/identities/:stellarAddress', () => {
    it('returns all linked identities for an address', async () => {
      const kp = Keypair.random();
      const addr = kp.publicKey();

      testStore.link('google', 'sub-1', addr, 'user1@gmail.com');
      testStore.link('github', 'sub-2', addr, 'user1@github.com');

      const app = makeApp();
      const res = await request(app).get(`/auth/oauth2/identities/${addr}`);
      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(2);
      expect(res.body.data.map((d: { provider: string }) => d.provider)).toEqual(['google', 'github']);
    });

    it('returns empty array when address has no linked identities', async () => {
      const kp = Keypair.random();
      const app = makeApp();
      const res = await request(app).get(`/auth/oauth2/identities/${kp.publicKey()}`);
      expect(res.status).toBe(200);
      expect(res.body.data).toEqual([]);
    });
  });

  // ─── Identity Store Deduplication & Methods ─────────────────────────────

  describe('OAuthIdentityStore deduplication and lifecycle', () => {
    it('deduplicates when re-linking an existing identity to a new address', () => {
      const kp1 = Keypair.random();
      const kp2 = Keypair.random();

      // First link to address 1
      testStore.link('google', 'google-user-999', kp1.publicKey(), 'first@example.com');
      expect(testStore.getByIdentity('google', 'google-user-999')?.stellarAddress).toBe(kp1.publicKey());
      expect(testStore.getByStellarAddress(kp1.publicKey())).toHaveLength(1);

      // Re-link same identity to address 2
      testStore.link('google', 'google-user-999', kp2.publicKey(), 'second@example.com');
      expect(testStore.getByIdentity('google', 'google-user-999')?.stellarAddress).toBe(kp2.publicKey());
      expect(testStore.getByIdentity('google', 'google-user-999')?.email).toBe('second@example.com');

      // Address 1 no longer has the link; Address 2 has it
      expect(testStore.getByStellarAddress(kp1.publicKey())).toHaveLength(0);
      expect(testStore.getByStellarAddress(kp2.publicKey())).toHaveLength(1);
    });

    it('unlinks an identity correctly', () => {
      const kp = Keypair.random();
      testStore.link('microsoft', 'ms-sub-1', kp.publicKey());
      expect(testStore.getByIdentity('microsoft', 'ms-sub-1')).toBeDefined();

      const unlinked = testStore.unlink('microsoft', 'ms-sub-1');
      expect(unlinked).toBe(true);
      expect(testStore.getByIdentity('microsoft', 'ms-sub-1')).toBeUndefined();
      expect(testStore.unlink('microsoft', 'ms-sub-1')).toBe(false);
    });

    it('persists across new store instance pointing to same dataDir', () => {
      const kp = Keypair.random();
      testStore.link('github', '12345', kp.publicKey(), 'persist@example.com');

      const secondStore = new OAuthIdentityStore({ dataDir: testStoreDir });
      const found = secondStore.getByIdentity('github', '12345');
      expect(found).toBeDefined();
      expect(found?.stellarAddress).toBe(kp.publicKey());
      expect(found?.email).toBe('persist@example.com');
    });
  });

  // ─── Router Mounting in v1 and v2 ────────────────────────────────────────

  describe('v1 and v2 router mounting', () => {
    it('v1 router mounts oauth2 routes under /oauth2', async () => {
      const app = makeV1App();
      const res = await request(app).get('/api/v1/oauth2/google/authorize');
      expect(res.status).toBe(200);
      expect(res.body.provider).toBe('google');
    });

    it('v2 router mounts oauth2 routes under /oauth2', async () => {
      const app = makeV2App();
      const res = await request(app).get('/api/v2/oauth2/github/authorize');
      expect(res.status).toBe(200);
      expect(res.body.provider).toBe('github');
    });
  });
});
