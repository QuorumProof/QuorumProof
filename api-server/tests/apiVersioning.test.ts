/**
 * API Versioning Tests (Issue #1310)
 *
 * Covers:
 *   - Version middleware: URL parsing, req.apiVersion attachment, API-Version header
 *   - Deprecation / sunset headers for maintenance versions
 *   - Unknown version → 404
 *   - Sunset version → 410 helper
 *   - v1 compatibility layer: response envelope (ok / version / data)
 *   - v1 compatibility layer: error envelope (ok: false / version / error)
 *   - v1 compatibility layer: field aliasing (metadata_hash → metadata)
 *   - v2 routes: raw responses without envelope
 *   - Unversioned /api/* routes: pass-through (backward compat)
 *   - Version routing: same handler accessible under both /api/v1/* and /api/v2/*
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import express, { type Request, type Response } from 'express';
import request from 'supertest';
import {
  createApiVersionMiddleware,
  versionGate,
  sunsetHandler,
  VERSION_CATALOGUE,
  type ApiVersion,
} from '../src/middleware/apiVersion.js';
import { v1Compat } from '../src/middleware/v1Compat.js';
import { createV1Router } from '../src/routes/v1/index.js';
import { createV2Router } from '../src/routes/v2/index.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Minimal mock Soroban client used everywhere route factories are called */
const mockSoroban = {
  simulateCall: vi.fn(),
  u64Val: (n: number | bigint) => n as any,
  u32Val: (n: number) => n as any,
  addressVal: (a: string) => a as any,
};

/** Builds a minimal test app with the version middleware mounted */
function buildVersionedApp() {
  const app = express();
  app.use(express.json());
  app.use(createApiVersionMiddleware());
  return app;
}

/** Adds a simple echo handler at `path` that returns `{ payload: "ok" }` */
function addEchoRoute(app: ReturnType<typeof express>, path: string) {
  app.get(path, (_req: Request, res: Response) => {
    res.json({ payload: 'ok' });
  });
}

// ─── Version middleware ───────────────────────────────────────────────────────

