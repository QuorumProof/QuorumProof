import express from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createConcurrentRequestLimiter } from '../src/middleware/concurrentRequestLimiter.js';

async function waitForQueuedRequest(limiter: ReturnType<typeof createConcurrentRequestLimiter>): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt++) {
    if (limiter.getMetrics().groups.some((group) => group.currentQueueDepth === 1)) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 2));
  }
  throw new Error('request was not queued');
}

describe('concurrent request limiter', () => {
  it('limits active requests, queues within capacity, and rejects when the queue is full', async () => {
    const limiter = createConcurrentRequestLimiter({
      defaultMaxConcurrent: 1,
      defaultQueueMax: 1,
      defaultQueueTimeoutMs: 5_000,
    });
    const app = express();
    let calls = 0;
    let finishFirst!: () => void;
    let signalFirstStarted!: () => void;
    const firstStarted = new Promise<void>((resolve) => { signalFirstStarted = resolve; });

    app.use(limiter.middleware);
    app.get('/work', (_req, res) => {
      calls++;
      if (calls === 1) {
        signalFirstStarted();
        void new Promise<void>((resolve) => { finishFirst = resolve; })
          .then(() => res.json({ call: calls }));
        return;
      }
      res.json({ call: calls });
    });

    const firstResponse = request(app).get('/work');
    const firstResult = firstResponse.then((response) => response);
    await firstStarted;

    const secondResult = request(app).get('/work').then((response) => response);
    await waitForQueuedRequest(limiter);
    expect(limiter.getMetrics().groups[0]).toMatchObject({
      currentConcurrent: 1,
      currentQueueDepth: 1,
      totalQueued: 1,
    });

    const rejected = await request(app).get('/work');
    expect(rejected.status).toBe(503);
    expect(rejected.headers['retry-after']).toBe('5');

    finishFirst();
    expect((await firstResult).status).toBe(200);
    expect((await secondResult).status).toBe(200);
    expect(limiter.getMetrics().groups[0]).toMatchObject({
      currentConcurrent: 0,
      currentQueueDepth: 0,
      totalAcquired: 2,
      totalReleased: 2,
      totalRejected: 1,
    });
  });

  it('times out queued requests and releases timed-out queue capacity', async () => {
    const limiter = createConcurrentRequestLimiter({
      defaultMaxConcurrent: 1,
      defaultQueueMax: 1,
      defaultQueueTimeoutMs: 10,
    });
    const app = express();
    let finishFirst!: () => void;
    let calls = 0;

    app.use(limiter.middleware);
    app.get('/timeout', (_req, res) => {
      calls++;
      if (calls === 1) {
        void new Promise<void>((resolve) => { finishFirst = resolve; })
          .then(() => res.json({ ok: true }));
        return;
      }
      res.json({ ok: true });
    });

    const firstResult = request(app).get('/timeout').then((response) => response);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    const timedOut = await request(app).get('/timeout');

    expect(timedOut.status).toBe(503);
    expect(timedOut.body.error).toContain('timed out in queue');
    expect(limiter.getMetrics().groups[0]).toMatchObject({
      currentConcurrent: 1,
      currentQueueDepth: 0,
      totalTimedOut: 1,
    });

    finishFirst();
    expect((await firstResult).status).toBe(200);
  });

  it('applies the most-specific matching endpoint prefix', async () => {
    const limiter = createConcurrentRequestLimiter({
      defaultMaxConcurrent: 4,
      endpoints: {
        '/api': { maxConcurrent: 3 },
        '/api/verify': { maxConcurrent: 1 },
      },
    });
    const app = express();
    app.use(limiter.middleware);
    app.get('/api/verify/:id', (_req, res) => res.json({ ok: true }));
    app.get('/other', (_req, res) => res.json({ ok: true }));

    expect((await request(app).get('/api/verify/1')).status).toBe(200);
    expect((await request(app).get('/other')).status).toBe(200);

    expect(limiter.getMetrics().groups).toEqual(expect.arrayContaining([
      expect.objectContaining({ group: '/api/verify', maxConcurrent: 1, totalAcquired: 1 }),
      expect.objectContaining({ group: '/api', maxConcurrent: 3, totalAcquired: 0 }),
      expect.objectContaining({ group: '__default__', maxConcurrent: 4, totalAcquired: 1 }),
    ]));
  });
});
