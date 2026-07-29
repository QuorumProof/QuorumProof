/**
 * Tests for Issue #1312 — Request Validation Middleware
 *
 * Verifies:
 *   - JSON Schema validation of body / query / params
 *   - Detailed AJV error information in 400 responses
 *   - Custom validators for complex business-logic checks
 *   - Built-in validators (stellarAddressValidator, noDuplicatesValidator)
 *   - Backward-compatible plain-schema usage
 *   - Multiple locations validated in a single middleware call
 */

import { describe, it, expect } from 'vitest';
import express, { type Express } from 'express';
import request from 'supertest';
import {
  validate,
  stellarAddressValidator,
  noDuplicatesValidator,
  type CustomValidator,
} from '../src/middleware/validate.js';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function buildApp(): Express {
  const app = express();
  app.use(express.json());
  return app;
}

// ---------------------------------------------------------------------------
// Plain schema (backward-compatible API)
// ---------------------------------------------------------------------------

describe('validate — plain JSON Schema', () => {
  it('passes valid body', async () => {
    const app = buildApp();
    app.post(
      '/batch',
      validate({
        body: {
          type: 'object',
          properties: {
            credential_ids: { type: 'array', items: { type: 'integer' }, minItems: 1 },
            slice_id: { type: 'integer' },
          },
          required: ['credential_ids', 'slice_id'],
          additionalProperties: false,
        },
      }),
      (_req, res) => res.json({ ok: true }),
    );

    const res = await request(app)
      .post('/batch')
      .send({ credential_ids: [1, 2, 3], slice_id: 5 })
      .expect(200);

    expect(res.body.ok).toBe(true);
  });

  it('rejects invalid body with 400 and details array', async () => {
    const app = buildApp();
    app.post(
      '/batch',
      validate({
        body: {
          type: 'object',
          properties: {
            credential_ids: { type: 'array', items: { type: 'integer' }, minItems: 1 },
            slice_id: { type: 'integer' },
          },
          required: ['credential_ids', 'slice_id'],
          additionalProperties: false,
        },
      }),
      (_req, res) => res.json({ ok: true }),
    );

    const res = await request(app)
      .post('/batch')
      .send({ credential_ids: [] }) // missing slice_id, empty array
      .expect(400);

    expect(res.body.error).toBe('Validation failed');
    expect(res.body.location).toBe('body');
    expect(Array.isArray(res.body.details)).toBe(true);
    expect(res.body.details.length).toBeGreaterThan(0);
    // Each detail must have keyword and message
    for (const detail of res.body.details) {
      expect(typeof detail.keyword).toBe('string');
      expect(typeof detail.message).toBe('string');
    }
  });

  it('validates query params', async () => {
    const app = buildApp();
    app.get(
      '/search',
      validate({
        query: {
          type: 'object',
          properties: { limit: { type: 'integer', minimum: 1, maximum: 100 } },
          required: ['limit'],
          additionalProperties: false,
        },
      }),
      (req, res) => res.json({ limit: req.query.limit }),
    );

    // Valid
    await request(app).get('/search?limit=10').expect(200);

    // Missing required field
    const res = await request(app).get('/search').expect(400);
    expect(res.body.location).toBe('query');
  });

  it('validates route params', async () => {
    const app = buildApp();
    app.get(
      '/items/:id',
      validate({
        params: {
          type: 'object',
          properties: { id: { type: 'integer', minimum: 1 } },
          required: ['id'],
          additionalProperties: false,
        },
      }),
      (req, res) => res.json({ id: req.params.id }),
    );

    // AJV with coerceTypes will parse the string '42' to integer 42
    await request(app).get('/items/42').expect(200);
  });
});

// ---------------------------------------------------------------------------
// Custom validators
// ---------------------------------------------------------------------------

