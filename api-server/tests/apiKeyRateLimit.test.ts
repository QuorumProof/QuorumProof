/**
 * Tests for per-API-key rate limiting (Issue #1436)
 *
 * Covers:
 *   - Per-key quota enforcement: requests with a valid key are rate-limited by key, not IP
 *   - Quota reset/window rollover: after the window expires, the count resets
 *   - No API key header → middleware passes through (calls next()) without rate limiting
 *   - Invalid/expired API key → 401 { error: 'Invalid or expired API key' }
 *   - Key revocation: revoked key returns 401
 *   - 429 body/headers on limit exceeded: error: 'Rate limit exceeded',
 *     headers X-RateLimit-Limit, X-RateLimit-Remaining, X-RateLimit-Reset, Retry-After
 *   - Two different keys have independent rate limit buckets
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, it, expect, beforeEach } from 'vitest';
import express, { type Request, type Response } from 'express';
import request from 'supertest';
import { createApiKeyRateLimiter } from '../src/middleware/apiKeyRateLimit.js';
import { ApiKeyManager, _setDefaultApiKeyManagerForTest } from '../src/services/apiKeyManager.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Creates a fresh ApiKeyManager backed by a temp dir and installs it as the default. */
function freshManager(): { manager: ApiKeyManager; dataDir: string } {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'apikey-ratelimit-test-'));
  const manager = new ApiKeyManager({ dataDir });
  _setDefaultApiKeyManagerForTest(manager);
  return { manager, dataDir };
}

/**
 * Builds a minimal express app with the given limiter middleware and a simple
 * echo handler at GET /api/test that returns 200 { ok: true }.
 */
function buildApp(limiterMiddleware: ReturnType<typeof createApiKeyRateLimiter>) {
  const app = express();
  app.use(express.json());
  app.use(limiterMiddleware);
  app.get('/api/test', (_req: Request, res: Response) => {
    res.json({ ok: true });
  });
  return app;
}

// ─── Setup ────────────────────────────────────────────────────────────────────

let manager: ApiKeyManager;

beforeEach(() => {
  ({ manager } = freshManager());
});

// ─── No API key header → pass through ─────────────────────────────────────────

