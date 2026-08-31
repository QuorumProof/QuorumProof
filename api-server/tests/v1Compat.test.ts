/**
 * Tests for v1 Compatibility Layer (Issue #1437)
 *
 * Covers:
 *   - Envelope wrapping for 2xx responses: { ok: true, version: 'v1', data: <body> }
 *   - Envelope wrapping for 4xx/5xx errors: { ok: false, version: 'v1', error: <string>, details: <body> }
 *   - Field aliases: metadata_hash → metadata, stellar_address → address (added alongside)
 *   - Alias applied inside array-of-objects, not just plain objects
 *   - Non-v1 requests (v2) pass through raw with no envelope
 *   - The X-API-Compat-Layer: v1 header is set on v1 requests
 *   - Regression lock: exact shape of a v1 credential response
 *   - Interaction: v1Compat middleware + v2 router returns raw response
 */

import { describe, it, expect, beforeEach } from 'vitest';
import express, { type Request, type Response } from 'express';
import request from 'supertest';
import { v1Compat } from '../src/middleware/v1Compat.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Build an express app with apiVersion forced to 'v1' and v1Compat applied. */
function buildV1App() {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: () => void) => {
    req.apiVersion = 'v1';
    next();
  });
  app.use(v1Compat);
  return app;
}

/** Build an express app with apiVersion forced to 'v2' (no compat layer transformation). */
function buildV2App() {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: () => void) => {
    req.apiVersion = 'v2';
    next();
  });
  app.use(v1Compat);
  return app;
}

/** Build an express app with no apiVersion set (unversioned /api/*). */
function buildUnversionedApp() {
  const app = express();
  app.use(express.json());
  // No apiVersion set — simulates unversioned request
  app.use(v1Compat);
  return app;
}

// ─── Envelope wrapping — 2xx ──────────────────────────────────────────────────

describe('v1Compat — 2xx envelope wrapping', () => {
  let app: ReturnType<typeof express>;

  beforeEach(() => {
    app = buildV1App();
  });

  it('wraps a 200 JSON object in { ok: true, version: "v1", data: <body> }', async () => {
    app.get('/test', (_req, res) => {
      res.json({ id: '42', name: 'Alice' });
    });

    const res = await request(app).get('/test');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.version).toBe('v1');
    expect(res.body.data).toEqual({ id: '42', name: 'Alice' });
  });

  it('wraps a 201 response in the success envelope', async () => {
    app.post('/test', (_req, res) => {
      res.status(201).json({ id: '1', created: true });
    });

    const res = await request(app).post('/test').send({});
    expect(res.status).toBe(201);
    expect(res.body.ok).toBe(true);
    expect(res.body.version).toBe('v1');
    expect(res.body.data).toEqual({ id: '1', created: true });
  });

  it('wraps an array body inside the data field', async () => {
    app.get('/test', (_req, res) => {
      res.json([{ id: '1' }, { id: '2' }]);
    });

    const res = await request(app).get('/test');
    expect(res.body.ok).toBe(true);
    expect(res.body.version).toBe('v1');
    expect(Array.isArray(res.body.data)).toBe(true);
    expect(res.body.data).toHaveLength(2);
  });

  it('wraps a null body in the data field', async () => {
    app.get('/test', (_req, res) => {
      res.json(null);
    });

    const res = await request(app).get('/test');
    expect(res.body.ok).toBe(true);
    expect(res.body.data).toBeNull();
  });

  it('sets X-API-Compat-Layer: v1 header on v1 requests', async () => {
    app.get('/test', (_req, res) => res.json({}));

    const res = await request(app).get('/test');
    expect(res.headers['x-api-compat-layer']).toBe('v1');
  });
});

// ─── Envelope wrapping — 4xx / 5xx errors ─────────────────────────────────────

