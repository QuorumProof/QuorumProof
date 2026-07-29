/**
 * Tests for Issue #1314 — Caching Headers and ETag Support
 *
 * Covers:
 *   - Cache-Control header is set on GET responses
 *   - Per-path strategy selection
 *   - Custom route-level override via cacheStrategy()
 *   - ETag header is generated for GET responses
 *   - 304 Not Modified when If-None-Match matches
 *   - Cache-Control is not set on non-GET requests
 *   - Routes that set their own Cache-Control are not overridden
 *   - computeETag() determinism and uniqueness
 *   - /api/verify gets no-store (ETags disabled)
 */

import { describe, it, expect } from 'vitest';
import express from 'express';
import request from 'supertest';
import { cacheControl, cacheStrategy, computeETag } from '../src/middleware/cacheControl.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createTestApp() {
  const app = express();
  app.use(cacheControl);

  // Default endpoint — triggers the default strategy
  app.get('/api/test', (_req, res) => res.json({ ok: true }));

  // Non-GET endpoint
  app.post('/api/test', (_req, res) => res.json({ ok: true }));

  // Route overrides Cache-Control before cacheControl middleware runs
  app.get('/api/custom', (_req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.json({ ok: true });
  });

  // Slice-class path
  app.get('/api/slices', (_req, res) => res.json({ data: [] }));

  // Attestor-class path (public caching)
  app.get('/api/attestors', (_req, res) => res.json({ attestors: [] }));

  // Verify-class path (no-store, no etag)
  app.get('/api/verify/1', (_req, res) => res.json({ verified: true }));

  // Analytics path
  app.get('/api/analytics/summary', (_req, res) => res.json({ events: 0 }));

  // Credentials path
  app.get('/api/credentials', (_req, res) => res.json({ credentials: [] }));

  // Health
  app.get('/health', (_req, res) => res.json({ status: 'ok' }));

  // Route-level override using cacheStrategy()
  app.get(
    '/api/expensive',
    cacheStrategy('public, max-age=3600, immutable'),
    (_req, res) => res.json({ computed: true }),
  );

  return app;
}

// ---------------------------------------------------------------------------
// Cache-Control header
// ---------------------------------------------------------------------------

