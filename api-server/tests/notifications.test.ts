/**
 * Tests for #928: notification preferences per credential type.
 */
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  setPreferences,
  getPreferences,
  getHistory,
  dispatchNotification,
  flushPendingBatch,
} from '../src/notifications.js';
import express from 'express';
import request from 'supertest';

// ---- Unit tests for dispatchNotification with credential_type_filters ----

describe('dispatchNotification (#928 credential_type_filters)', () => {
  beforeEach(() => {
    // Reset by setting fresh prefs before each test
  });

  it('dispatches when no credential_type_filters are set', async () => {
    await setPreferences({
      address: 'G_NOFILTER',
      email: 'no@filter.com',
      channels: ['email'],
      events: ['credential_issued'],
      enabled: true,
    });

    // Should not throw — dispatch proceeds (email is stubbed to console)
    await expect(
      dispatchNotification('G_NOFILTER', 'credential_issued', 1)
    ).resolves.toBeUndefined();
  });

  it('dispatches when credential type matches filter', async () => {
    await setPreferences({
      address: 'G_TYPE_MATCH',
      email: 'match@test.com',
      channels: ['email'],
      events: ['credential_issued'],
      credential_type_filters: [1, 2], // Degree + License
      enabled: true,
    });

    await dispatchNotification('G_TYPE_MATCH', 'credential_issued', 10, undefined, 1);
    await flushPendingBatch('G_TYPE_MATCH');

    const history = await getHistory('G_TYPE_MATCH');
    expect(history.some((h) => h.credential_id === 10)).toBe(true);
  });

  it('skips dispatch when credential type is NOT in filter', async () => {
    await setPreferences({
      address: 'G_TYPE_SKIP',
      email: 'skip@test.com',
      channels: ['email'],
      events: ['credential_issued'],
      credential_type_filters: [2], // License only
      enabled: true,
    });

    const historyBefore = (await getHistory('G_TYPE_SKIP')).length;
    await dispatchNotification('G_TYPE_SKIP', 'credential_issued', 20, undefined, 1); // type=1 (Degree)
    await flushPendingBatch('G_TYPE_SKIP');
    const historyAfter = (await getHistory('G_TYPE_SKIP')).length;

    expect(historyAfter).toBe(historyBefore); // no new record
  });

  it('dispatches when credential_type_filters is empty (allow all)', async () => {
    await setPreferences({
      address: 'G_EMPTY_FILTER',
      email: 'empty@test.com',
      channels: ['email'],
      events: ['credential_issued'],
      credential_type_filters: [],
      enabled: true,
    });

    await expect(
      dispatchNotification('G_EMPTY_FILTER', 'credential_issued', 30, 3)
    ).resolves.toBeUndefined();
  });
});

// ---- HTTP route tests ----

import notificationsRouter from '../src/routes/notifications.js';
import { vi } from 'vitest';
import {
  SessionManager,
  getDefaultSessionManager,
  _setDefaultSessionManagerForTest,
  _resetDefaultSessionManagerForTest,
} from '../src/services/sessionManager.js';

// Mock ws broadcastEvent to avoid needing a real WS server
vi.mock('../src/ws/server.js', () => ({
  broadcastEvent: vi.fn(() => 0),
}));

const authDir = fs.mkdtempSync(path.join(os.tmpdir(), 'notifications-auth-'));
process.env.JWT_SECRET = 'test-secret-notifications-1749';
_setDefaultSessionManagerForTest(new SessionManager({ dataDir: authDir }));
const ADMIN_AUTH = `Bearer ${getDefaultSessionManager().createSession('GADMIN_NOTIF', { role: 'admin', mfaVerified: true }).accessToken}`;

afterAll(() => {
  _resetDefaultSessionManagerForTest();
  fs.rmSync(authDir, { recursive: true, force: true });
  delete process.env.JWT_SECRET;
});