describe('validate — custom validators', () => {
  it('passes when custom validator returns true', async () => {
    const app = buildApp();
    const noop: CustomValidator = () => true;

    app.post(
      '/custom',
      validate({ body: { schema: { type: 'object', additionalProperties: true }, custom: noop } }),
      (_req, res) => res.json({ ok: true }),
    );

    await request(app).post('/custom').send({ foo: 'bar' }).expect(200);
  });

  it('rejects with 400 when custom validator returns a string message', async () => {
    const app = buildApp();
    const alwaysFail: CustomValidator = () => 'always fails';

    app.post(
      '/custom',
      validate({
        body: {
          schema: { type: 'object', additionalProperties: true },
          custom: alwaysFail,
        },
      }),
      (_req, res) => res.json({ ok: true }),
    );

    const res = await request(app).post('/custom').send({ foo: 'bar' }).expect(400);
    expect(res.body.error).toBe('Validation failed');
    expect(res.body.details[0].message).toBe('always fails');
    expect(res.body.details[0].keyword).toBe('custom');
  });

  it('returns multiple error messages when custom returns string[]', async () => {
    const app = buildApp();
    const multiError: CustomValidator = () => ['error one', 'error two'];

    app.post(
      '/custom',
      validate({ body: { schema: { type: 'object', additionalProperties: true }, custom: multiError } }),
      (_req, res) => res.json({ ok: true }),
    );

    const res = await request(app).post('/custom').send({}).expect(400);
    expect(res.body.details).toHaveLength(2);
    expect(res.body.details[0].message).toBe('error one');
    expect(res.body.details[1].message).toBe('error two');
  });

  it('skips custom validator when schema check fails', async () => {
    const app = buildApp();
    let customCalled = false;
    const shouldNotBeReached: CustomValidator = () => {
      customCalled = true;
      return true;
    };

    app.post(
      '/custom',
      validate({
        body: {
          schema: {
            type: 'object',
            properties: { n: { type: 'integer' } },
            required: ['n'],
            additionalProperties: false,
          },
          custom: shouldNotBeReached,
        },
      }),
      (_req, res) => res.json({ ok: true }),
    );

    // Missing required field — schema check fails before custom runs
    await request(app).post('/custom').send({}).expect(400);
    expect(customCalled).toBe(false);
  });

  it('runs custom validator without a schema', async () => {
    const app = buildApp();

    app.post(
      '/custom-only',
      validate({
        body: {
          custom: (data) => {
            const d = data as Record<string, unknown>;
            return d['magic'] === 42 ? true : 'magic must be 42';
          },
        },
      }),
      (_req, res) => res.json({ ok: true }),
    );

    await request(app).post('/custom-only').send({ magic: 42 }).expect(200);
    const res = await request(app).post('/custom-only').send({ magic: 0 }).expect(400);
    expect(res.body.details[0].message).toBe('magic must be 42');
  });
});

// ---------------------------------------------------------------------------
// Built-in validators
// ---------------------------------------------------------------------------

describe('stellarAddressValidator', () => {
  it('accepts a valid Stellar G-address', async () => {
    const app = buildApp();
    app.post(
      '/issue',
      validate({
        body: {
          schema: {
            type: 'object',
            properties: { address: { type: 'string' } },
            required: ['address'],
            additionalProperties: false,
          },
          custom: stellarAddressValidator('address'),
        },
      }),
      (_req, res) => res.json({ ok: true }),
    );

    const validAddress = 'G' + 'A'.repeat(55); // 56 chars, all uppercase
    await request(app).post('/issue').send({ address: validAddress }).expect(200);
  });

  it('rejects an invalid Stellar address', async () => {
    const app = buildApp();
    app.post(
      '/issue',
      validate({
        body: {
          schema: {
            type: 'object',
            properties: { address: { type: 'string' } },
            required: ['address'],
            additionalProperties: false,
          },
          custom: stellarAddressValidator('address'),
        },
      }),
      (_req, res) => res.json({ ok: true }),
    );

    const res = await request(app)
      .post('/issue')
      .send({ address: 'not-a-stellar-address' })
      .expect(400);

    expect(res.body.details[0].message).toContain('address');
  });
});

describe('noDuplicatesValidator', () => {
  it('passes when array has no duplicates', async () => {
    const app = buildApp();
    app.post(
      '/batch',
      validate({
        body: {
          schema: {
            type: 'object',
            properties: { ids: { type: 'array', items: { type: 'integer' } } },
            required: ['ids'],
            additionalProperties: false,
          },
          custom: noDuplicatesValidator('ids'),
        },
      }),
      (_req, res) => res.json({ ok: true }),
    );

    await request(app).post('/batch').send({ ids: [1, 2, 3] }).expect(200);
  });

  it('rejects array with duplicate values', async () => {
    const app = buildApp();
    app.post(
      '/batch',
      validate({
        body: {
          schema: {
            type: 'object',
            properties: { ids: { type: 'array', items: { type: 'integer' } } },
            required: ['ids'],
            additionalProperties: false,
          },
          custom: noDuplicatesValidator('ids'),
        },
      }),
      (_req, res) => res.json({ ok: true }),
    );

    const res = await request(app)
      .post('/batch')
      .send({ ids: [1, 2, 2, 3] })
      .expect(400);

    expect(res.body.details[0].message).toContain('duplicate');
  });
});

// ---------------------------------------------------------------------------
// Multiple locations
// ---------------------------------------------------------------------------

describe('validate — multiple locations', () => {
  it('validates body and params simultaneously', async () => {
    const app = buildApp();
    app.put(
      '/items/:id',
      validate({
        params: {
          type: 'object',
          properties: { id: { type: 'integer', minimum: 1 } },
          required: ['id'],
          additionalProperties: false,
        },
        body: {
          type: 'object',
          properties: { name: { type: 'string', minLength: 1 } },
          required: ['name'],
          additionalProperties: false,
        },
      }),
      (_req, res) => res.json({ ok: true }),
    );

    // Both valid
    await request(app).put('/items/5').send({ name: 'test' }).expect(200);

    // Body invalid (missing name)
    const res = await request(app).put('/items/5').send({}).expect(400);
    expect(res.body.location).toBe('body');
  });
});
