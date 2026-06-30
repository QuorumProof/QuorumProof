/**
 * Tests for #928: notification preferences per credential type.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  setPreferences,
  getPreferences,
  getHistory,
  dispatchNotification,
} from '../src/notifications.js';
import express from 'express';
import request from 'supertest';

// ---- Unit tests for dispatchNotification with credential_type_filters ----

describe('dispatchNotification (#928 credential_type_filters)', () => {
  beforeEach(() => {
    // Reset by setting fresh prefs before each test
  });

  it('dispatches when no credential_type_filters are set', async () => {
    setPreferences({
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
    setPreferences({
      address: 'G_TYPE_MATCH',
      email: 'match@test.com',
      channels: ['email'],
      events: ['credential_issued'],
      credential_type_filters: [1, 2], // Degree + License
      enabled: true,
    });

    await expect(
      dispatchNotification('G_TYPE_MATCH', 'credential_issued', 10, 1)
    ).resolves.toBeUndefined();

    const history = getHistory('G_TYPE_MATCH');
    expect(history.some((h) => h.credential_id === 10)).toBe(true);
  });

  it('skips dispatch when credential type is NOT in filter', async () => {
    setPreferences({
      address: 'G_TYPE_SKIP',
      email: 'skip@test.com',
      channels: ['email'],
      events: ['credential_issued'],
      credential_type_filters: [2], // License only
      enabled: true,
    });

    const historyBefore = getHistory('G_TYPE_SKIP').length;
    await dispatchNotification('G_TYPE_SKIP', 'credential_issued', 20, 1); // type=1 (Degree)
    const historyAfter = getHistory('G_TYPE_SKIP').length;

    expect(historyAfter).toBe(historyBefore); // no new record
  });

  it('dispatches when credential_type_filters is empty (allow all)', async () => {
    setPreferences({
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

// Mock ws broadcastEvent to avoid needing a real WS server
vi.mock('../src/ws/server.js', () => ({
  broadcastEvent: vi.fn(() => 0),
}));

const app = express();
app.use(express.json());
app.use('/api/notifications', notificationsRouter);

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