function createRouterApp() {
  const inner = express();
  inner.use(express.json());
  inner.use('/api/notifications', notificationsRouter);
  return inner;
}

/** Shared HTTP app: every request carries the admin token unless the test sets its own. */
const rawApp = createRouterApp();
const app = express();
app.use((req, _res, next) => {
  if (!req.headers.authorization) req.headers.authorization = ADMIN_AUTH;
  next();
});
app.use(rawApp);

describe('PUT /api/notifications/preferences with credential_type_filters (#928)', () => {
  it('saves credential_type_filters in preferences', async () => {
    const res = await request(app)
      .put('/api/notifications/preferences')
      .send({
        address: 'G_HTTP_TEST',
        email: 'http@test.com',
        channels: ['email'],
        events: ['credential_issued'],
        credential_type_filters: [1, 3],
        enabled: true,
      });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);

    const get = await request(app).get('/api/notifications/preferences/G_HTTP_TEST');
    expect(get.status).toBe(200);
    expect(get.body.credential_type_filters).toEqual([1, 3]);
  });

  it('accepts preferences without credential_type_filters (backward-compat)', async () => {
    const res = await request(app)
      .put('/api/notifications/preferences')
      .send({
        address: 'G_NO_FILTER_HTTP',
        email: 'nofilter@test.com',
        channels: ['email'],
        events: ['credential_revoked'],
        enabled: true,
      });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  it('rejects invalid credential_type_filters (non-integer)', async () => {
    const res = await request(app)
      .put('/api/notifications/preferences')
      .send({
        address: 'G_BAD_FILTER',
        email: 'bad@test.com',
        channels: ['email'],
        events: ['credential_issued'],
        credential_type_filters: ['Degree'], // strings not allowed
        enabled: true,
      });

    expect(res.status).toBe(400);
  });
});

describe('POST /api/notifications/send with credential_type (#928)', () => {
  it('accepts credential_type in send payload', async () => {
    // Ensure prefs exist for this address with no type filter
    await request(app)
      .put('/api/notifications/preferences')
      .send({
        address: 'G_SEND_TYPE',
        email: 'send@type.com',
        channels: ['email'],
        events: ['credential_issued'],
        enabled: true,
      });

    const res = await request(app)
      .post('/api/notifications/send')
      .send({
        address: 'G_SEND_TYPE',
        event: 'credential_issued',
        credential_id: 5,
        credential_type: 2,
      });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });
});

// ---- Authentication and address scoping (#1749) ----

describe('notifications auth and address scoping (#1749)', () => {
  const OWN = 'G_OWN_1749';
  const OTHER = 'G_OTHER_1749';
  const ISSUER = 'G_ISSUER_1749';

  const tokenFor = (sub: string, role?: string) =>
    `Bearer ${getDefaultSessionManager().createSession(sub, { role, mfaVerified: true }).accessToken}`;

  const prefs = (address: string) => ({
    address,
    email: `${address.toLowerCase()}@test.com`,
    channels: ['email'],
    events: ['credential_issued'],
    enabled: true,
  });

  beforeEach(async () => {
    await setPreferences(prefs(OWN));
    await setPreferences(prefs(OTHER));
    await dispatchNotification(OWN, 'credential_issued', 1749001);
    await flushPendingBatch(OWN);
    await dispatchNotification(OTHER, 'credential_issued', 1749002);
    await flushPendingBatch(OTHER);
  });

  describe('unauthenticated requests', () => {
    it('rejects reads of preferences with 401', async () => {
      const res = await request(rawApp).get(`/api/notifications/preferences/${OWN}`);
      expect(res.status).toBe(401);
    });

    it('rejects history reads with 401', async () => {
      const res = await request(rawApp).get('/api/notifications/history');
      expect(res.status).toBe(401);
    });

    it('rejects preference writes with 401', async () => {
      const res = await request(rawApp).put('/api/notifications/preferences').send(prefs(OWN));
      expect(res.status).toBe(401);
    });

    it('rejects unauthenticated /send with 401 and sends nothing', async () => {
      const res = await request(rawApp).post('/api/notifications/send').send({
        address: OWN,
        event: 'credential_issued',
        credential_id: 1749009,
        issuer: ISSUER,
      });
      expect(res.status).toBe(401);
      const history = await getHistory(OWN);
      expect(history.some((h) => h.credential_id === 1749009)).toBe(false);
    });
  });

  describe('cross-address reads and writes', () => {
    it('forbids reading another address’s preferences', async () => {
      const res = await request(rawApp)
        .get(`/api/notifications/preferences/${OTHER}`)
        .set('Authorization', tokenFor(OWN, 'verifier'));
      expect(res.status).toBe(403);
      expect(res.body.email).toBeUndefined();
    });

    it('allows reading one’s own preferences', async () => {
      const res = await request(rawApp)
        .get(`/api/notifications/preferences/${OWN}`)
        .set('Authorization', tokenFor(OWN, 'verifier'));
      expect(res.status).toBe(200);
      expect(res.body.address).toBe(OWN);
    });

    it('lets an admin read any address’s preferences', async () => {
      const res = await request(rawApp)
        .get(`/api/notifications/preferences/${OTHER}`)
        .set('Authorization', tokenFor('G_ADMIN_1749', 'admin'));
      expect(res.status).toBe(200);
    });

    it('forbids overwriting another address’s preferences', async () => {
      const res = await request(rawApp)
        .put('/api/notifications/preferences')
        .set('Authorization', tokenFor(OWN, 'verifier'))
        .send(prefs(OTHER));
      expect(res.status).toBe(403);
    });
  });

  describe('history scoping', () => {
    it('returns only the caller’s history when no address is given', async () => {
      const res = await request(rawApp)
        .get('/api/notifications/history')
        .set('Authorization', tokenFor(OWN, 'verifier'));
      expect(res.status).toBe(200);
      expect(res.body.data.length).toBeGreaterThan(0);
      expect(res.body.data.every((h: { address: string }) => h.address === OWN)).toBe(true);
    });

    it('forbids asking for another address’s history', async () => {
      const res = await request(rawApp)
        .get(`/api/notifications/history?address=${OTHER}`)
        .set('Authorization', tokenFor(OWN, 'verifier'));
      expect(res.status).toBe(403);
    });

    it('lets an admin read history for any address', async () => {
      const res = await request(rawApp)
        .get(`/api/notifications/history?address=${OTHER}`)
        .set('Authorization', tokenFor('G_ADMIN_1749', 'admin'));
      expect(res.status).toBe(200);
      expect(res.body.data.every((h: { address: string }) => h.address === OTHER)).toBe(true);
    });
  });

  describe('POST /send', () => {
    const send = (token: string | null, body: Record<string, unknown>) => {
      const req = request(rawApp).post('/api/notifications/send');
      if (token) req.set('Authorization', token);
      return req.send(body);
    };

    it('forbids non-issuer roles', async () => {
      const res = await send(tokenFor('G_VERIFIER_1749', 'verifier'), {
        address: OWN,
        event: 'credential_issued',
        credential_id: 1749010,
        issuer: 'G_VERIFIER_1749',
      });
      expect(res.status).toBe(403);
    });

    it('forbids an issuer from sending events attributed to another issuer', async () => {
      const res = await send(tokenFor(ISSUER, 'issuer'), {
        address: OWN,
        event: 'credential_issued',
        credential_id: 1749011,
        issuer: 'G_SOMEONE_ELSE_1749',
      });
      expect(res.status).toBe(403);
    });

    it('allows an issuer to send events attributed to themselves', async () => {
      const res = await send(tokenFor(ISSUER, 'issuer'), {
        address: OWN,
        event: 'credential_issued',
        credential_id: 1749012,
        issuer: ISSUER,
      });
      expect(res.status).toBe(200);
    });
  });
});
