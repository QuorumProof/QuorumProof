/**
 * Tests for Issue #1427 — v2-only endpoints and response serializers.
 *
 * Tests are independent of the v1 suite and cover:
 *   - v2ResponseSerializer: envelope removal, cursor rename, field renames
 *   - /api/v2/proof-requests CRUD
 *   - /api/v2/revocation-registry CRUD
 *   - /api/v2/bbs-credentials CRUD + presentation
 *   - RFC 9457 error shapes on v2 routes
 */

import { describe, it, expect, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

import {
  unwrapEnvelope,
  renameCursor,
  applyV2CredentialRenames,
} from '../src/routes/v2/index.js';

// ─────────────────────────────────────────────────────────────────────────────
// Unit tests for v2 serializer helpers
// ─────────────────────────────────────────────────────────────────────────────

describe('unwrapEnvelope()', () => {
  it('strips the v1 { ok, version, data } envelope', () => {
    const input = { ok: true, version: 'v1', data: { id: 1 } };
    expect(unwrapEnvelope(input)).toEqual({ id: 1 });
  });

  it('passes through a raw object with no envelope', () => {
    const input = { id: 1, name: 'test' };
    expect(unwrapEnvelope(input)).toEqual(input);
  });

  it('passes through an array as-is', () => {
    const input = [{ id: 1 }, { id: 2 }];
    expect(unwrapEnvelope(input)).toEqual(input);
  });

  it('passes through null', () => {
    expect(unwrapEnvelope(null)).toBeNull();
  });
});

describe('renameCursor()', () => {
  it('renames next_cursor to cursor', () => {
    const result = renameCursor({ items: [], total: 0, next_cursor: 'abc123' });
    expect(result['cursor']).toBe('abc123');
    expect(result['next_cursor']).toBeUndefined();
  });

  it('does not rename cursor if already present', () => {
    const result = renameCursor({ items: [], cursor: 'existing', next_cursor: 'other' });
    expect(result['cursor']).toBe('existing');
  });

  it('is a no-op when next_cursor is absent', () => {
    const obj = { items: [], total: 0 };
    expect(renameCursor(obj)).toEqual(obj);
  });
});

describe('applyV2CredentialRenames()', () => {
  it('renames metadata → metadata_hash', () => {
    const result = applyV2CredentialRenames({ id: 1, metadata: 'abc' }) as Record<string, unknown>;
    expect(result['metadata_hash']).toBe('abc');
    expect(result['metadata']).toBeUndefined();
  });

  it('renames address → stellar_address', () => {
    const result = applyV2CredentialRenames({ id: 1, address: 'GABC' }) as Record<string, unknown>;
    expect(result['stellar_address']).toBe('GABC');
    expect(result['address']).toBeUndefined();
  });

  it('recursively renames fields in items array', () => {
    const result = applyV2CredentialRenames({
      items: [{ id: 1, metadata: 'x', address: 'G' }],
      next_cursor: 'tok',
    }) as Record<string, unknown>;
    const items = result['items'] as Record<string, unknown>[];
    expect(items[0]['metadata_hash']).toBe('x');
    expect(items[0]['stellar_address']).toBe('G');
    expect(result['cursor']).toBe('tok');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Integration tests — v2/proof-requests
// ─────────────────────────────────────────────────────────────────────────────

import proofRequestsRouter, { _proofRequestStore } from '../src/routes/v2/proofRequests.js';

const prApp = express();
prApp.use(express.json());
prApp.use('/api/v2/proof-requests', proofRequestsRouter);

describe('/api/v2/proof-requests', () => {
  beforeEach(() => {
    _proofRequestStore.clear();
  });

  it('POST creates a new proof-request and returns it without envelope', async () => {
    const res = await request(prApp).post('/api/v2/proof-requests').send({
      credential_id: 1,
      claim_type: 'degree',
      requester: 'GABC',
    });
    expect(res.status).toBe(201);
    expect(res.body.id).toBeDefined();
    expect(res.body.status).toBe('pending');
    // No envelope
    expect(res.body.ok).toBeUndefined();
    expect(res.body.data).toBeUndefined();
  });

  it('POST returns 400 Problem Details for missing fields', async () => {
    const res = await request(prApp).post('/api/v2/proof-requests').send({ credential_id: 1 });
    expect(res.status).toBe(400);
    expect(res.body.type).toMatch(/missing-parameter/);
    expect(res.body.status).toBe(400);
    expect(res.body.error).toBeTruthy();
  });

  it('GET returns paginated list with `cursor` (not `next_cursor`)', async () => {
    // Insert 3 items
    for (let i = 1; i <= 3; i++) {
      await request(prApp).post('/api/v2/proof-requests').send({
        credential_id: i,
        claim_type: 'degree',
        requester: 'GABC',
      });
    }
    const res = await request(prApp).get('/api/v2/proof-requests');
    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(3);
    expect(res.body).toHaveProperty('cursor');
    expect(res.body.next_cursor).toBeUndefined();
  });

  it('GET /:id returns the specific resource', async () => {
    const createRes = await request(prApp).post('/api/v2/proof-requests').send({
      credential_id: 42,
      claim_type: 'license',
      requester: 'GDEF',
    });
    const id = (createRes.body as { id: string }).id;
    const res = await request(prApp).get(`/api/v2/proof-requests/${id}`);
    expect(res.status).toBe(200);
    expect(res.body.credential_id).toBe(42);
  });

  it('GET /:id returns 404 Problem Details for unknown id', async () => {
    const res = await request(prApp).get('/api/v2/proof-requests/nope');
    expect(res.status).toBe(404);
    expect(res.body.type).toMatch(/not-found/);
  });

  it('DELETE cancels a pending request', async () => {
    const createRes = await request(prApp).post('/api/v2/proof-requests').send({
      credential_id: 5,
      claim_type: 'degree',
      requester: 'GABC',
    });
    const id = (createRes.body as { id: string }).id;
    const delRes = await request(prApp).delete(`/api/v2/proof-requests/${id}`);
    expect(delRes.status).toBe(200);
    expect(delRes.body.status).toBe('cancelled');
  });

  it('DELETE returns 409 Problem Details when request is not pending', async () => {
    const createRes = await request(prApp).post('/api/v2/proof-requests').send({
      credential_id: 6,
      claim_type: 'degree',
      requester: 'GABC',
    });
    const id = (createRes.body as { id: string }).id;
    // Cancel once
    await request(prApp).delete(`/api/v2/proof-requests/${id}`);
    // Try again
    const res = await request(prApp).delete(`/api/v2/proof-requests/${id}`);
    expect(res.status).toBe(409);
    expect(res.body.type).toMatch(/invalid-state/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Integration tests — v2/revocation-registry
// ─────────────────────────────────────────────────────────────────────────────

import revocationRegistryRouter, { _revocationRegistry } from '../src/routes/v2/revocationRegistry.js';

const rrApp = express();
rrApp.use(express.json());
rrApp.use('/api/v2/revocation-registry', revocationRegistryRouter);

describe('/api/v2/revocation-registry', () => {
  beforeEach(() => {
    _revocationRegistry.clear();
  });

  it('POST adds entries and returns summary', async () => {
    const res = await request(rrApp)
      .post('/api/v2/revocation-registry')
      .send({ entries: [{ credential_id: 1, revoked_by: 'GABC', reason: 'fraud' }] });
    expect(res.status).toBe(201);
    expect(res.body.added).toHaveLength(1);
    expect(res.body.skipped).toHaveLength(0);
  });

  it('GET /:credentialId shows revoked: true', async () => {
    await request(rrApp)
      .post('/api/v2/revocation-registry')
      .send({ entries: [{ credential_id: 10, revoked_by: 'GABC' }] });
    const res = await request(rrApp).get('/api/v2/revocation-registry/10');
    expect(res.status).toBe(200);
    expect(res.body.revoked).toBe(true);
  });

  it('GET /:credentialId shows revoked: false for unknown credential', async () => {
    const res = await request(rrApp).get('/api/v2/revocation-registry/999');
    expect(res.status).toBe(200);
    expect(res.body.revoked).toBe(false);
  });

  it('GET list returns cursor (not next_cursor)', async () => {
    await request(rrApp)
      .post('/api/v2/revocation-registry')
      .send({ entries: [{ credential_id: 1, revoked_by: 'GABC' }] });
    const res = await request(rrApp).get('/api/v2/revocation-registry');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('cursor');
    expect(res.body.next_cursor).toBeUndefined();
  });

  it('POST returns 400 Problem Details when entries is missing', async () => {
    const res = await request(rrApp).post('/api/v2/revocation-registry').send({});
    expect(res.status).toBe(400);
    expect(res.body.type).toMatch(/missing-parameter/);
  });

  it('DELETE removes entry and returns revoked: false', async () => {
    await request(rrApp)
      .post('/api/v2/revocation-registry')
      .send({ entries: [{ credential_id: 5, revoked_by: 'GABC' }] });
    const delRes = await request(rrApp).delete('/api/v2/revocation-registry/5');
    expect(delRes.status).toBe(200);
    expect(delRes.body.revoked).toBe(false);
  });

  it('DELETE returns 409 when time-lock is active', async () => {
    const futureDate = new Date(Date.now() + 86400_000).toISOString();
    await request(rrApp).post('/api/v2/revocation-registry').send({
      entries: [{ credential_id: 7, revoked_by: 'GABC', locked_until: futureDate }],
    });
    const res = await request(rrApp).delete('/api/v2/revocation-registry/7');
    expect(res.status).toBe(409);
    expect(res.body.type).toMatch(/time-lock-active/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Integration tests — v2/bbs-credentials
// ─────────────────────────────────────────────────────────────────────────────

import bbsCredentialsRouter, { _bbsStore } from '../src/routes/v2/bbsCredentials.js';

const bbsApp = express();
bbsApp.use(express.json());
bbsApp.use('/api/v2/bbs-credentials', bbsCredentialsRouter);

describe('/api/v2/bbs-credentials', () => {
  beforeEach(() => {
    _bbsStore.clear();
  });

  it('POST issues a BBS+ credential with v2 field names', async () => {
    const res = await request(bbsApp).post('/api/v2/bbs-credentials').send({
      stellar_address: 'GABC',
      claim_type: 'degree',
      metadata_hash: 'sha256:abc',
      issuer_key: 'bbs-key-001',
    });
    expect(res.status).toBe(201);
    expect(res.body.stellar_address).toBe('GABC');   // v2 field name
    expect(res.body.metadata_hash).toBe('sha256:abc'); // v2 field name
    expect(res.body.address).toBeUndefined();          // old field absent
    expect(res.body.metadata).toBeUndefined();          // old field absent
    expect(res.body.ok).toBeUndefined();               // no envelope
  });

  it('POST returns 400 Problem Details for missing stellar_address', async () => {
    const res = await request(bbsApp).post('/api/v2/bbs-credentials').send({
      claim_type: 'degree',
      metadata_hash: 'sha256:abc',
      issuer_key: 'key',
    });
    expect(res.status).toBe(400);
    expect(res.body.type).toMatch(/missing-parameter/);
  });

  it('GET list returns cursor (not next_cursor)', async () => {
    await request(bbsApp).post('/api/v2/bbs-credentials').send({
      stellar_address: 'GABC',
      claim_type: 'degree',
      metadata_hash: 'h1',
      issuer_key: 'k',
    });
    const res = await request(bbsApp).get('/api/v2/bbs-credentials');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('cursor');
    expect(res.body.next_cursor).toBeUndefined();
  });

  it('GET /:id returns the credential', async () => {
    const createRes = await request(bbsApp).post('/api/v2/bbs-credentials').send({
      stellar_address: 'GXYZ',
      claim_type: 'license',
      metadata_hash: 'h2',
      issuer_key: 'k',
    });
    const id = (createRes.body as { id: string }).id;
    const res = await request(bbsApp).get(`/api/v2/bbs-credentials/${id}`);
    expect(res.status).toBe(200);
    expect(res.body.claim_type).toBe('license');
  });

  it('POST /:id/present returns a presentation', async () => {
    const createRes = await request(bbsApp).post('/api/v2/bbs-credentials').send({
      stellar_address: 'GABC',
      claim_type: 'degree',
      metadata_hash: 'h3',
      issuer_key: 'k',
    });
    const id = (createRes.body as { id: string }).id;
    const res = await request(bbsApp)
      .post(`/api/v2/bbs-credentials/${id}/present`)
      .send({ disclosed_attributes: ['claim_type'] });
    expect(res.status).toBe(201);
    expect(res.body.presentation_proof).toBeDefined();
    expect(res.body.disclosed_attributes).toEqual(['claim_type']);
  });

  it('POST /:id/present returns 400 when disclosed_attributes is empty', async () => {
    const createRes = await request(bbsApp).post('/api/v2/bbs-credentials').send({
      stellar_address: 'GABC',
      claim_type: 'degree',
      metadata_hash: 'h4',
      issuer_key: 'k',
    });
    const id = (createRes.body as { id: string }).id;
    const res = await request(bbsApp)
      .post(`/api/v2/bbs-credentials/${id}/present`)
      .send({ disclosed_attributes: [] });
    expect(res.status).toBe(400);
    expect(res.body.type).toMatch(/missing-parameter/);
  });
});