describe('createApiVersionMiddleware()', () => {
  describe('version extraction', () => {
    it('sets req.apiVersion to "v1" for /api/v1/* paths', async () => {
      const app = buildVersionedApp();
      app.get('/api/v1/test', (req, res) => {
        res.json({ apiVersion: req.apiVersion });
      });

      const res = await request(app).get('/api/v1/test');
      expect(res.status).toBe(200);
      expect(res.body.apiVersion).toBe('v1');
    });

    it('sets req.apiVersion to "v2" for /api/v2/* paths', async () => {
      const app = buildVersionedApp();
      app.get('/api/v2/test', (req, res) => {
        res.json({ apiVersion: req.apiVersion });
      });

      const res = await request(app).get('/api/v2/test');
      expect(res.status).toBe(200);
      expect(res.body.apiVersion).toBe('v2');
    });

    it('does not set req.apiVersion for unversioned /api/* paths', async () => {
      const app = buildVersionedApp();
      app.get('/api/test', (req, res) => {
        res.json({ apiVersion: req.apiVersion ?? null });
      });

      const res = await request(app).get('/api/test');
      expect(res.status).toBe(200);
      expect(res.body.apiVersion).toBeNull();
    });

    it('does not set req.apiVersion for non-/api paths', async () => {
      const app = buildVersionedApp();
      app.get('/health', (req, res) => {
        res.json({ apiVersion: req.apiVersion ?? null });
      });

      const res = await request(app).get('/health');
      expect(res.status).toBe(200);
      expect(res.body.apiVersion).toBeNull();
    });
  });

  describe('API-Version response header', () => {
    it('sets API-Version header on versioned requests', async () => {
      const app = buildVersionedApp();
      addEchoRoute(app, '/api/v1/test');

      const res = await request(app).get('/api/v1/test');
      expect(res.headers['api-version']).toBe('v1');
    });

    it('sets API-Version: v2 on v2 requests', async () => {
      const app = buildVersionedApp();
      addEchoRoute(app, '/api/v2/test');

      const res = await request(app).get('/api/v2/test');
      expect(res.headers['api-version']).toBe('v2');
    });

    it('does NOT set API-Version on unversioned requests', async () => {
      const app = buildVersionedApp();
      addEchoRoute(app, '/api/test');

      const res = await request(app).get('/api/test');
      expect(res.headers['api-version']).toBeUndefined();
    });
  });

  describe('unknown version → 404', () => {
    it('returns 404 for an unknown version segment', async () => {
      const app = buildVersionedApp();

      const res = await request(app).get('/api/v99/test');
      expect(res.status).toBe(404);
      expect(res.body.error).toBe('Unknown API version');
      expect(res.body.supported_versions).toContain('v1');
      expect(res.body.supported_versions).toContain('v2');
    });

    it('returns 404 for /api/v0 (never existed)', async () => {
      const app = buildVersionedApp();

      const res = await request(app).get('/api/v0/slices');
      expect(res.status).toBe(404);
      expect(res.body.error).toBe('Unknown API version');
    });

    it('returns 404 for /api/v3 (not yet released)', async () => {
      const app = buildVersionedApp();

      const res = await request(app).get('/api/v3/credentials');
      expect(res.status).toBe(404);
    });
  });

  describe('deprecation headers for maintenance versions', () => {
    it('does NOT add Deprecation header for stable v1 (not yet in maintenance)', async () => {
      // v1 is currently "stable" — the Deprecation header should only appear
      // once the status is flipped to "maintenance".
      const app = buildVersionedApp();
      addEchoRoute(app, '/api/v1/test');

      const res = await request(app).get('/api/v1/test');
      // Stable means no deprecation signal yet
      expect(res.headers['deprecation']).toBeUndefined();
    });

    it('does NOT add Deprecation header for v2 (development)', async () => {
      const app = buildVersionedApp();
      addEchoRoute(app, '/api/v2/test');

      const res = await request(app).get('/api/v2/test');
      expect(res.headers['deprecation']).toBeUndefined();
    });

    it('adds Deprecation + Sunset + Link headers when status is "maintenance"', async () => {
      // Temporarily patch the catalogue to simulate a version entering maintenance
      const original = VERSION_CATALOGUE['v1' as ApiVersion];
      (VERSION_CATALOGUE as any).v1 = {
        ...original,
        status: 'maintenance',
        maintenanceDate: '2026-09-01',
        sunsetDate: '2027-03-01',
        migrationGuide: 'https://docs.quorumproof.io/api/migration/v1-to-v2',
      };

      const app = buildVersionedApp();
      addEchoRoute(app, '/api/v1/test');

      try {
        const res = await request(app).get('/api/v1/test');
        expect(res.headers['deprecation']).toBe('2026-09-01');
        expect(res.headers['sunset']).toBe('2027-03-01');
        expect(res.headers['link']).toContain('successor-version');
        expect(res.headers['x-api-deprecation-info']).toBeDefined();
      } finally {
        (VERSION_CATALOGUE as any).v1 = original;
      }
    });
  });
});

// ─── sunsetHandler helper ─────────────────────────────────────────────────────

describe('sunsetHandler()', () => {
  it('returns 410 Gone for sunset versions', async () => {
    const app = express();
    app.use('/api/v0', sunsetHandler('v0'));

    const res = await request(app).get('/api/v0/credentials');
    expect(res.status).toBe(410);
    expect(res.body.error).toBe('API version sunset');
    expect(res.body.message).toContain('v0');
  });
});

// ─── v1 compatibility layer ───────────────────────────────────────────────────

