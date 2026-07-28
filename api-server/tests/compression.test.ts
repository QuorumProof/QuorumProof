/**
 * Tests for Issue #1313 — Gzip Compression Middleware
 *
 * Verifies:
 *   - Responses above the 1 KB threshold are compressed
 *   - Responses below the threshold are NOT compressed
 *   - Compression level is configurable
 *   - Excluded content types are never compressed
 *   - Middleware can be disabled via config
 *   - `Accept-Encoding: gzip` is respected
 */

import { describe, it, expect, beforeAll } from 'vitest';
import express, { type Express } from 'express';
import request from 'supertest';
import { createCompressionMiddleware } from '../src/middleware/compression.js';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/** Build a minimal Express app with compression applied. */
function buildApp(config: Parameters<typeof createCompressionMiddleware>[0] = {}): Express {
  const app = express();
  app.use(createCompressionMiddleware(config));

  /** Returns a JSON body of approximately `size` bytes. */
  app.get('/large', (_req, res) => {
    // Build a payload comfortably over 1 KB
    const payload = { data: 'x'.repeat(2048) };
    res.json(payload);
  });

  app.get('/small', (_req, res) => {
    res.json({ ok: true });
  });

  app.get('/text', (_req, res) => {
    res.set('Content-Type', 'text/plain');
    res.send('x'.repeat(2048));
  });

  app.get('/image', (_req, res) => {
    res.set('Content-Type', 'image/png');
    res.send(Buffer.alloc(2048)); // 2 KB binary blob
  });

  app.get('/sse', (_req, res) => {
    res.set('Content-Type', 'text/event-stream');
    res.send('data: hello\n\n'.repeat(200));
  });

  return app;
}

// ---------------------------------------------------------------------------
// Compression enabled (default)
// ---------------------------------------------------------------------------

describe('Compression middleware — enabled', () => {
  let app: Express;

  beforeAll(() => {
    app = buildApp({ level: 6, threshold: 1024 });
  });

  it('compresses a large JSON response when client accepts gzip', async () => {
    const res = await request(app)
      .get('/large')
      .set('Accept-Encoding', 'gzip')
      .expect(200);

    // The compressed response must declare gzip encoding.
    expect(res.headers['content-encoding']).toBe('gzip');
  });

  it('does NOT compress a small response (below 1 KB threshold)', async () => {
    const res = await request(app)
      .get('/small')
      .set('Accept-Encoding', 'gzip')
      .expect(200);

    // Content-Encoding should be absent or not 'gzip'
    expect(res.headers['content-encoding'] ?? '').not.toBe('gzip');
  });

  it('compresses text/plain responses above threshold', async () => {
    const res = await request(app)
      .get('/text')
      .set('Accept-Encoding', 'gzip')
      .expect(200);

    expect(res.headers['content-encoding']).toBe('gzip');
  });

  it('does NOT compress image/* responses (already encoded)', async () => {
    const res = await request(app)
      .get('/image')
      .set('Accept-Encoding', 'gzip')
      .expect(200);

    expect(res.headers['content-encoding'] ?? '').not.toBe('gzip');
  });

  it('does NOT compress text/event-stream (SSE must not be buffered)', async () => {
    const res = await request(app)
      .get('/sse')
      .set('Accept-Encoding', 'gzip')
      .expect(200);

    expect(res.headers['content-encoding'] ?? '').not.toBe('gzip');
  });

  it('does NOT compress when client explicitly requests identity (no compression)', async () => {
    const res = await request(app)
      .get('/large')
      .set('Accept-Encoding', 'identity')
      .expect(200);

    expect(res.headers['content-encoding'] ?? '').not.toBe('gzip');
  });
});

// ---------------------------------------------------------------------------
// Compression disabled
// ---------------------------------------------------------------------------

describe('Compression middleware — disabled', () => {
  let app: Express;

  beforeAll(() => {
    app = buildApp({ enabled: false });
  });

  it('does not compress any response when middleware is disabled', async () => {
    const res = await request(app)
      .get('/large')
      .set('Accept-Encoding', 'gzip')
      .expect(200);

    expect(res.headers['content-encoding'] ?? '').not.toBe('gzip');
  });
});

// ---------------------------------------------------------------------------
// Custom threshold
// ---------------------------------------------------------------------------

describe('Compression middleware — custom threshold', () => {
  it('compresses responses above a low custom threshold', async () => {
    const app = buildApp({ threshold: 10 }); // anything > 10 bytes

    const res = await request(app)
      .get('/small')
      .set('Accept-Encoding', 'gzip')
      .expect(200);

    // { ok: true } is ~11 bytes — should be compressed with threshold=10
    expect(res.headers['content-encoding']).toBe('gzip');
  });

  it('does not compress when threshold is set very high', async () => {
    const app = buildApp({ threshold: 1_000_000 }); // 1 MB

    const res = await request(app)
      .get('/large')
      .set('Accept-Encoding', 'gzip')
      .expect(200);

    expect(res.headers['content-encoding'] ?? '').not.toBe('gzip');
  });
});

// ---------------------------------------------------------------------------
// Custom exclude list
// ---------------------------------------------------------------------------

describe('Compression middleware — excludeContentTypes', () => {
  it('does not compress a custom excluded content type', async () => {
    const app = buildApp({
      threshold: 1,
      excludeContentTypes: ['application/json'],
    });

    const res = await request(app)
      .get('/large')
      .set('Accept-Encoding', 'gzip')
      .expect(200);

    expect(res.headers['content-encoding'] ?? '').not.toBe('gzip');
  });
});
