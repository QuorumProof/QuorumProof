import { describe, it, expect } from 'vitest';
import express from 'express';
import request from 'supertest';
import { cacheControl } from '../src/middleware/cacheControl.js';

function createTestApp() {
  const app = express();
  app.use(cacheControl);
  app.get('/api/test', (_req, res) => res.json({ ok: true }));
  app.post('/api/test', (_req, res) => res.json({ ok: true }));
  app.get('/api/custom', (_req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.json({ ok: true });
  });
  return app;
}

describe('Cache Control Middleware', () => {
  it('sets Cache-Control on GET responses', async () => {
    const res = await request(createTestApp()).get('/api/test');

    expect(res.headers['cache-control']).toBe('private, max-age=30, must-revalidate');
  });

  it('sets an ETag header on GET responses', async () => {
    const res = await request(createTestApp()).get('/api/test');

    expect(res.headers['etag']).toBeDefined();
  });

  it('does not override a Cache-Control header set by a route', async () => {
    const res = await request(createTestApp()).get('/api/custom');

    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('does not set Cache-Control on non-GET requests', async () => {
    const res = await request(createTestApp()).post('/api/test');

    expect(res.headers['cache-control']).toBeUndefined();
  });
});
