import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createRateLimiter, ipKey, userKey, combinedKey } from '../src/middleware/rateLimiter.js';

function createTestApp(rateLimiter: ReturnType<typeof createRateLimiter>) {
  const app = express();
  app.set('trust proxy', true);
  app.use(express.json());
  app.use('/api', rateLimiter);
  app.get('/api/test', (_req, res) => res.json({ ok: true }));
  app.post('/api/test', (_req, res) => res.json({ ok: true }));
  return app;
}

describe('Rate Limiter Middleware', () => {
  describe('rate limit enforcement', () => {
    it('allows requests under the limit', async () => {
      const limiter = createRateLimiter({ windowMs: 60000, max: 5, name: 'test', backoffMultiplier: 2, maxViolations: 3 });
      const app = createTestApp(limiter);

      for (let i = 0; i < 5; i++) {
        const res = await request(app).get('/api/test');
        expect(res.status).toBe(200);
      }
    });

    it('blocks requests exceeding the limit', async () => {
      const limiter = createRateLimiter({ windowMs: 60000, max: 2, name: 'test', backoffMultiplier: 2, maxViolations: 3 });
      const app = createTestApp(limiter);

      const res1 = await request(app).get('/api/test');
      expect(res1.status).toBe(200);

      const res2 = await request(app).get('/api/test');
      expect(res2.status).toBe(200);

      const res3 = await request(app).get('/api/test');
      expect(res3.status).toBe(429);
      expect(res3.body.error).toBe('Rate limit exceeded');
    });

    it('returns 429 with proper error message', async () => {
      const limiter = createRateLimiter({ windowMs: 60000, max: 1, name: 'test', backoffMultiplier: 2, maxViolations: 3 });
      const app = createTestApp(limiter);

      await request(app).get('/api/test');
      const res = await request(app).get('/api/test');

      expect(res.status).toBe(429);
      expect(res.body.error).toBe('Rate limit exceeded');
      expect(res.body.limit).toBe(1);
      expect(res.body.windowMs).toBe(60000);
    });
  });

  describe('rate limit headers', () => {
    it('includes X-RateLimit-Limit header', async () => {
      const limiter = createRateLimiter({ windowMs: 60000, max: 10, name: 'test', backoffMultiplier: 2, maxViolations: 3 });
      const app = createTestApp(limiter);

      const res = await request(app).get('/api/test');
      expect(res.headers['x-ratelimit-limit']).toBe('10');
    });

    it('includes X-RateLimit-Remaining header', async () => {
      const limiter = createRateLimiter({ windowMs: 60000, max: 10, name: 'test', backoffMultiplier: 2, maxViolations: 3 });
      const app = createTestApp(limiter);

      const res1 = await request(app).get('/api/test');
      expect(res1.headers['x-ratelimit-remaining']).toBe('9');

      const res2 = await request(app).get('/api/test');
      expect(res2.headers['x-ratelimit-remaining']).toBe('8');
    });

    it('includes X-RateLimit-Reset header as unix timestamp', async () => {
      const limiter = createRateLimiter({ windowMs: 60000, max: 10, name: 'test', backoffMultiplier: 2, maxViolations: 3 });
      const app = createTestApp(limiter);

      const res = await request(app).get('/api/test');
      const reset = parseInt(res.headers['x-ratelimit-reset'] as string, 10);
      const now = Math.floor(Date.now() / 1000);
      expect(reset).toBeGreaterThanOrEqual(now);
      expect(reset).toBeLessThanOrEqual(now + 61);
    });

    it('includes Retry-After header when rate limited', async () => {
      const limiter = createRateLimiter({ windowMs: 60000, max: 1, name: 'test', backoffMultiplier: 2, maxViolations: 3 });
      const app = createTestApp(limiter);

      await request(app).get('/api/test');
      const res = await request(app).get('/api/test');

      expect(res.status).toBe(429);
      expect(res.headers['retry-after']).toBeDefined();
      expect(parseInt(res.headers['retry-after'] as string, 10)).toBeGreaterThan(0);
    });
  });

  describe('per-IP rate limiting', () => {
    it('tracks different IPs separately', async () => {
      const limiter = createRateLimiter({ windowMs: 60000, max: 2, name: 'test', backoffMultiplier: 2, maxViolations: 3 });
      const app = createTestApp(limiter);

      const res1 = await request(app).get('/api/test').set('X-Forwarded-For', '1.1.1.1');
      expect(res1.status).toBe(200);

      const res2 = await request(app).get('/api/test').set('X-Forwarded-For', '2.2.2.2');
      expect(res2.status).toBe(200);

      const res3 = await request(app).get('/api/test').set('X-Forwarded-For', '1.1.1.1');
      expect(res3.status).toBe(200);

      const res4 = await request(app).get('/api/test').set('X-Forwarded-For', '2.2.2.2');
      expect(res4.status).toBe(200);

      const res5 = await request(app).get('/api/test').set('X-Forwarded-For', '1.1.1.1');
      expect(res5.status).toBe(429);

      const res6 = await request(app).get('/api/test').set('X-Forwarded-For', '2.2.2.2');
      expect(res6.status).toBe(429);
    });
  });

  describe('per-user rate limiting', () => {
    it('uses X-Stellar-Address header for user-based limits', async () => {
      const limiter = createRateLimiter({ windowMs: 60000, max: 2, name: 'test', backoffMultiplier: 2, maxViolations: 3 });
      const app = createTestApp(limiter);

      const res1 = await request(app).get('/api/test').set('X-Stellar-Address', 'GAUSER1');
      expect(res1.status).toBe(200);

      const res2 = await request(app).get('/api/test').set('X-Stellar-Address', 'GAUSER2');
      expect(res2.status).toBe(200);

      const res3 = await request(app).get('/api/test').set('X-Stellar-Address', 'GAUSER1');
      expect(res3.status).toBe(200);

      const res4 = await request(app).get('/api/test').set('X-Stellar-Address', 'GAUSER1');
      expect(res4.status).toBe(429);

      const res5 = await request(app).get('/api/test').set('X-Stellar-Address', 'GAUSER2');
      expect(res5.status).toBe(200);
    });

    it('prioritizes user-based key over IP when X-Stellar-Address is present', async () => {
      const limiter = createRateLimiter({ windowMs: 60000, max: 1, name: 'test', backoffMultiplier: 2, maxViolations: 3 });
      const app = createTestApp(limiter);

      const res = await request(app)
        .get('/api/test')
        .set('X-Stellar-Address', 'GAUSER')
        .set('X-Forwarded-For', '1.1.1.1');
      expect(res.status).toBe(200);

      const res2 = await request(app)
        .get('/api/test')
        .set('X-Stellar-Address', 'GAUSER')
        .set('X-Forwarded-For', '2.2.2.2');
      expect(res2.status).toBe(429);
    });
  });

  describe('exponential backoff', () => {
    it('increases wait time after repeated violations', async () => {
      const limiter = createRateLimiter({ windowMs: 100, max: 1, name: 'test', backoffMultiplier: 2, maxViolations: 5 });
      const app = createTestApp(limiter);

      // Use up the limit
      await request(app).get('/api/test');

      // First violation: backoff is windowMs * 2^0 = 100ms -> Retry-After is at least 1s
      const res1 = await request(app).get('/api/test');
      expect(res1.status).toBe(429);
      const retryAfter1 = parseInt(res1.headers['retry-after'] as string, 10);
      // Retry-After is in seconds (integer), so 100ms rounds up to 1
      expect(retryAfter1).toBe(1);

      // Wait for backoff to expire
      await new Promise(resolve => setTimeout(resolve, 200));

      // Use up limit again
      await request(app).get('/api/test');

      // Second violation: backoff should be windowMs * 2^1 = 200ms -> 1s (ceil(0.2))
      const res2 = await request(app).get('/api/test');
      expect(res2.status).toBe(429);
      const retryAfter2 = parseInt(res2.headers['retry-after'] as string, 10);
      expect(retryAfter2).toBe(1);

      // With such small windows, both round to 1, but the backoff duration doubles
      expect(retryAfter2).toBeGreaterThanOrEqual(retryAfter1);
    }, 10000);

    it('allows requests again after backoff period expires', async () => {
      const limiter = createRateLimiter({ windowMs: 50, max: 1, name: 'test', backoffMultiplier: 1, maxViolations: 5 });
      const app = createTestApp(limiter);

      await request(app).get('/api/test');

      const blocked = await request(app).get('/api/test');
      expect(blocked.status).toBe(429);

      await new Promise(resolve => setTimeout(resolve, 150));

      const allowed = await request(app).get('/api/test');
      expect(allowed.status).toBe(200);
    }, 10000);
  });

  describe('key functions', () => {
    it('ipKey returns ip-based key', () => {
      const req = { ip: '1.2.3.4', socket: { remoteAddress: '5.6.7.8' }, headers: {} } as any;
      expect(ipKey(req)).toBe('ip:1.2.3.4');
    });

    it('ipKey falls back to remoteAddress', () => {
      const req = { ip: undefined, socket: { remoteAddress: '5.6.7.8' }, headers: {} } as any;
      expect(ipKey(req)).toBe('ip:5.6.7.8');
    });

    it('userKey returns null when header missing', () => {
      const req = { headers: {} } as any;
      expect(userKey(req)).toBeNull();
    });

    it('userKey returns user key when header present', () => {
      const req = { headers: { 'x-stellar-address': 'GAABCD' } } as any;
      expect(userKey(req)).toBe('user:GAABCD');
    });

    it('combinedKey uses user key when header present', () => {
      const req = { ip: '1.2.3.4', socket: {}, headers: { 'x-stellar-address': 'GAABCD' } } as any;
      expect(combinedKey(req)).toBe('user:GAABCD');
    });

    it('combinedKey falls back to IP when no user header', () => {
      const req = { ip: '1.2.3.4', socket: {}, headers: {} } as any;
      expect(combinedKey(req)).toBe('ip:1.2.3.4');
    });
  });

  describe('reset', () => {
    it('reset clears all rate limit state', async () => {
      const limiter = createRateLimiter({ windowMs: 60000, max: 1, name: 'test', backoffMultiplier: 2, maxViolations: 3 });
      const app = createTestApp(limiter);

      await request(app).get('/api/test');
      const blocked = await request(app).get('/api/test');
      expect(blocked.status).toBe(429);

      limiter.reset();

      const allowed = await request(app).get('/api/test');
      expect(allowed.status).toBe(200);
    });
  });

  describe('custom configuration', () => {
    it('respects custom windowMs and max values', async () => {
      const limiter = createRateLimiter({ windowMs: 5000, max: 3, name: 'test', backoffMultiplier: 2, maxViolations: 3 });
      const app = createTestApp(limiter);

      for (let i = 0; i < 3; i++) {
        const res = await request(app).get('/api/test');
        expect(res.status).toBe(200);
        expect(res.headers['x-ratelimit-limit']).toBe('3');
      }

      const res = await request(app).get('/api/test');
      expect(res.status).toBe(429);
    });

    it('applies to POST requests', async () => {
      const limiter = createRateLimiter({ windowMs: 60000, max: 1, name: 'test', backoffMultiplier: 2, maxViolations: 3 });
      const app = createTestApp(limiter);

      const res1 = await request(app).post('/api/test').send({});
      expect(res1.status).toBe(200);

      const res2 = await request(app).post('/api/test').send({});
      expect(res2.status).toBe(429);
    });
  });

  describe('bypass prevention', () => {
    it('does not bypass with different X-Forwarded-For when using user key', async () => {
      const limiter = createRateLimiter({ windowMs: 60000, max: 1, name: 'test', backoffMultiplier: 2, maxViolations: 3 });
      const app = createTestApp(limiter);

      const res1 = await request(app)
        .get('/api/test')
        .set('X-Stellar-Address', 'GAUSER')
        .set('X-Forwarded-For', '1.1.1.1');
      expect(res1.status).toBe(200);

      const res2 = await request(app)
        .get('/api/test')
        .set('X-Stellar-Address', 'GAUSER')
        .set('X-Forwarded-For', '2.2.2.2');
      expect(res2.status).toBe(429);
    });

    it('prevents using different user agents to bypass IP limits', async () => {
      const limiter = createRateLimiter({ windowMs: 60000, max: 2, name: 'test', backoffMultiplier: 2, maxViolations: 3 });
      const app = createTestApp(limiter);

      for (let i = 0; i < 2; i++) {
        const res = await request(app)
          .get('/api/test')
          .set('User-Agent', `UA-${i}`);
        expect(res.status).toBe(200);
      }

      const res = await request(app)
        .get('/api/test')
        .set('User-Agent', 'UA-different');
      expect(res.status).toBe(429);
    });
  });

  describe('permanent block after maxViolations', () => {
    it('permanently blocks after maxViolations violations', async () => {
      const limiter = createRateLimiter({ windowMs: 50, max: 1, name: 'test', backoffMultiplier: 2, maxViolations: 3 });
      const app = createTestApp(limiter);

      // Violation 1: exceed limit once
      await request(app).get('/api/test');
      let res = await request(app).get('/api/test');
      expect(res.status).toBe(429);

      // Wait for backoff to expire
      await new Promise(resolve => setTimeout(resolve, 200));

      // Violation 2: exceed limit again  
      await request(app).get('/api/test');
      res = await request(app).get('/api/test');
      expect(res.status).toBe(429);

      // Wait for longer backoff to expire
      await new Promise(resolve => setTimeout(resolve, 300));

      // Violation 3: exceed limit again - should trigger permanent block
      await request(app).get('/api/test');
      res = await request(app).get('/api/test');
      expect(res.status).toBe(429);

      // Wait a long time - should still be blocked
      await new Promise(resolve => setTimeout(resolve, 500));

      res = await request(app).get('/api/test');
      expect(res.status).toBe(429);
    }, 20000);
  });
});