describe('v1Compat middleware', () => {
  function buildV1App() {
    const app = express();
    app.use(express.json());
    // Simulate what the main app does: attach apiVersion then apply compat
    app.use((req, _res, next) => {
      req.apiVersion = 'v1';
      next();
    });
    app.use(v1Compat);
    return app;
  }

  describe('success envelope', () => {
    it('wraps 200 responses in { ok, version, data }', async () => {
      const app = buildV1App();
      app.get('/test', (_req, res) => {
        res.json({ id: '1', name: 'Alice' });
      });

      const res = await request(app).get('/test');
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(res.body.version).toBe('v1');
      expect(res.body.data).toEqual({ id: '1', name: 'Alice' });
    });

    it('sets X-API-Compat-Layer: v1 header', async () => {
      const app = buildV1App();
      app.get('/test', (_req, res) => res.json({}));

      const res = await request(app).get('/test');
      expect(res.headers['x-api-compat-layer']).toBe('v1');
    });

    it('wraps array responses inside data', async () => {
      const app = buildV1App();
      app.get('/test', (_req, res) => {
        res.json([{ id: '1' }, { id: '2' }]);
      });

      const res = await request(app).get('/test');
      expect(res.body.ok).toBe(true);
      expect(Array.isArray(res.body.data)).toBe(true);
      expect(res.body.data).toHaveLength(2);
    });

    it('wraps null body in data', async () => {
      const app = buildV1App();
      app.get('/test', (_req, res) => res.json(null));

      const res = await request(app).get('/test');
      expect(res.body.ok).toBe(true);
      expect(res.body.data).toBeNull();
    });
  });

  describe('error envelope', () => {
    it('wraps 400 responses in { ok: false, version, error }', async () => {
      const app = buildV1App();
      app.get('/test', (_req, res) => {
        res.status(400).json({ error: 'Invalid ID', detail: 'must be a number' });
      });

      const res = await request(app).get('/test');
      expect(res.status).toBe(400);
      expect(res.body.ok).toBe(false);
      expect(res.body.version).toBe('v1');
      expect(res.body.error).toBe('Invalid ID');
      expect(res.body.details).toBeDefined();
    });

    it('wraps 404 responses in error envelope', async () => {
      const app = buildV1App();
      app.get('/test', (_req, res) => {
        res.status(404).json({ error: 'Not found' });
      });

      const res = await request(app).get('/test');
      expect(res.body.ok).toBe(false);
      expect(res.body.error).toBe('Not found');
    });

    it('wraps 500 responses in error envelope', async () => {
      const app = buildV1App();
      app.get('/test', (_req, res) => {
        res.status(500).json({ error: 'Internal error' });
      });

      const res = await request(app).get('/test');
      expect(res.body.ok).toBe(false);
    });
  });

  describe('field aliasing', () => {
    it('adds metadata alias for metadata_hash', async () => {
      const app = buildV1App();
      app.get('/test', (_req, res) => {
        res.json({ id: '1', metadata_hash: 'abc123' });
      });

      const res = await request(app).get('/test');
      expect(res.body.data.metadata_hash).toBe('abc123');
      expect(res.body.data.metadata).toBe('abc123');
    });

    it('adds address alias for stellar_address', async () => {
      const app = buildV1App();
      app.get('/test', (_req, res) => {
        res.json({ id: '1', stellar_address: 'GABC' });
      });

      const res = await request(app).get('/test');
      expect(res.body.data.stellar_address).toBe('GABC');
      expect(res.body.data.address).toBe('GABC');
    });

    it('applies aliases to all items in an array response', async () => {
      const app = buildV1App();
      app.get('/test', (_req, res) => {
        res.json([
          { id: '1', metadata_hash: 'hash1' },
          { id: '2', metadata_hash: 'hash2' },
        ]);
      });

      const res = await request(app).get('/test');
      expect(res.body.data[0].metadata).toBe('hash1');
      expect(res.body.data[1].metadata).toBe('hash2');
    });

    it('does not overwrite an existing alias field if already set', async () => {
      const app = buildV1App();
      app.get('/test', (_req, res) => {
        res.json({ id: '1', metadata_hash: 'new', metadata: 'existing' });
      });

      const res = await request(app).get('/test');
      // Pre-existing alias should not be clobbered
      expect(res.body.data.metadata).toBe('existing');
    });
  });

  describe('v2 requests skip compat layer', () => {
    it('passes v2 responses through unmodified', async () => {
      const app = express();
      app.use(express.json());
      app.use((req, _res, next) => {
        req.apiVersion = 'v2';
        next();
      });
      app.use(v1Compat);
      app.get('/test', (_req, res) => {
        res.json({ id: '1', payload: 'raw' });
      });

      const res = await request(app).get('/test');
      expect(res.body.ok).toBeUndefined();
      expect(res.body.id).toBe('1');
    });

    it('does not set X-API-Compat-Layer header on v2 requests', async () => {
      const app = express();
      app.use(express.json());
      app.use((req, _res, next) => {
        req.apiVersion = 'v2';
        next();
      });
      app.use(v1Compat);
      app.get('/test', (_req, res) => res.json({}));

      const res = await request(app).get('/test');
      expect(res.headers['x-api-compat-layer']).toBeUndefined();
    });
  });

  describe('unversioned requests skip compat layer', () => {
    it('passes unversioned responses through unmodified', async () => {
      const app = express();
      app.use(express.json());
      // No apiVersion set — simulates unversioned /api/* path
      app.use(v1Compat);
      app.get('/api/test', (_req, res) => {
        res.json({ id: '1', payload: 'raw' });
      });

      const res = await request(app).get('/api/test');
      expect(res.body.ok).toBeUndefined();
      expect(res.body.payload).toBe('raw');
    });
  });
});