describe('no x-api-key header', () => {
  it('passes through to next() without rate limiting when no key header is present', async () => {
    const limiter = createApiKeyRateLimiter(
      { windowMs: 60_000, max: 2, name: 'test', backoffMultiplier: 2, maxViolations: 5 },
      manager,
    );
    const app = buildApp(limiter);

    // Should succeed with no key header
    const res = await request(app).get('/api/test');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it('multiple requests without a key header all pass through', async () => {
    const limiter = createApiKeyRateLimiter(
      { windowMs: 60_000, max: 2, name: 'test', backoffMultiplier: 2, maxViolations: 5 },
      manager,
    );
    const app = buildApp(limiter);

    for (let i = 0; i < 5; i++) {
      const res = await request(app).get('/api/test');
      expect(res.status).toBe(200);
    }
  });
});

// ─── Invalid / expired API key → 401 ─────────────────────────────────────────

describe('invalid or expired API key', () => {
  it('returns 401 with error message for a completely unknown key', async () => {
    const limiter = createApiKeyRateLimiter(
      { windowMs: 60_000, max: 10, name: 'test', backoffMultiplier: 2, maxViolations: 5 },
      manager,
    );
    const app = buildApp(limiter);

    const res = await request(app)
      .get('/api/test')
      .set('x-api-key', 'qp_notarealkey0000000000000000000000000000000000000000000000000000');

    expect(res.status).toBe(401);
    expect(res.body.error).toBe('Invalid or expired API key');
  });

  it('returns 401 for a random junk key value', async () => {
    const limiter = createApiKeyRateLimiter(
      { windowMs: 60_000, max: 10, name: 'test', backoffMultiplier: 2, maxViolations: 5 },
      manager,
    );
    const app = buildApp(limiter);

    const res = await request(app)
      .get('/api/test')
      .set('x-api-key', 'invalid-key-value');

    expect(res.status).toBe(401);
    expect(res.body.error).toBe('Invalid or expired API key');
  });
});

// ─── Key revocation → 401 ─────────────────────────────────────────────────────

describe('revoked key', () => {
  it('returns 401 after key has been revoked', async () => {
    const limiter = createApiKeyRateLimiter(
      { windowMs: 60_000, max: 10, name: 'test', backoffMultiplier: 2, maxViolations: 5 },
      manager,
    );
    const app = buildApp(limiter);

    // Generate a key, use it successfully, then revoke it
    const { key, id } = manager.generateKey('issuer-1', 'Test Key');

    const resBefore = await request(app)
      .get('/api/test')
      .set('x-api-key', key);
    expect(resBefore.status).toBe(200);

    manager.revokeKey(id);

    const resAfter = await request(app)
      .get('/api/test')
      .set('x-api-key', key);
    expect(resAfter.status).toBe(401);
    expect(resAfter.body.error).toBe('Invalid or expired API key');
  });
});

// ─── Per-key quota enforcement ────────────────────────────────────────────────

describe('per-key quota enforcement', () => {
  it('allows requests up to the limit then returns 429 with correct body and headers', async () => {
    const max = 3;
    const limiter = createApiKeyRateLimiter(
      { windowMs: 60_000, max, name: 'test', backoffMultiplier: 2, maxViolations: 5 },
      manager,
    );
    const app = buildApp(limiter);

    const { key } = manager.generateKey('issuer-1', 'Test Key');

    // First `max` requests should succeed
    for (let i = 0; i < max; i++) {
      const res = await request(app)
        .get('/api/test')
        .set('x-api-key', key);
      expect(res.status).toBe(200);
    }

    // The (max+1)th request should be rate limited
    const limited = await request(app)
      .get('/api/test')
      .set('x-api-key', key);
    expect(limited.status).toBe(429);
    expect(limited.body.error).toBe('Rate limit exceeded');
  });

  it('sets X-RateLimit-Limit header on responses', async () => {
    const max = 5;
    const limiter = createApiKeyRateLimiter(
      { windowMs: 60_000, max, name: 'test', backoffMultiplier: 2, maxViolations: 5 },
      manager,
    );
    const app = buildApp(limiter);

    const { key } = manager.generateKey('issuer-1', 'Test Key');

    const res = await request(app)
      .get('/api/test')
      .set('x-api-key', key);
    expect(res.status).toBe(200);
    expect(res.headers['x-ratelimit-limit']).toBe(String(max));
  });

  it('sets X-RateLimit-Remaining header that decrements with each request', async () => {
    const max = 5;
    const limiter = createApiKeyRateLimiter(
      { windowMs: 60_000, max, name: 'test', backoffMultiplier: 2, maxViolations: 5 },
      manager,
    );
    const app = buildApp(limiter);

    const { key } = manager.generateKey('issuer-1', 'Test Key');

    const res1 = await request(app)
      .get('/api/test')
      .set('x-api-key', key);
    const remaining1 = parseInt(res1.headers['x-ratelimit-remaining'], 10);

    const res2 = await request(app)
      .get('/api/test')
      .set('x-api-key', key);
    const remaining2 = parseInt(res2.headers['x-ratelimit-remaining'], 10);

    expect(remaining2).toBe(remaining1 - 1);
  });

  it('sets X-RateLimit-Reset header', async () => {
    const limiter = createApiKeyRateLimiter(
      { windowMs: 60_000, max: 10, name: 'test', backoffMultiplier: 2, maxViolations: 5 },
      manager,
    );
    const app = buildApp(limiter);

    const { key } = manager.generateKey('issuer-1', 'Test Key');

    const res = await request(app)
      .get('/api/test')
      .set('x-api-key', key);
    expect(res.headers['x-ratelimit-reset']).toBeDefined();
    expect(parseInt(res.headers['x-ratelimit-reset'], 10)).toBeGreaterThan(0);
  });

  it('sets Retry-After header on 429 responses', async () => {
    const max = 2;
    const limiter = createApiKeyRateLimiter(
      { windowMs: 60_000, max, name: 'test', backoffMultiplier: 2, maxViolations: 5 },
      manager,
    );
    const app = buildApp(limiter);

    const { key } = manager.generateKey('issuer-1', 'Test Key');

    // Exhaust quota
    for (let i = 0; i < max; i++) {
      await request(app).get('/api/test').set('x-api-key', key);
    }

    const limited = await request(app)
      .get('/api/test')
      .set('x-api-key', key);
    expect(limited.status).toBe(429);
    expect(limited.headers['retry-after']).toBeDefined();
    expect(parseInt(limited.headers['retry-after'], 10)).toBeGreaterThan(0);
  });
});

// ─── Two keys have independent rate limit buckets ─────────────────────────────

describe('independent rate limit buckets per key', () => {
  it('exhausting key A does not affect key B', async () => {
    const max = 2;
    const limiter = createApiKeyRateLimiter(
      { windowMs: 60_000, max, name: 'test', backoffMultiplier: 2, maxViolations: 5 },
      manager,
    );
    const app = buildApp(limiter);

    const { key: keyA } = manager.generateKey('issuer-1', 'Key A');
    const { key: keyB } = manager.generateKey('issuer-2', 'Key B');

    // Exhaust key A's quota
    for (let i = 0; i < max; i++) {
      await request(app).get('/api/test').set('x-api-key', keyA);
    }
    const limitedA = await request(app)
      .get('/api/test')
      .set('x-api-key', keyA);
    expect(limitedA.status).toBe(429);

    // Key B should still be able to make requests
    const resB = await request(app)
      .get('/api/test')
      .set('x-api-key', keyB);
    expect(resB.status).toBe(200);
  });

  it('each key starts with its own fresh counter', async () => {
    const max = 3;
    const limiter = createApiKeyRateLimiter(
      { windowMs: 60_000, max, name: 'test', backoffMultiplier: 2, maxViolations: 5 },
      manager,
    );
    const app = buildApp(limiter);

    const { key: key1 } = manager.generateKey('issuer-A', 'Key 1');
    const { key: key2 } = manager.generateKey('issuer-B', 'Key 2');

    // Use key1 twice
    await request(app).get('/api/test').set('x-api-key', key1);
    const res1 = await request(app).get('/api/test').set('x-api-key', key1);
    const remaining1 = parseInt(res1.headers['x-ratelimit-remaining'], 10);

    // Key2 should still have full remaining
    const res2 = await request(app).get('/api/test').set('x-api-key', key2);
    const remaining2 = parseInt(res2.headers['x-ratelimit-remaining'], 10);

    // Key2 remaining should be higher than key1's (key1 has been used more)
    expect(remaining2).toBeGreaterThan(remaining1);
  });
});

// ─── Quota reset / window rollover ────────────────────────────────────────────

describe('quota reset after window rollover', () => {
  it('resets the count after the window expires', async () => {
    const windowMs = 50; // very short window for testing
    const max = 2;
    const limiter = createApiKeyRateLimiter(
      { windowMs, max, name: 'test', backoffMultiplier: 2, maxViolations: 5 },
      manager,
    );
    const app = buildApp(limiter);

    const { key } = manager.generateKey('issuer-1', 'Test Key');

    // Exhaust the quota
    for (let i = 0; i < max; i++) {
      await request(app).get('/api/test').set('x-api-key', key);
    }
    const limited = await request(app)
      .get('/api/test')
      .set('x-api-key', key);
    expect(limited.status).toBe(429);

    // Wait for the window to expire
    await new Promise((resolve) => setTimeout(resolve, windowMs + 20));

    // Should now be allowed again
    const resAfterReset = await request(app)
      .get('/api/test')
      .set('x-api-key', key);
    expect(resAfterReset.status).toBe(200);
  });
});