describe('v1Compat — error envelope wrapping', () => {
  let app: ReturnType<typeof express>;

  beforeEach(() => {
    app = buildV1App();
  });

  it('wraps 400 in { ok: false, version: "v1", error: <string>, details: <body> }', async () => {
    app.get('/test', (_req, res) => {
      res.status(400).json({ error: 'Invalid input', field: 'id' });
    });

    const res = await request(app).get('/test');
    expect(res.status).toBe(400);
    expect(res.body.ok).toBe(false);
    expect(res.body.version).toBe('v1');
    expect(res.body.error).toBe('Invalid input');
    expect(res.body.details).toBeDefined();
    expect(res.body.details.field).toBe('id');
  });

  it('wraps 404 in the error envelope', async () => {
    app.get('/test', (_req, res) => {
      res.status(404).json({ error: 'Not found' });
    });

    const res = await request(app).get('/test');
    expect(res.status).toBe(404);
    expect(res.body.ok).toBe(false);
    expect(res.body.version).toBe('v1');
    expect(res.body.error).toBe('Not found');
  });

  it('wraps 422 in the error envelope', async () => {
    app.get('/test', (_req, res) => {
      res.status(422).json({ error: 'Unprocessable entity', details: 'validation failed' });
    });

    const res = await request(app).get('/test');
    expect(res.status).toBe(422);
    expect(res.body.ok).toBe(false);
    expect(res.body.error).toBe('Unprocessable entity');
  });

  it('wraps 500 in the error envelope', async () => {
    app.get('/test', (_req, res) => {
      res.status(500).json({ error: 'Internal server error' });
    });

    const res = await request(app).get('/test');
    expect(res.status).toBe(500);
    expect(res.body.ok).toBe(false);
    expect(res.body.version).toBe('v1');
    expect(res.body.error).toBe('Internal server error');
  });

  it('falls back to a generic error message when error field is absent in the body', async () => {
    app.get('/test', (_req, res) => {
      res.status(400).json({ message: 'something bad' });
    });

    const res = await request(app).get('/test');
    expect(res.body.ok).toBe(false);
    // Should not be undefined — falls back to "An error occurred"
    expect(typeof res.body.error).toBe('string');
    expect(res.body.error.length).toBeGreaterThan(0);
  });
});

// ─── Field aliases ─────────────────────────────────────────────────────────────

describe('v1Compat — field aliasing', () => {
  let app: ReturnType<typeof express>;

  beforeEach(() => {
    app = buildV1App();
  });

  it('adds metadata alias for metadata_hash (alongside, not replacing)', async () => {
    app.get('/test', (_req, res) => {
      res.json({ id: '1', metadata_hash: 'abc123' });
    });

    const res = await request(app).get('/test');
    expect(res.body.data.metadata_hash).toBe('abc123');
    expect(res.body.data.metadata).toBe('abc123');
  });

  it('adds address alias for stellar_address (alongside, not replacing)', async () => {
    app.get('/test', (_req, res) => {
      res.json({ id: '1', stellar_address: 'GABC1234' });
    });

    const res = await request(app).get('/test');
    expect(res.body.data.stellar_address).toBe('GABC1234');
    expect(res.body.data.address).toBe('GABC1234');
  });

  it('applies aliases to all items in an array-of-objects response', async () => {
    app.get('/test', (_req, res) => {
      res.json([
        { id: '1', metadata_hash: 'hash1', stellar_address: 'GAAA' },
        { id: '2', metadata_hash: 'hash2', stellar_address: 'GBBB' },
      ]);
    });

    const res = await request(app).get('/test');
    expect(res.body.data[0].metadata).toBe('hash1');
    expect(res.body.data[0].address).toBe('GAAA');
    expect(res.body.data[1].metadata).toBe('hash2');
    expect(res.body.data[1].address).toBe('GBBB');
    // Originals also present
    expect(res.body.data[0].metadata_hash).toBe('hash1');
    expect(res.body.data[0].stellar_address).toBe('GAAA');
  });

  it('does not overwrite an existing alias field if already set', async () => {
    app.get('/test', (_req, res) => {
      res.json({ id: '1', metadata_hash: 'new-value', metadata: 'pre-existing' });
    });

    const res = await request(app).get('/test');
    expect(res.body.data.metadata).toBe('pre-existing');
    expect(res.body.data.metadata_hash).toBe('new-value');
  });

  it('applies both aliases together when both fields are present', async () => {
    app.get('/test', (_req, res) => {
      res.json({ metadata_hash: 'mhash', stellar_address: 'STELLAR1' });
    });

    const res = await request(app).get('/test');
    expect(res.body.data.metadata).toBe('mhash');
    expect(res.body.data.address).toBe('STELLAR1');
  });
});

// ─── v2 requests — pass through without envelope ──────────────────────────────

