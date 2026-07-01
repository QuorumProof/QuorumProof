/**
 * Tests for Issue #996 — Attestor Discovery API
 *
 * Covers:
 *   - GET /api/attestors  (list all, filter by type, region, active, free-text)
 *   - GET /api/attestors/:id (fetch single, 404 for unknown id)
 */

import { describe, it, expect } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createAttestorsRouter } from '../src/routes/attestors.js';

// Build a minimal Express app that mounts only the attestors router.
const app = express();
app.use(express.json());
app.use('/api/attestors', createAttestorsRouter());

// ---------------------------------------------------------------------------
// GET /api/attestors — list
// ---------------------------------------------------------------------------

describe('GET /api/attestors', () => {
  it('returns 200 with all attestors', async () => {
    const res = await request(app).get('/api/attestors');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.attestors)).toBe(true);
    expect(typeof res.body.total).toBe('number');
    expect(res.body.total).toBe(res.body.attestors.length);
    expect(res.body.total).toBeGreaterThan(0);
  });

  it('each attestor has required fields', async () => {
    const res = await request(app).get('/api/attestors');
    for (const a of res.body.attestors) {
      expect(a).toHaveProperty('id');
      expect(a).toHaveProperty('name');
      expect(a).toHaveProperty('type');
      expect(a).toHaveProperty('region');
      expect(a).toHaveProperty('description');
      expect(a).toHaveProperty('stellar_address');
      expect(a).toHaveProperty('credentials_issued');
      expect(a).toHaveProperty('active');
    }
  });
});

// ---------------------------------------------------------------------------
// Filter by type
// ---------------------------------------------------------------------------

