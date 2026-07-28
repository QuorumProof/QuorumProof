/**
 * Tests for infrastructure modules:
 * - #1306 Structured logging
 * - #1308 Health check endpoints
 * - #1311 Graceful shutdown
 * - #1312 Request validation
 */

import { describe, it, expect, beforeEach } from 'vitest';
import express, { Express } from 'express';
import request from 'supertest';

// ============================================================================
// Health check tests (#1308)
// ============================================================================

describe('Health checks (#1308)', () => {
  it('GET /health/live should always return 200', async () => {
    const { handleLive } = await import('../src/health.js');

    const app = express();
    app.get('/health/live', handleLive);

    const res = await request(app).get('/health/live');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('live');
  });

  it('GET /health/ready should respond with 200 or 503', async () => {
    const { handleReady } = await import('../src/health.js');

    const app = express();
    app.get('/health/ready', handleReady);

    const res = await request(app).get('/health/ready');
    expect([200, 503]).toContain(res.status);
    expect(['ready', 'not_ready']).toContain(res.body.status);
  });

  it('GET /health/ready should return 503 when draining', async () => {
    const { handleReady } = await import('../src/health.js');
    const { setDraining } = await import('../src/shutdown.js');

    setDraining(true);

    const app = express();
    app.get('/health/ready', handleReady);

    const res = await request(app).get('/health/ready');
    expect(res.status).toBe(503);
    expect(res.body.reason).toBe('draining');

    setDraining(false);
  });

  it('GET /health should include dependencies info', async () => {
    const { handleHealth } = await import('../src/health.js');

    const app = express();
    app.get('/health', handleHealth);

    const res = await request(app).get('/health');
    expect([200, 503]).toContain(res.status);
    expect(res.body).toHaveProperty('dependencies');
    expect(res.body).toHaveProperty('connections');
    expect(['ok', 'degraded']).toContain(res.body.status);
  });

  it('health checks should include latencyMs', async () => {
    const { handleReady } = await import('../src/health.js');

    const app = express();
    app.get('/health/ready', handleReady);

    const res = await request(app).get('/health/ready');
    expect(res.body).toHaveProperty('latencyMs');
    expect(typeof res.body.latencyMs).toBe('number');
    expect(res.body.latencyMs).toBeGreaterThanOrEqual(0);
  });
});

// ============================================================================
// Graceful shutdown tests (#1311)
// ============================================================================

describe('Graceful shutdown (#1311)', () => {
  it('setupGracefulShutdown should return a shutdown function', async () => {
    const { setupGracefulShutdown } = await import('../src/shutdown.js');
    const { createServer } = await import('http');

    const app = express();
    const server = createServer(app);

    const shutdown = setupGracefulShutdown(server);
    expect(typeof shutdown).toBe('function');

    server.close();
  });

  it('isDraining should reflect draining state', async () => {
    const { isDraining, setDraining } = await import('../src/shutdown.js');

    expect(isDraining()).toBe(false);

    setDraining(true);
    expect(isDraining()).toBe(true);

    setDraining(false);
    expect(isDraining()).toBe(false);
  });
});

// ============================================================================
// Request validation tests (#1312)
// ============================================================================

