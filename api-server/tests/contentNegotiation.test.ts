/**
 * Tests for Issue #1315 — Content Negotiation (CSV / XML / JSON)
 *
 * Covers:
 *   - negotiateType() utility
 *   - toCSV() serialiser
 *   - toXML() serialiser
 *   - respondNegotiated() integration via a minimal Express app
 *   - GET /api/attestors with Accept: application/json (default)
 *   - GET /api/attestors with Accept: text/csv
 *   - GET /api/attestors with Accept: application/xml
 *   - GET /api/slices   with Accept: text/csv  (pagination wrapper)
 */

import { describe, it, expect } from 'vitest';
import express from 'express';
import request from 'supertest';

import {
  negotiateType,
  toCSV,
  toXML,
  respondNegotiated,
} from '../src/middleware/contentNegotiation.js';
import { createAttestorsRouter } from '../src/routes/attestors.js';
import { createSlicesRouter } from '../src/routes/slices.js';

// ── negotiateType ──────────────────────────────────────────────────────────

describe('negotiateType()', () => {
  it('defaults to json when Accept header is absent', () => {
    expect(negotiateType(undefined)).toBe('json');
  });

  it('defaults to json when Accept header is empty', () => {
    expect(negotiateType('')).toBe('json');
  });

  it('returns json for application/json', () => {
    expect(negotiateType('application/json')).toBe('json');
  });

  it('returns json for */*', () => {
    expect(negotiateType('*/*')).toBe('json');
  });

  it('returns csv for text/csv', () => {
    expect(negotiateType('text/csv')).toBe('csv');
  });

  it('returns csv for application/csv', () => {
    expect(negotiateType('application/csv')).toBe('csv');
  });

  it('returns xml for application/xml', () => {
    expect(negotiateType('application/xml')).toBe('xml');
  });

  it('returns xml for text/xml', () => {
    expect(negotiateType('text/xml')).toBe('xml');
  });

  it('respects q-factor: prefers higher q value', () => {
    // json q=0.5, csv q=0.9 → should pick csv
    expect(negotiateType('application/json;q=0.5, text/csv;q=0.9')).toBe('csv');
  });

  it('respects q-factor: json beats csv when json q is higher', () => {
    expect(negotiateType('text/csv;q=0.4, application/json;q=0.9')).toBe('json');
  });

  it('falls back to json for unrecognised type', () => {
    expect(negotiateType('application/msgpack')).toBe('json');
  });
});

// ── toCSV ──────────────────────────────────────────────────────────────────

describe('toCSV()', () => {
  it('serialises an array of objects to CSV with header row', () => {
    const result = toCSV([
      { id: 1, name: 'Alice' },
      { id: 2, name: 'Bob' },
    ]);
    const lines = result.split('\r\n');
    expect(lines[0]).toBe('id,name');
    expect(lines[1]).toBe('1,Alice');
    expect(lines[2]).toBe('2,Bob');
  });

  it('returns empty string for an empty array', () => {
    expect(toCSV([])).toBe('');
  });

  it('wraps a plain object in a single data row', () => {
    const result = toCSV({ id: 42, type: 'test' });
    const lines = result.split('\r\n');
    expect(lines[0]).toBe('id,type');
    expect(lines[1]).toBe('42,test');
  });

  it('escapes values that contain commas', () => {
    const result = toCSV([{ name: 'Doe, Jane' }]);
    expect(result).toContain('"Doe, Jane"');
  });

  it('escapes values that contain double-quotes', () => {
    const result = toCSV([{ name: 'Say "Hello"' }]);
    expect(result).toContain('"Say ""Hello"""');
  });

  it('serialises nested objects as JSON strings in CSV cells', () => {
    const result = toCSV([{ meta: { a: 1 } }]);
    // The nested object is JSON-stringified then CSV-escaped (inner quotes doubled)
    // Full cell value: "{""a"":1}" — verify key parts are present
    expect(result).toContain('meta'); // header
    expect(result).toContain('""a""'); // escaped JSON key inside CSV cell
  });

  it('handles null and undefined values as empty strings', () => {
    const result = toCSV([{ a: null, b: undefined }]);
    const lines = result.split('\r\n');
    expect(lines[1]).toBe(',');
  });
});

// ── toXML ──────────────────────────────────────────────────────────────────

describe('toXML()', () => {
  it('produces a well-formed XML declaration', () => {
    const xml = toXML({}, 'root');
    expect(xml).toMatch(/^<\?xml version="1\.0" encoding="UTF-8"\?>/);
  });

  it('wraps an object in the root element', () => {
    const xml = toXML({ id: 1 }, 'credential');
    expect(xml).toContain('<credential>');
    expect(xml).toContain('</credential>');
    expect(xml).toContain('<id>1</id>');
  });

  it('wraps each array item in itemElement', () => {
    const xml = toXML([{ id: 1 }, { id: 2 }], 'attestors', 'attestor');
    expect(xml).toContain('<attestors>');
    // Two attestor elements
    const matches = xml.match(/<attestor>/g);
    expect(matches).toHaveLength(2);
  });

  it('escapes XML special characters', () => {
    const xml = toXML({ name: '<B&W>' }, 'root');
    expect(xml).toContain('&lt;B&amp;W&gt;');
  });

  it('serialises nested objects recursively', () => {
    const xml = toXML({ meta: { key: 'val' } }, 'root');
    expect(xml).toContain('<meta>');
    expect(xml).toContain('<key>val</key>');
  });

  it('uses default root element name "response"', () => {
    const xml = toXML({ ok: true });
    expect(xml).toContain('<response>');
  });
});

