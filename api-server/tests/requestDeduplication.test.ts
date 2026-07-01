import { describe, it, expect } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createRequestDeduplication } from '../src/middleware/requestDeduplication.js';

function createTestApp() {
  const app = express();
  app.use(express.json());
  app.use('/api', createRequestDeduplication({ ttlMs: 100 }));

  let calls = 0;
  app.get('/api/test', (_req, res) => {
    calls += 1;
    setTimeout(() => {
      res.json({ ok: true, calls });
    }, 20);
  });

  return { app, getCalls: () => calls };
}

describe('Request Deduplication Middleware', () => {
  it('deduplicates concurrent identical requests', async () => {
    const { app, getCalls } = createTestApp();

    const [first, second] = await Promise.all([
      request(app).get('/api/test'),
      request(app).get('/api/test'),
    ]);

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(first.body).toEqual({ ok: true, calls: 1 });
    expect(second.body).toEqual({ ok: true, calls: 1 });
    expect(getCalls()).toBe(1);
  });

  it('reuses a cached response for repeats within the ttl', async () => {
    const { app, getCalls } = createTestApp();

    const first = await request(app).get('/api/test');
    const second = await request(app).get('/api/test');

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(first.body).toEqual({ ok: true, calls: 1 });
    expect(second.body).toEqual({ ok: true, calls: 1 });
    expect(getCalls()).toBe(1);
  });
});
