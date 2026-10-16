// Example plugin tests — issue #1647. Shows the three layers described in
// docs/plugin-development-guide.md#testing-plugins: contract, unit (fake
// context), and HTTP (real express Router via supertest).
import { describe, it, expect, vi } from 'vitest';
import express, { Router } from 'express';
import request from 'supertest';
import { createEventStatsPlugin } from '../index.js';

function fakeContext(config = {}) {
  const healthChecks = new Map();
  const router = Router();
  return {
    ctx: {
      router,
      config,
      apiVersion: 1,
      logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      registerHealthCheck: (name, fn) => healthChecks.set(name, fn),
    },
    router,
    healthChecks,
  };
}

const event = (type) => ({ type, credential_id: 1, timestamp: new Date().toISOString() });

describe('event-stats plugin contract', () => {
  it('declares a valid name, version and apiVersion', () => {
    const p = createEventStatsPlugin();
    expect(p.name).toMatch(/^[a-z0-9][a-z0-9-]{0,62}$/);
    expect(p.version).toBeTruthy();
    expect(p.apiVersion).toBe(1);
    expect(typeof p.setup).toBe('function');
  });
});

describe('event-stats behaviour', () => {
  it('counts events by type and serves them over HTTP', async () => {
    const p = createEventStatsPlugin();
    const { ctx, router } = fakeContext();
    await p.setup(ctx);

    await p.onEvent(event('credential_issued'));
    await p.onEvent(event('credential_issued'));
    await p.onEvent(event('credential_revoked'));

    const app = express().use('/api/plugins/event-stats', router);
    const res = await request(app).get('/api/plugins/event-stats/stats');

    expect(res.status).toBe(200);
    expect(res.body.total).toBe(3);
    expect(res.body.byType).toEqual({ credential_issued: 2, credential_revoked: 1 });
  });

  it('degrades health after repeated forward failures', async () => {
    const fetch = vi.fn().mockResolvedValue({ ok: false, status: 502 });
    const p = createEventStatsPlugin({ forwardUrl: 'https://example.test', failureThreshold: 2 }, { fetch });
    const { ctx, healthChecks } = fakeContext();
    await p.setup(ctx);

    await expect(p.onEvent(event('credential_issued'))).rejects.toThrow('HTTP 502');
    await expect(p.onEvent(event('credential_issued'))).rejects.toThrow('HTTP 502');

    const health = await healthChecks.get('forwarder')();
    expect(health.status).toBe('degraded');
  });
});