// ── respondNegotiated via test app ────────────────────────────────────────

function makeNegotiationTestApp() {
  const app = express();
  app.get('/test', (req, res) => {
    respondNegotiated(req, res, [{ id: 1, name: 'alice' }, { id: 2, name: 'bob' }], {
      rootElement: 'items',
      itemElement: 'item',
    });
  });
  app.get('/single', (req, res) => {
    respondNegotiated(req, res, { id: 42, status: 'ok' });
  });
  return app;
}

describe('respondNegotiated()', () => {
  const app = makeNegotiationTestApp();

  it('returns JSON by default (no Accept header)', async () => {
    const res = await request(app).get('/test');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/application\/json/);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body[0].id).toBe(1);
  });

  it('returns JSON when Accept: application/json', async () => {
    const res = await request(app).get('/test').set('Accept', 'application/json');
    expect(res.headers['content-type']).toMatch(/application\/json/);
    expect(Array.isArray(res.body)).toBe(true);
  });

  it('returns CSV when Accept: text/csv', async () => {
    const res = await request(app).get('/test').set('Accept', 'text/csv');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/csv/);
    const text = res.text;
    expect(text).toContain('id,name');
    expect(text).toContain('1,alice');
    expect(text).toContain('2,bob');
  });

  it('returns XML when Accept: application/xml', async () => {
    const res = await request(app).get('/test').set('Accept', 'application/xml');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/application\/xml/);
    expect(res.text).toContain('<?xml');
    expect(res.text).toContain('<items>');
    expect(res.text).toContain('<item>');
  });

  it('returns XML when Accept: text/xml', async () => {
    const res = await request(app).get('/test').set('Accept', 'text/xml');
    expect(res.headers['content-type']).toMatch(/application\/xml/);
  });

  it('returns CSV for a single object', async () => {
    const res = await request(app).get('/single').set('Accept', 'text/csv');
    expect(res.text).toContain('id,status');
    expect(res.text).toContain('42,ok');
  });
});

// ── GET /api/attestors content negotiation ────────────────────────────────

const attestorApp = express();
attestorApp.use(express.json());
attestorApp.use('/api/attestors', createAttestorsRouter());

describe('GET /api/attestors — content negotiation', () => {
  it('returns JSON by default', async () => {
    const res = await request(attestorApp).get('/api/attestors');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/application\/json/);
    expect(res.body.attestors).toBeDefined();
  });

  it('returns CSV with Accept: text/csv', async () => {
    const res = await request(attestorApp)
      .get('/api/attestors')
      .set('Accept', 'text/csv');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/csv/);
    // Header row should include attestor fields
    expect(res.text).toMatch(/total,attestors/);
  });

  it('returns XML with Accept: application/xml', async () => {
    const res = await request(attestorApp)
      .get('/api/attestors')
      .set('Accept', 'application/xml');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/application\/xml/);
    expect(res.text).toContain('<?xml');
    expect(res.text).toContain('<attestors>');
  });

  it('still filters by type when format is CSV', async () => {
    const res = await request(attestorApp)
      .get('/api/attestors?type=university')
      .set('Accept', 'text/csv');
    expect(res.status).toBe(200);
    // CSV rows will contain the word "university" (the type field value)
    expect(res.text).toMatch(/university/);
  });
});

// ── GET /api/slices content negotiation ───────────────────────────────────

function makeSliceApp() {
  const mockSoroban = {
    simulateCall: async (method: string, _args: unknown[]) => {
      if (method === 'get_slice_count') return BigInt(2);
      if (method === 'get_slice') return { id: 1, threshold: 2, attestors: [] };
      throw new Error('unknown method');
    },
    u64Val: (n: number | bigint) => n,
  };

  const app = express();
  app.use(express.json());
  app.use('/api/slices', createSlicesRouter(mockSoroban));
  return app;
}

describe('GET /api/slices — content negotiation', () => {
  const app = makeSliceApp();

  it('returns JSON by default', async () => {
    const res = await request(app).get('/api/slices');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/application\/json/);
    expect(res.body.data).toBeDefined();
  });

  it('returns CSV with Accept: text/csv', async () => {
    const res = await request(app).get('/api/slices').set('Accept', 'text/csv');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/csv/);
    // Should have at least a header row
    expect(res.text.length).toBeGreaterThan(0);
  });

  it('returns XML with Accept: application/xml', async () => {
    const res = await request(app).get('/api/slices').set('Accept', 'application/xml');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/application\/xml/);
    expect(res.text).toContain('<?xml');
  });
});
