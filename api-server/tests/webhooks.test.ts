import { describe, it, expect, beforeEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import webhooksRouter from '../src/routes/webhooks.js';
import {
  _resetForTest,
  dispatchWebhookEvent,
  getDeliveryLog,
  registerWebhook,
} from '../src/services/webhooks.js';

const app = express();
app.use(express.json());
app.use('/api/webhooks', webhooksRouter);

beforeEach(() => {
  _resetForTest();
  vi.restoreAllMocks();
});

// ── Registration ─────────────────────────────────────────────────────────────

describe('POST /api/webhooks', () => {
  it('registers a webhook and returns 201', async () => {
    const res = await request(app)
      .post('/api/webhooks')
      .send({ url: 'https://example.com/hook', events: ['credential_issued'] });

    expect(res.status).toBe(201);
    expect(res.body.id).toBeDefined();
    expect(res.body.url).toBe('https://example.com/hook');
    expect(res.body.events).toEqual(['credential_issued']);
  });

  it('returns 400 when url is missing', async () => {
    const res = await request(app)
      .post('/api/webhooks')
      .send({ events: ['credential_issued'] });
    expect(res.status).toBe(400);
  });

  it('returns 400 when events array is empty', async () => {
    const res = await request(app)
      .post('/api/webhooks')
      .send({ url: 'https://example.com/hook', events: [] });
    expect(res.status).toBe(400);
  });

  it('returns 400 for invalid event name', async () => {
    const res = await request(app)
      .post('/api/webhooks')
      .send({ url: 'https://example.com/hook', events: ['credential_teleported'] });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/invalid events/);
  });
});

// ── Listing ───────────────────────────────────────────────────────────────────

describe('GET /api/webhooks', () => {
  it('returns empty list initially', async () => {
    const res = await request(app).get('/api/webhooks');
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([]);
  });

  it('returns registered webhooks', async () => {
    await request(app)
      .post('/api/webhooks')
      .send({ url: 'https://a.com', events: ['credential_revoked'] });

    const res = await request(app).get('/api/webhooks');
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].url).toBe('https://a.com');
  });
});

// ── Get by ID ─────────────────────────────────────────────────────────────────

describe('GET /api/webhooks/:id', () => {
  it('returns the webhook by id', async () => {
    const created = await request(app)
      .post('/api/webhooks')
      .send({ url: 'https://b.com', events: ['credential_attested'] });

    const res = await request(app).get(`/api/webhooks/${created.body.id}`);
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(created.body.id);
  });

  it('returns 404 for unknown id', async () => {
    const res = await request(app).get('/api/webhooks/wh_999');
    expect(res.status).toBe(404);
  });
});

// ── Deletion ──────────────────────────────────────────────────────────────────

describe('DELETE /api/webhooks/:id', () => {
  it('deletes a webhook and returns 204', async () => {
    const created = await request(app)
      .post('/api/webhooks')
      .send({ url: 'https://c.com', events: ['credential_issued'] });

    const del = await request(app).delete(`/api/webhooks/${created.body.id}`);
    expect(del.status).toBe(204);

    const get = await request(app).get(`/api/webhooks/${created.body.id}`);
    expect(get.status).toBe(404);
  });

  it('returns 404 when deleting unknown id', async () => {
    const res = await request(app).delete('/api/webhooks/wh_999');
    expect(res.status).toBe(404);
  });
});

// ── Delivery log ──────────────────────────────────────────────────────────────

describe('GET /api/webhooks/deliveries/log', () => {
  it('returns delivery log', async () => {
    const res = await request(app).get('/api/webhooks/deliveries/log');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);
  });
});

// ── Dispatch ──────────────────────────────────────────────────────────────────

describe('dispatchWebhookEvent', () => {
  it('calls fetch for matching webhooks', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', fetchMock);

    registerWebhook('https://hook.test', ['credential_issued']);

    dispatchWebhookEvent({
      event: 'credential_issued',
      credential_id: 42,
      issuer: 'GABC',
      timestamp: '2026-01-01T00:00:00.000Z',
    });

    // allow microtasks to flush
    await new Promise(r => setTimeout(r, 10));

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toBe('https://hook.test');
    expect(opts.method).toBe('POST');
    const body = JSON.parse(opts.body);
    expect(body.event).toBe('credential_issued');
    expect(body.credential_id).toBe(42);
  });

  it('does not call fetch for non-matching events', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', fetchMock);

    registerWebhook('https://hook.test', ['credential_revoked']);

    dispatchWebhookEvent({
      event: 'credential_issued',
      credential_id: 1,
      timestamp: '2026-01-01T00:00:00.000Z',
    });

    await new Promise(r => setTimeout(r, 10));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('records failed delivery in log after retries', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error('connection refused'));
    vi.stubGlobal('fetch', fetchMock);

    // override delays to 0 for test speed
    vi.useFakeTimers();

    registerWebhook('https://bad.host', ['credential_attested']);

    dispatchWebhookEvent({
      event: 'credential_attested',
      credential_id: 7,
      timestamp: '2026-01-01T00:00:00.000Z',
    });

    // advance through all retry delays (1s + 5s + 15s)
    await vi.runAllTimersAsync();
    vi.useRealTimers();

    const log = getDeliveryLog();
    expect(log).toHaveLength(1);
    expect(log[0].status).toBe('failed');
    expect(log[0].attempts).toBe(4); // 1 initial + 3 retries
    expect(log[0].error).toContain('connection refused');
  });

  it('includes HMAC signature header when secret is set', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', fetchMock);

    registerWebhook('https://secure.hook', ['credential_issued'], 'mysecret');

    dispatchWebhookEvent({
      event: 'credential_issued',
      credential_id: 1,
      timestamp: '2026-01-01T00:00:00.000Z',
    });

    await new Promise(r => setTimeout(r, 10));

    const [, opts] = fetchMock.mock.calls[0];
    expect(opts.headers['X-QuorumProof-Signature']).toMatch(/^sha256=[a-f0-9]{64}$/);
  });
});
