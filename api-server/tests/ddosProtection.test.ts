import { describe, it, expect, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createDDoSProtection } from '../src/middleware/ddosProtection.js';

function createTestApp(ddos: ReturnType<typeof createDDoSProtection>) {
  const app = express();
  app.set('trust proxy', true);
  app.use(ddos);
  app.use(express.json({ limit: '1mb' }));
  app.get('/api/test', (_req, res) => res.json({ ok: true }));
  app.post('/api/test', (_req, res) => res.json({ ok: true }));
  return app;
}

describe('DDoS Protection Middleware', () => {
  describe('body size limit', () => {
    it('blocks requests with body exceeding maxBodySize', async () => {
      const ddos = createDDoSProtection({ maxBodySize: 100, maxConcurrentPerIp: 100, burstWindowMs: 60000, burstMaxRequests: 1000 });
      const app = createTestApp(ddos);

      const res = await request(app)
        .post('/api/test')
        .send({ data: 'x'.repeat(200) });

      expect(res.status).toBe(413);
      expect(res.body.error).toBe('Request entity too large');
    });

    it('allows requests within body size limit', async () => {
      const ddos = createDDoSProtection({ maxBodySize: 1000, maxConcurrentPerIp: 100, burstWindowMs: 60000, burstMaxRequests: 1000 });
      const app = createTestApp(ddos);

      const res = await request(app)
        .post('/api/test')
        .send({ data: 'small' });

      expect(res.status).toBe(200);
    });

    it('allows GET requests regardless of body', async () => {
      const ddos = createDDoSProtection({ maxBodySize: 10, maxConcurrentPerIp: 100, burstWindowMs: 60000, burstMaxRequests: 1000 });
      const app = createTestApp(ddos);

      const res = await request(app).get('/api/test');
      expect(res.status).toBe(200);
    });
  });

  describe('concurrent request limit', () => {
    it('tracks connections via store', async () => {
      const ddos = createDDoSProtection({ maxBodySize: 100000, maxConcurrentPerIp: 5, burstWindowMs: 60000, burstMaxRequests: 1000 });
      const app = createTestApp(ddos);

      const res = await request(app).get('/api/test').set('X-Forwarded-For', '1.1.1.1');
      expect(res.status).toBe(200);

      const conns = ddos.connections.get('1.1.1.1');
      expect(conns).toBeDefined();
    });

    it('blocks when maxConcurrentPerIp is exceeded using slow handler', async () => {
      const ddos = createDDoSProtection({ maxBodySize: 100000, maxConcurrentPerIp: 2, burstWindowMs: 60000, burstMaxRequests: 1000 });
      const slowApp = express();
      slowApp.set('trust proxy', true);
      slowApp.use(ddos);
      slowApp.get('/api/slow', (_req, res) => {
        setTimeout(() => res.json({ ok: true }), 200);
      });

      const promises = [];
      for (let i = 0; i < 5; i++) {
        promises.push(request(slowApp).get('/api/slow').set('X-Forwarded-For', '1.1.1.1'));
      }

      const results = await Promise.all(promises);
      const blocked = results.filter(r => r.status === 429);
      expect(blocked.length).toBeGreaterThan(0);
      expect(blocked[0].body.error).toBe('Too many concurrent requests');
    }, 10000);
  });

  describe('burst detection', () => {
    it('blocks rapid requests from the same IP', async () => {
      const ddos = createDDoSProtection({ maxBodySize: 100000, maxConcurrentPerIp: 100, burstWindowMs: 2000, burstMaxRequests: 3 });
      const app = createTestApp(ddos);

      for (let i = 0; i < 3; i++) {
        const res = await request(app).get('/api/test').set('X-Forwarded-For', '1.1.1.1');
        expect(res.status).toBe(200);
      }

      const res = await request(app).get('/api/test').set('X-Forwarded-For', '1.1.1.1');
      expect(res.status).toBe(429);
      expect(res.body.error).toBe('Request burst detected');
    });

    it('allows burst from different IPs', async () => {
      const ddos = createDDoSProtection({ maxBodySize: 100000, maxConcurrentPerIp: 100, burstWindowMs: 2000, burstMaxRequests: 3 });
      const app = createTestApp(ddos);

      for (let i = 0; i < 3; i++) {
        const res = await request(app).get('/api/test').set('X-Forwarded-For', `${i}.${i}.${i}.${i}`);
        expect(res.status).toBe(200);
      }

      for (let i = 0; i < 3; i++) {
        const res = await request(app).get('/api/test').set('X-Forwarded-For', `${i}.${i}.${i}.${i}`);
        expect(res.status).toBe(200);
      }
    });

    it('resets burst window after time passes', async () => {
      const ddos = createDDoSProtection({ maxBodySize: 100000, maxConcurrentPerIp: 100, burstWindowMs: 200, burstMaxRequests: 3 });
      const app = createTestApp(ddos);

      for (let i = 0; i < 3; i++) {
        const res = await request(app).get('/api/test').set('X-Forwarded-For', '1.1.1.1');
        expect(res.status).toBe(200);
      }

      let res = await request(app).get('/api/test').set('X-Forwarded-For', '1.1.1.1');
      expect(res.status).toBe(429);

      await new Promise(resolve => setTimeout(resolve, 300));

      res = await request(app).get('/api/test').set('X-Forwarded-For', '1.1.1.1');
      expect(res.status).toBe(200);
    }, 10000);
  });

  describe('reset', () => {
    it('reset clears all connection state', async () => {
      const ddos = createDDoSProtection({ maxBodySize: 100000, maxConcurrentPerIp: 100, burstWindowMs: 2000, burstMaxRequests: 3 });
      const app = createTestApp(ddos);

      for (let i = 0; i < 3; i++) {
        await request(app).get('/api/test').set('X-Forwarded-For', '1.1.1.1');
      }

      let res = await request(app).get('/api/test').set('X-Forwarded-For', '1.1.1.1');
      expect(res.status).toBe(429);

      ddos.reset();

      res = await request(app).get('/api/test').set('X-Forwarded-For', '1.1.1.1');
      expect(res.status).toBe(200);
    });
  });
});