describe('Request validation middleware (#1312)', () => {
  it('validate should accept valid requests', async () => {
    const { validate } = await import('../src/middleware/validate.js');

    const app = express();
    app.use(express.json());

    const schema = {
      body: {
        type: 'object' as const,
        properties: {
          name: { type: 'string' as const },
          age: { type: 'integer' as const },
        },
        required: ['name'],
        additionalProperties: false,
      },
    };

    app.post('/test', validate(schema), (_req, res) => {
      res.json({ ok: true });
    });

    const res = await request(app)
      .post('/test')
      .send({ name: 'Alice', age: 30 });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it('validate should reject invalid requests with detailed errors', async () => {
    const { validate } = await import('../src/middleware/validate.js');

    const app = express();
    app.use(express.json());

    const schema = {
      body: {
        type: 'object' as const,
        properties: {
          email: { type: 'string' as const },
        },
        required: ['email'],
        additionalProperties: false,
      },
    };

    app.post('/test', validate(schema), (_req, res) => {
      res.json({ ok: true });
    });

    const res = await request(app)
      .post('/test')
      .send({});

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Validation failed');
    expect(res.body.location).toBe('body');
    expect(res.body.details).toBeDefined();
    expect(Array.isArray(res.body.details)).toBe(true);
  });

  it('validate should check query parameters', async () => {
    const { validate } = await import('../src/middleware/validate.js');

    const app = express();

    const schema = {
      query: {
        type: 'object' as const,
        properties: {
          limit: { type: 'integer' as const, minimum: 1, maximum: 100 },
        },
        required: ['limit'],
        additionalProperties: false,
      },
    };

    app.get('/test', validate(schema), (_req, res) => {
      res.json({ ok: true });
    });

    // Valid
    let res = await request(app).get('/test').query({ limit: 50 });
    expect(res.status).toBe(200);

    // Invalid
    res = await request(app).get('/test').query({ limit: 200 });
    expect(res.status).toBe(400);
  });

  it('validate should check path parameters', async () => {
    const { validate } = await import('../src/middleware/validate.js');

    const app = express();

    const schema = {
      params: {
        type: 'object' as const,
        properties: {
          id: { type: 'string' as const, pattern: '^[0-9]+$' },
        },
        required: ['id'],
        additionalProperties: false,
      },
    };

    app.get('/test/:id', validate(schema), (_req, res) => {
      res.json({ ok: true });
    });

    // Valid
    let res = await request(app).get('/test/123');
    expect(res.status).toBe(200);

    // Invalid
    res = await request(app).get('/test/abc');
    expect(res.status).toBe(400);
  });

  it('validate should coerce types and remove extra fields', async () => {
    const { validate } = await import('../src/middleware/validate.js');

    const app = express();
    app.use(express.json());

    const schema = {
      body: {
        type: 'object' as const,
        properties: {
          count: { type: 'integer' as const },
        },
        additionalProperties: false,
      },
    };

    let receivedBody: any;
    app.post('/test', validate(schema), (req, res) => {
      receivedBody = req.body;
      res.json({ ok: true });
    });

    const res = await request(app)
      .post('/test')
      .send({ count: '42', extra: 'removed' });

    expect(res.status).toBe(200);
    expect(receivedBody.count).toBe(42); // Coerced to integer
    expect(receivedBody.extra).toBeUndefined(); // Removed
  });
});

// ============================================================================
// Integration tests
// ============================================================================

describe('Integration: All infrastructure modules together', () => {
  let app: Express;

  beforeEach(async () => {
    app = express();

    // Set up the full infrastructure stack using dynamic imports
    const loggerModule = await import('../src/logger.js');
    const healthModule = await import('../src/health.js');
    const validateModule = await import('../src/middleware/validate.js');

    app.use(loggerModule.requestLogger());
    app.use(express.json());

    app.get('/health/live', healthModule.handleLive);
    app.get('/health/ready', healthModule.handleReady);
    app.get('/health', healthModule.handleHealth);

    const schema = {
      body: {
        type: 'object' as const,
        properties: { data: { type: 'string' as const } },
        required: ['data'],
      },
    };

    app.post('/api/test', validateModule.validate(schema), (_req, res) => {
      res.json({ received: true });
    });
  });

  it('should handle request flow with all middleware', async () => {
    const res = await request(app)
      .post('/api/test')
      .send({ data: 'hello' });

    expect(res.status).toBe(200);
    expect(res.body.received).toBe(true);
    expect(res.header['x-request-id']).toBeDefined();
  });

  it('health endpoints should be accessible', async () => {
    const live = await request(app).get('/health/live');
    const ready = await request(app).get('/health/ready');
    const health = await request(app).get('/health');

    expect(live.status).toBe(200);
    expect([200, 503]).toContain(ready.status);
    expect([200, 503]).toContain(health.status);
  });

  it('invalid requests should be caught early', async () => {
    const res = await request(app)
      .post('/api/test')
      .send({ invalid: 'data' });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Validation failed');
  });
});