// ─── Full integration: version routing ───────────────────────────────────────

describe('Version routing integration', () => {
  let app: ReturnType<typeof express>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockSoroban.simulateCall.mockReset();
  });

  /**
   * Builds a minimal app with versioning middleware + v1/v2 routers containing
   * a single test endpoint that returns a known payload.
   */
  function buildIntegrationApp() {
    const a = express();
    a.use(express.json());
    a.use(createApiVersionMiddleware());

    // Mount a tiny versioned sub-router for testing
    const testRouterV1 = express.Router();
    testRouterV1.get('/ping', (_req, res) => res.json({ pong: 'v1' }));

    const testRouterV2 = express.Router();
    testRouterV2.get('/ping', (_req, res) => res.json({ pong: 'v2' }));

    a.use('/api/v1', v1Compat, testRouterV1);
    a.use('/api/v2', testRouterV2);

    // Unversioned legacy
    a.get('/api/ping', (_req, res) => res.json({ pong: 'legacy' }));

    return a;
  }

  it('routes /api/v1/* through the v1 router', async () => {
    const a = buildIntegrationApp();
    const res = await request(a).get('/api/v1/ping');
    expect(res.status).toBe(200);
    // v1 envelope wraps the response
    expect(res.body.version).toBe('v1');
    expect(res.body.data.pong).toBe('v1');
  });

  it('routes /api/v2/* through the v2 router (no envelope)', async () => {
    const a = buildIntegrationApp();
    const res = await request(a).get('/api/v2/ping');
    expect(res.status).toBe(200);
    // v2 has no envelope
    expect(res.body.ok).toBeUndefined();
    expect(res.body.pong).toBe('v2');
  });

  it('routes /api/* through legacy paths (no envelope, no API-Version header)', async () => {
    const a = buildIntegrationApp();
    const res = await request(a).get('/api/ping');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBeUndefined();
    expect(res.body.pong).toBe('legacy');
    expect(res.headers['api-version']).toBeUndefined();
  });

  it('returns 404 for unsupported version prefix', async () => {
    const a = buildIntegrationApp();
    const res = await request(a).get('/api/v99/ping');
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('Unknown API version');
  });

  it('v1 envelope wraps errors produced by route handlers', async () => {
    const a = express();
    a.use(express.json());
    a.use(createApiVersionMiddleware());
    const testRouter = express.Router();
    testRouter.get('/fail', (_req, res) => {
      res.status(404).json({ error: 'not found in v1' });
    });
    a.use('/api/v1', v1Compat, testRouter);

    const res = await request(a).get('/api/v1/fail');
    expect(res.status).toBe(404);
    expect(res.body.ok).toBe(false);
    expect(res.body.version).toBe('v1');
    expect(res.body.error).toBe('not found in v1');
  });

  it('v2 errors are NOT wrapped in an envelope', async () => {
    const a = express();
    a.use(express.json());
    a.use(createApiVersionMiddleware());
    const testRouter = express.Router();
    testRouter.get('/fail', (_req, res) => {
      res.status(404).json({ error: 'not found in v2' });
    });
    a.use('/api/v2', testRouter);

    const res = await request(a).get('/api/v2/fail');
    expect(res.status).toBe(404);
    expect(res.body.ok).toBeUndefined();
    expect(res.body.error).toBe('not found in v2');
  });
});

// ─── VERSION_CATALOGUE contract ───────────────────────────────────────────────

describe('VERSION_CATALOGUE', () => {
  it('defines v1 with a sunsetDate in the future', () => {
    const v1 = VERSION_CATALOGUE.v1;
    expect(v1.sunsetDate).toBeDefined();
    const sunset = new Date(v1.sunsetDate!);
    expect(sunset.getTime()).toBeGreaterThan(Date.now());
  });

  it('defines v2 with development status', () => {
    expect(VERSION_CATALOGUE.v2.status).toBe('development');
  });

  it('provides a migrationGuide for v1', () => {
    expect(VERSION_CATALOGUE.v1.migrationGuide).toBeTruthy();
  });
});