describe('v1Compat — v2 requests pass through raw', () => {
  it('does not wrap v2 responses in an envelope', async () => {
    const app = buildV2App();
    app.get('/test', (_req, res) => {
      res.json({ id: '1', payload: 'raw-v2' });
    });

    const res = await request(app).get('/test');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBeUndefined();
    expect(res.body.version).toBeUndefined();
    expect(res.body.id).toBe('1');
    expect(res.body.payload).toBe('raw-v2');
  });

  it('does not set X-API-Compat-Layer header on v2 requests', async () => {
    const app = buildV2App();
    app.get('/test', (_req, res) => res.json({}));

    const res = await request(app).get('/test');
    expect(res.headers['x-api-compat-layer']).toBeUndefined();
  });

  it('does not envelope v2 error responses either', async () => {
    const app = buildV2App();
    app.get('/test', (_req, res) => {
      res.status(404).json({ error: 'not found in v2' });
    });

    const res = await request(app).get('/test');
    expect(res.status).toBe(404);
    expect(res.body.ok).toBeUndefined();
    expect(res.body.error).toBe('not found in v2');
  });
});

// ─── Unversioned requests — pass through ──────────────────────────────────────

describe('v1Compat — unversioned requests pass through raw', () => {
  it('does not wrap unversioned responses in an envelope', async () => {
    const app = buildUnversionedApp();
    app.get('/api/test', (_req, res) => {
      res.json({ id: '1', payload: 'legacy' });
    });

    const res = await request(app).get('/api/test');
    expect(res.body.ok).toBeUndefined();
    expect(res.body.payload).toBe('legacy');
  });

  it('does not set X-API-Compat-Layer header on unversioned requests', async () => {
    const app = buildUnversionedApp();
    app.get('/api/test', (_req, res) => res.json({}));

    const res = await request(app).get('/api/test');
    expect(res.headers['x-api-compat-layer']).toBeUndefined();
  });
});

// ─── Regression lock — exact shape of a v1 credential response ────────────────

describe('v1Compat — regression lock: v1 credential response shape', () => {
  it('produces the exact expected envelope for a typical credential object', async () => {
    const app = buildV1App();

    const credentialPayload = {
      id: '7',
      subject: 'GSUBJECT1234567890ABCDEF',
      issuer: 'GISSUER9876543210ABCDEF',
      credential_type: 1,
      metadata_hash: 'deadbeef0102030405060708',
      stellar_address: 'GSUBJECT1234567890ABCDEF',
      revoked: false,
    };

    app.get('/credential/7', (_req, res) => {
      res.json(credentialPayload);
    });

    const res = await request(app).get('/credential/7');

    // Top-level envelope shape
    expect(res.body).toMatchObject({
      ok: true,
      version: 'v1',
    });

    // Data contains all original fields
    expect(res.body.data.id).toBe('7');
    expect(res.body.data.credential_type).toBe(1);
    expect(res.body.data.revoked).toBe(false);

    // Field aliases added alongside
    expect(res.body.data.metadata_hash).toBe('deadbeef0102030405060708');
    expect(res.body.data.metadata).toBe('deadbeef0102030405060708');
    expect(res.body.data.stellar_address).toBe('GSUBJECT1234567890ABCDEF');
    expect(res.body.data.address).toBe('GSUBJECT1234567890ABCDEF');

    // No extraneous top-level keys
    const topLevelKeys = Object.keys(res.body);
    expect(topLevelKeys).toContain('ok');
    expect(topLevelKeys).toContain('version');
    expect(topLevelKeys).toContain('data');
    // No 'error' or 'details' on success
    expect(topLevelKeys).not.toContain('error');
    expect(topLevelKeys).not.toContain('details');
  });
});

// ─── Interaction: v1Compat + v2 router returns raw ────────────────────────────

describe('v1Compat — interaction with v2 router returns raw response', () => {
  it('v2 router mounted after v1Compat returns raw body (no envelope)', async () => {
    const app = express();
    app.use(express.json());

    // v1Compat is mounted globally, but the v2 route has apiVersion='v2'
    app.use(v1Compat);

    const v2Router = express.Router();
    v2Router.get('/resource', (_req, res) => {
      res.json({ version: 'v2-raw', count: 3 });
    });

    // Mount v2 router; simulate version middleware having set apiVersion='v2'
    app.use('/api/v2', (req: Request, _res: Response, next: () => void) => {
      req.apiVersion = 'v2';
      next();
    }, v2Router);

    const res = await request(app).get('/api/v2/resource');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBeUndefined();
    expect(res.body.version).toBe('v2-raw');
    expect(res.body.count).toBe(3);
  });
});