describe('GET /api/attestors?type=...', () => {
  it('returns only university attestors', async () => {
    const res = await request(app).get('/api/attestors?type=university');
    expect(res.status).toBe(200);
    expect(res.body.attestors.length).toBeGreaterThan(0);
    for (const a of res.body.attestors) {
      expect(a.type).toBe('university');
    }
  });

  it('returns only licensing_body attestors', async () => {
    const res = await request(app).get('/api/attestors?type=licensing_body');
    expect(res.status).toBe(200);
    expect(res.body.attestors.length).toBeGreaterThan(0);
    for (const a of res.body.attestors) {
      expect(a.type).toBe('licensing_body');
    }
  });

  it('returns only employer attestors', async () => {
    const res = await request(app).get('/api/attestors?type=employer');
    expect(res.status).toBe(200);
    expect(res.body.attestors.length).toBeGreaterThan(0);
    for (const a of res.body.attestors) {
      expect(a.type).toBe('employer');
    }
  });

  it('returns empty array for unknown type', async () => {
    const res = await request(app).get('/api/attestors?type=unknown_type_xyz');
    expect(res.status).toBe(200);
    expect(res.body.attestors).toHaveLength(0);
    expect(res.body.total).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Filter by region
// ---------------------------------------------------------------------------

describe('GET /api/attestors?region=...', () => {
  it('returns only Brazilian attestors', async () => {
    const res = await request(app).get('/api/attestors?region=BR');
    expect(res.status).toBe(200);
    expect(res.body.attestors.length).toBeGreaterThan(0);
    for (const a of res.body.attestors) {
      expect(a.region.toUpperCase()).toBe('BR');
    }
  });

  it('returns only German attestors', async () => {
    const res = await request(app).get('/api/attestors?region=DE');
    expect(res.status).toBe(200);
    expect(res.body.attestors.length).toBeGreaterThan(0);
    for (const a of res.body.attestors) {
      expect(a.region.toUpperCase()).toBe('DE');
    }
  });

  it('region filter is case-insensitive', async () => {
    const resCaps = await request(app).get('/api/attestors?region=US');
    const resLower = await request(app).get('/api/attestors?region=us');
    expect(resCaps.body.total).toBe(resLower.body.total);
  });

  it('returns empty for unknown region', async () => {
    const res = await request(app).get('/api/attestors?region=ZZ');
    expect(res.status).toBe(200);
    expect(res.body.attestors).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Filter by active status
// ---------------------------------------------------------------------------

describe('GET /api/attestors?active=...', () => {
  it('returns only active attestors when active=true', async () => {
    const res = await request(app).get('/api/attestors?active=true');
    expect(res.status).toBe(200);
    expect(res.body.attestors.length).toBeGreaterThan(0);
    for (const a of res.body.attestors) {
      expect(a.active).toBe(true);
    }
  });

  it('returns only inactive attestors when active=false', async () => {
    const res = await request(app).get('/api/attestors?active=false');
    expect(res.status).toBe(200);
    // At least one inactive attestor exists in seed data (SpaceX)
    expect(res.body.attestors.length).toBeGreaterThan(0);
    for (const a of res.body.attestors) {
      expect(a.active).toBe(false);
    }
  });

  it('active + type combined filter works', async () => {
    const res = await request(app).get('/api/attestors?active=true&type=university');
    expect(res.status).toBe(200);
    for (const a of res.body.attestors) {
      expect(a.active).toBe(true);
      expect(a.type).toBe('university');
    }
  });
});

// ---------------------------------------------------------------------------
// Free-text search (q)
// ---------------------------------------------------------------------------

describe('GET /api/attestors?q=...', () => {
  it('matches on name substring (case-insensitive)', async () => {
    const res = await request(app).get('/api/attestors?q=munich');
    expect(res.status).toBe(200);
    expect(res.body.attestors.length).toBeGreaterThan(0);
    const names: string[] = res.body.attestors.map((a: { name: string }) => a.name.toLowerCase());
    expect(names.some((n) => n.includes('munich'))).toBe(true);
  });

  it('matches on region substring', async () => {
    const res = await request(app).get('/api/attestors?q=br');
    expect(res.status).toBe(200);
    // Should return at least the BR-region attestors
    expect(res.body.attestors.length).toBeGreaterThan(0);
  });

  it('returns empty array when query has no matches', async () => {
    const res = await request(app).get('/api/attestors?q=zzz_no_match_xyz');
    expect(res.status).toBe(200);
    expect(res.body.attestors).toHaveLength(0);
  });

  it('type + q combined filter narrows results', async () => {
    const res = await request(app).get('/api/attestors?type=university&q=paulo');
    expect(res.status).toBe(200);
    expect(res.body.attestors.length).toBeGreaterThan(0);
    for (const a of res.body.attestors) {
      expect(a.type).toBe('university');
      expect(a.name.toLowerCase()).toContain('paulo');
    }
  });
});

// ---------------------------------------------------------------------------
// GET /api/attestors/:id — single attestor
// ---------------------------------------------------------------------------

describe('GET /api/attestors/:id', () => {
  it('returns a known attestor by id', async () => {
    const res = await request(app).get('/api/attestors/att_mit');
    expect(res.status).toBe(200);
    expect(res.body.id).toBe('att_mit');
    expect(res.body.type).toBe('university');
    expect(res.body.region).toBe('US');
  });

  it('includes credentials_issued count', async () => {
    const res = await request(app).get('/api/attestors/att_crea_br');
    expect(res.status).toBe(200);
    expect(typeof res.body.credentials_issued).toBe('number');
    expect(res.body.credentials_issued).toBeGreaterThan(0);
  });

  it('returns 404 for unknown id', async () => {
    const res = await request(app).get('/api/attestors/att_does_not_exist');
    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/not found/i);
  });

  it('returns the correct attestor for a licensing body', async () => {
    const res = await request(app).get('/api/attestors/att_ieee');
    expect(res.status).toBe(200);
    expect(res.body.type).toBe('licensing_body');
    expect(res.body.active).toBe(true);
  });

  it('returns the correct attestor for an employer', async () => {
    const res = await request(app).get('/api/attestors/att_bosch');
    expect(res.status).toBe(200);
    expect(res.body.type).toBe('employer');
    expect(res.body.region).toBe('DE');
  });
});
