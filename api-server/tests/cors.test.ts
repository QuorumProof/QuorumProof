/**
 * Tests for Issue #1303: CORS Configuration Middleware
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createCors, parseOriginsFromEnv, createCorsFromEnv } from '../src/middleware/cors.js';

function makeApp(corsMiddleware: ReturnType<typeof createCors>) {
  const app = express();
  app.use(corsMiddleware);
  app.get('/test', (_req, res) => res.json({ ok: true }));
  app.post('/test', (_req, res) => res.json({ ok: true }));
  return app;
}

describe('CORS Middleware — specific origins', () => {
  const cors = createCors({ origins: ['https://app.quorumproof.io', 'https://staging.quorumproof.io'] });
  const app = makeApp(cors);

  it('sets Access-Control-Allow-Origin for allowed origin', async () => {
    const res = await request(app)
      .get('/test')
      .set('Origin', 'https://app.quorumproof.io');
    expect(res.status).toBe(200);
    expect(res.headers['access-control-allow-origin']).toBe('https://app.quorumproof.io');
  });

  it('sets Vary: Origin when using specific origins', async () => {
    const res = await request(app)
      .get('/test')
      .set('Origin', 'https://app.quorumproof.io');
    expect(res.headers['vary']).toContain('Origin');
  });

  it('sets Access-Control-Allow-Credentials for specific origins', async () => {
    const res = await request(app)
      .get('/test')
      .set('Origin', 'https://app.quorumproof.io');
    expect(res.headers['access-control-allow-credentials']).toBe('true');
  });

  it('does not set CORS headers for disallowed origin', async () => {
    const res = await request(app)
      .get('/test')
      .set('Origin', 'https://evil.com');
    // Request proceeds but without CORS headers — browser blocks it.
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('handles a second allowed origin', async () => {
    const res = await request(app)
      .get('/test')
      .set('Origin', 'https://staging.quorumproof.io');
    expect(res.headers['access-control-allow-origin']).toBe('https://staging.quorumproof.io');
  });
});

describe('CORS Middleware — wildcard origin', () => {
  const cors = createCors({ origins: '*' });
  const app = makeApp(cors);

  it('sets Access-Control-Allow-Origin: * for wildcard config', async () => {
    const res = await request(app)
      .get('/test')
      .set('Origin', 'https://anydomain.com');
    expect(res.headers['access-control-allow-origin']).toBe('https://anydomain.com');
  });

  it('does NOT set credentials header for wildcard config', async () => {
    const res = await request(app)
      .get('/test')
      .set('Origin', 'https://anydomain.com');
    expect(res.headers['access-control-allow-credentials']).toBeUndefined();
  });
});

describe('CORS Middleware — preflight (OPTIONS)', () => {
  const cors = createCors({
    origins: ['https://app.quorumproof.io'],
    methods: ['GET', 'POST', 'DELETE'],
    maxAge: 3600,
  });
  const app = makeApp(cors);

  it('responds to OPTIONS with 204', async () => {
    const res = await request(app)
      .options('/test')
      .set('Origin', 'https://app.quorumproof.io')
      .set('Access-Control-Request-Method', 'POST');
    expect(res.status).toBe(204);
  });

  it('sets Access-Control-Allow-Methods on preflight', async () => {
    const res = await request(app)
      .options('/test')
      .set('Origin', 'https://app.quorumproof.io')
      .set('Access-Control-Request-Method', 'POST');
    expect(res.headers['access-control-allow-methods']).toContain('POST');
  });

  it('sets Access-Control-Allow-Headers on preflight', async () => {
    const res = await request(app)
      .options('/test')
      .set('Origin', 'https://app.quorumproof.io')
      .set('Access-Control-Request-Method', 'GET');
    const allowedHeaders = res.headers['access-control-allow-headers'];
    expect(allowedHeaders).toContain('Content-Type');
    expect(allowedHeaders).toContain('Authorization');
  });

  it('sets Access-Control-Max-Age on preflight', async () => {
    const res = await request(app)
      .options('/test')
      .set('Origin', 'https://app.quorumproof.io')
      .set('Access-Control-Request-Method', 'GET');
    expect(res.headers['access-control-max-age']).toBe('3600');
  });

  it('returns 204 for disallowed origin preflight (no CORS headers)', async () => {
    const res = await request(app)
      .options('/test')
      .set('Origin', 'https://evil.com')
      .set('Access-Control-Request-Method', 'POST');
    expect(res.status).toBe(204);
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });
});

describe('CORS Middleware — wildcard subdomain', () => {
  const cors = createCors({ origins: ['*.quorumproof.io'] });
  const app = makeApp(cors);

  it('allows a subdomain matching wildcard pattern', async () => {
    const res = await request(app)
      .get('/test')
      .set('Origin', 'https://staging.quorumproof.io');
    expect(res.headers['access-control-allow-origin']).toBe('https://staging.quorumproof.io');
  });

  it('does not allow non-matching domain', async () => {
    const res = await request(app)
      .get('/test')
      .set('Origin', 'https://other.com');
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });
});

describe('CORS Middleware — dynamic origin function', () => {
  const cors = createCors({
    origins: (origin) => origin.startsWith('https://'),
  });
  const app = makeApp(cors);

  it('allows origin matching the function', async () => {
    const res = await request(app)
      .get('/test')
      .set('Origin', 'https://anything.com');
    expect(res.headers['access-control-allow-origin']).toBe('https://anything.com');
  });

  it('blocks origin not matching the function', async () => {
    const res = await request(app)
      .get('/test')
      .set('Origin', 'http://insecure.com');
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });
});

describe('CORS Middleware — exposed headers', () => {
  const cors = createCors({ origins: '*' });
  const app = makeApp(cors);

  it('exposes rate limit and retry-after headers', async () => {
    const res = await request(app).get('/test').set('Origin', 'https://client.com');
    const exposed = res.headers['access-control-expose-headers'];
    expect(exposed).toContain('X-RateLimit-Limit');
    expect(exposed).toContain('Retry-After');
  });
});

describe('parseOriginsFromEnv', () => {
  it('parses wildcard', () => {
    expect(parseOriginsFromEnv('*')).toBe('*');
  });

  it('parses comma-separated origins', () => {
    const result = parseOriginsFromEnv('https://a.com,https://b.com');
    expect(result).toEqual(['https://a.com', 'https://b.com']);
  });

  it('returns empty array for empty string', () => {
    expect(parseOriginsFromEnv('')).toEqual([]);
    expect(parseOriginsFromEnv(undefined)).toEqual([]);
  });
});

describe('createCorsFromEnv', () => {
  beforeEach(() => {
    delete process.env.CORS_ALLOWED_ORIGINS;
    delete process.env.CORS_CREDENTIALS;
    delete process.env.CORS_MAX_AGE;
  });

  afterEach(() => {
    delete process.env.CORS_ALLOWED_ORIGINS;
    delete process.env.CORS_CREDENTIALS;
    delete process.env.CORS_MAX_AGE;
  });

  it('creates a cors middleware from env vars', () => {
    process.env.CORS_ALLOWED_ORIGINS = 'https://env-app.com';
    const corsMiddleware = createCorsFromEnv();
    const app = makeApp(corsMiddleware);

    return request(app)
      .get('/test')
      .set('Origin', 'https://env-app.com')
      .then((res) => {
        expect(res.headers['access-control-allow-origin']).toBe('https://env-app.com');
      });
  });

  it('does not set CORS headers when env is empty (safe default)', () => {
    process.env.CORS_ALLOWED_ORIGINS = '';
    const corsMiddleware = createCorsFromEnv();
    const app = makeApp(corsMiddleware);

    return request(app)
      .get('/test')
      .set('Origin', 'https://anywhere.com')
      .then((res) => {
        expect(res.headers['access-control-allow-origin']).toBeUndefined();
      });
  });
});