describe('Cache-Control header', () => {
  const app = createTestApp();

  it('sets Cache-Control on GET responses', async () => {
    const res = await request(app).get('/api/test');
    expect(res.headers['cache-control']).toBeDefined();
  });

  it('does not set Cache-Control on POST responses', async () => {
    const res = await request(app).post('/api/test');
    expect(res.headers['cache-control']).toBeUndefined();
  });

  it('does not override Cache-Control set by a route', async () => {
    const res = await request(app).get('/api/custom');
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('uses default strategy for unknown paths', async () => {
    const res = await request(app).get('/api/test');
    expect(res.headers['cache-control']).toBe('private, max-age=30, must-revalidate');
  });

  it('uses credentials strategy for /api/credentials', async () => {
    const res = await request(app).get('/api/credentials');
    expect(res.headers['cache-control']).toBe('private, max-age=30, must-revalidate');
  });

  it('uses slices strategy for /api/slices', async () => {
    const res = await request(app).get('/api/slices');
    expect(res.headers['cache-control']).toBe('private, max-age=60, must-revalidate');
  });

  it('uses attestors strategy (public) for /api/attestors', async () => {
    const res = await request(app).get('/api/attestors');
    expect(res.headers['cache-control']).toBe(
      'public, max-age=300, stale-while-revalidate=60',
    );
  });

  it('uses no-store for /api/verify paths', async () => {
    const res = await request(app).get('/api/verify/1');
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('uses analytics strategy for /api/analytics', async () => {
    const res = await request(app).get('/api/analytics/summary');
    expect(res.headers['cache-control']).toBe('private, max-age=120, must-revalidate');
  });

  it('uses health strategy for /health', async () => {
    const res = await request(app).get('/health');
    expect(res.headers['cache-control']).toBe('public, max-age=10');
  });

  it('respects cacheStrategy() route-level override', async () => {
    const res = await request(app).get('/api/expensive');
    expect(res.headers['cache-control']).toBe('public, max-age=3600, immutable');
  });
});

// ---------------------------------------------------------------------------
// ETag header
// ---------------------------------------------------------------------------

describe('ETag header', () => {
  const app = createTestApp();

  it('sets an ETag header on GET responses', async () => {
    const res = await request(app).get('/api/test');
    expect(res.headers['etag']).toBeDefined();
  });

  it('ETag is a weak ETag (starts with W/")', async () => {
    const res = await request(app).get('/api/test');
    expect(res.headers['etag']).toMatch(/^W\//);
  });

  it('same response body produces the same ETag on repeated requests', async () => {
    const res1 = await request(app).get('/api/test');
    const res2 = await request(app).get('/api/test');
    expect(res1.headers['etag']).toBe(res2.headers['etag']);
  });

  it('different response bodies produce different ETags', async () => {
    const res1 = await request(app).get('/api/test');
    const res2 = await request(app).get('/api/slices');
    expect(res1.headers['etag']).not.toBe(res2.headers['etag']);
  });

  it('does NOT set ETag on /api/verify (no-store strategy)', async () => {
    const res = await request(app).get('/api/verify/1');
    // no-store endpoints skip ETag logic entirely
    expect(res.headers['etag']).toBeUndefined();
  });

  it('does not set ETag on POST responses', async () => {
    const res = await request(app).post('/api/test');
    expect(res.headers['etag']).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 304 Not Modified
// ---------------------------------------------------------------------------

describe('304 Not Modified', () => {
  const app = createTestApp();

  it('returns 304 when If-None-Match matches the ETag', async () => {
    // First request — capture ETag
    const first = await request(app).get('/api/test');
    const etag = first.headers['etag'];
    expect(etag).toBeDefined();

    // Second request with the ETag
    const second = await request(app)
      .get('/api/test')
      .set('If-None-Match', etag as string);
    expect(second.status).toBe(304);
    expect(second.text).toBe('');
  });

  it('still sends Cache-Control and ETag on 304 responses', async () => {
    const first = await request(app).get('/api/slices');
    const etag = first.headers['etag'] as string;

    const second = await request(app)
      .get('/api/slices')
      .set('If-None-Match', etag);

    expect(second.status).toBe(304);
    expect(second.headers['cache-control']).toBeDefined();
    expect(second.headers['etag']).toBe(etag);
  });

  it('returns 200 when If-None-Match does not match', async () => {
    const res = await request(app)
      .get('/api/test')
      .set('If-None-Match', 'W/"stale-etag-value"');
    expect(res.status).toBe(200);
  });

  it('returns 304 for If-None-Match: * (wildcard)', async () => {
    const res = await request(app)
      .get('/api/test')
      .set('If-None-Match', '*');
    expect(res.status).toBe(304);
  });

  it('does not 304 /api/verify even with If-None-Match (no ETag emitted)', async () => {
    // no-store paths don't emit ETag headers — so a normal client will never
    // send back a matching If-None-Match. We verify the ETag is absent.
    const res = await request(app).get('/api/verify/1');
    expect(res.headers['etag']).toBeUndefined();
    expect(res.headers['cache-control']).toBe('no-store');
  });
});

// ---------------------------------------------------------------------------
// computeETag() unit tests
// ---------------------------------------------------------------------------

describe('computeETag()', () => {
  it('returns a string starting with W/"', () => {
    expect(computeETag('hello')).toMatch(/^W\//);
  });

  it('is deterministic for the same input', () => {
    expect(computeETag('same')).toBe(computeETag('same'));
  });

  it('produces different values for different inputs', () => {
    expect(computeETag('a')).not.toBe(computeETag('b'));
  });

  it('accepts Buffer input', () => {
    const buf = Buffer.from('buffer data');
    const tag = computeETag(buf);
    expect(tag).toMatch(/^W\//);
    // Should equal the string version
    expect(tag).toBe(computeETag('buffer data'));
  });
});
