import { describe, it, expect, beforeEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import express from 'express';
import request from 'supertest';
import apiKeysRouter from '../src/routes/apiKeys.js';
import { ApiKeyManager, _setDefaultApiKeyManagerForTest } from '../src/services/apiKeyManager.js';

const app = express();
app.use(express.json());
app.use('/api/api-keys', apiKeysRouter);

/** Set up a fresh API key manager for testing. */
function freshManager() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'api-keys-test-'));
  const manager = new ApiKeyManager({ dataDir });
  _setDefaultApiKeyManagerForTest(manager);
  return { dataDir, manager };
}

const testIssuer = 'test-issuer-001';
const authHeader = { 'x-issuer': testIssuer };

beforeEach(() => {
  vi.restoreAllMocks();
  freshManager();
});

// ── Key Generation ──────────────────────────────────────────────────────────

describe('POST /api/api-keys', () => {
  it('generates a new API key and returns 201', async () => {
    const res = await request(app)
      .post('/api/api-keys')
      .set(authHeader)
      .send({ name: 'My Key' });

    expect(res.status).toBe(201);
    expect(res.body.id).toMatch(/^key_/);
    expect(res.body.key).toMatch(/^qp_[a-f0-9]+$/);
    expect(res.body.name).toBe('My Key');
    expect(res.body.createdAt).toBeDefined();
    expect(res.body.warning).toContain('Store this key securely');
  });

  it('returns 400 when name is missing', async () => {
    const res = await request(app)
      .post('/api/api-keys')
      .set(authHeader)
      .send({});

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('name is required');
  });

  it('returns 400 when name is empty', async () => {
    const res = await request(app)
      .post('/api/api-keys')
      .set(authHeader)
      .send({ name: '' });

    expect(res.status).toBe(400);
  });

  it('returns 401 when issuer is missing', async () => {
    const res = await request(app)
      .post('/api/api-keys')
      .send({ name: 'My Key' });

    expect(res.status).toBe(401);
  });

  it('generates unique keys for multiple requests', async () => {
    const res1 = await request(app)
      .post('/api/api-keys')
      .set(authHeader)
      .send({ name: 'Key 1' });

    const res2 = await request(app)
      .post('/api/api-keys')
      .set(authHeader)
      .send({ name: 'Key 2' });

    expect(res1.body.id).not.toBe(res2.body.id);
    expect(res1.body.key).not.toBe(res2.body.key);
  });
});

// ── Listing Keys ────────────────────────────────────────────────────────────

describe('GET /api/api-keys', () => {
  it('returns empty list initially', async () => {
    const res = await request(app)
      .get('/api/api-keys')
      .set(authHeader);

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([]);
  });

  it('lists generated keys', async () => {
    await request(app)
      .post('/api/api-keys')
      .set(authHeader)
      .send({ name: 'Key 1' });

    await request(app)
      .post('/api/api-keys')
      .set(authHeader)
      .send({ name: 'Key 2' });

    const res = await request(app)
      .get('/api/api-keys')
      .set(authHeader);

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(2);
    expect(res.body.data[0].name).toBe('Key 1');
    expect(res.body.data[1].name).toBe('Key 2');
  });

  it('does not include the key hash in the response', async () => {
    await request(app)
      .post('/api/api-keys')
      .set(authHeader)
      .send({ name: 'Test Key' });

    const res = await request(app)
      .get('/api/api-keys')
      .set(authHeader);

    expect(res.body.data[0]).not.toHaveProperty('keyHash');
    expect(res.body.data[0]).not.toHaveProperty('key');
  });

  it('includes createdAt and lastUsedAt timestamps', async () => {
    const res = await request(app)
      .post('/api/api-keys')
      .set(authHeader)
      .send({ name: 'Test Key' });

    const keyId = res.body.id;

    const listRes = await request(app)
      .get('/api/api-keys')
      .set(authHeader);

    const key = listRes.body.data[0];
    expect(key.createdAt).toBeDefined();
    expect(key.lastUsedAt).toBeUndefined(); // Not used yet
  });

  it('returns 401 without authorization', async () => {
    const res = await request(app).get('/api/api-keys');
    expect(res.status).toBe(401);
  });

  it('filters keys by issuer', async () => {
    // Create key for issuer 1
    await request(app)
      .post('/api/api-keys')
      .set({ 'x-issuer': 'issuer-1' })
      .send({ name: 'Key for issuer 1' });

    // Create key for issuer 2
    await request(app)
      .post('/api/api-keys')
      .set({ 'x-issuer': 'issuer-2' })
      .send({ name: 'Key for issuer 2' });

    // List for issuer 1
    const res1 = await request(app)
      .get('/api/api-keys')
      .set({ 'x-issuer': 'issuer-1' });

    expect(res1.body.data).toHaveLength(1);
    expect(res1.body.data[0].name).toBe('Key for issuer 1');

    // List for issuer 2
    const res2 = await request(app)
      .get('/api/api-keys')
      .set({ 'x-issuer': 'issuer-2' });

    expect(res2.body.data).toHaveLength(1);
    expect(res2.body.data[0].name).toBe('Key for issuer 2');
  });

  it('does not include revoked keys', async () => {
    const createRes = await request(app)
      .post('/api/api-keys')
      .set(authHeader)
      .send({ name: 'To be revoked' });

    const keyId = createRes.body.id;

    // Revoke the key
    await request(app)
      .delete(`/api/api-keys/${keyId}`)
      .set(authHeader);

    // List should be empty
    const listRes = await request(app)
      .get('/api/api-keys')
      .set(authHeader);

    expect(listRes.body.data).toHaveLength(0);
  });
});

// ── Get Single Key ──────────────────────────────────────────────────────────

describe('GET /api/api-keys/:id', () => {
  it('returns a specific API key', async () => {
    const createRes = await request(app)
      .post('/api/api-keys')
      .set(authHeader)
      .send({ name: 'Test Key' });

    const keyId = createRes.body.id;

    const res = await request(app)
      .get(`/api/api-keys/${keyId}`)
      .set(authHeader);

    expect(res.status).toBe(200);
    expect(res.body.id).toBe(keyId);
    expect(res.body.name).toBe('Test Key');
    expect(res.body.createdAt).toBeDefined();
  });

  it('returns 404 for unknown key', async () => {
    const res = await request(app)
      .get('/api/api-keys/key_nonexistent')
      .set(authHeader);

    expect(res.status).toBe(404);
  });

  it('returns 404 for key belonging to another issuer', async () => {
    const createRes = await request(app)
      .post('/api/api-keys')
      .set({ 'x-issuer': 'issuer-1' })
      .send({ name: 'Other issuer key' });

    const keyId = createRes.body.id;

    const res = await request(app)
      .get(`/api/api-keys/${keyId}`)
      .set({ 'x-issuer': 'issuer-2' });

    expect(res.status).toBe(404);
  });
});

// ── Key Revocation ──────────────────────────────────────────────────────────

describe('DELETE /api/api-keys/:id', () => {
  it('revokes a key and returns 204', async () => {
    const createRes = await request(app)
      .post('/api/api-keys')
      .set(authHeader)
      .send({ name: 'To revoke' });

    const keyId = createRes.body.id;

    const res = await request(app)
      .delete(`/api/api-keys/${keyId}`)
      .set(authHeader);

    expect(res.status).toBe(204);

    // Verify it's gone from the list
    const listRes = await request(app)
      .get('/api/api-keys')
      .set(authHeader);

    expect(listRes.body.data).toHaveLength(0);
  });

  it('returns 404 when revoking unknown key', async () => {
    const res = await request(app)
      .delete('/api/api-keys/key_nonexistent')
      .set(authHeader);

    expect(res.status).toBe(404);
  });

  it('returns 404 when revoking key of another issuer', async () => {
    const createRes = await request(app)
      .post('/api/api-keys')
      .set({ 'x-issuer': 'issuer-1' })
      .send({ name: 'Other issuer key' });

    const keyId = createRes.body.id;

    const res = await request(app)
      .delete(`/api/api-keys/${keyId}`)
      .set({ 'x-issuer': 'issuer-2' });

    expect(res.status).toBe(404);
  });
});

// ── Usage Tracking ──────────────────────────────────────────────────────────

describe('GET /api/api-keys/:id/usage', () => {
  it('returns usage history for a key', async () => {
    const { manager } = freshManager();
    
    const createRes = await request(app)
      .post('/api/api-keys')
      .set(authHeader)
      .send({ name: 'Test Key' });

    const keyId = createRes.body.id;

    // Directly record usage using the same manager instance (in real usage, this happens via middleware)
    manager.recordUsage(keyId, '/api/credentials');
    manager.recordUsage(keyId, '/api/slices');

    const res = await request(app)
      .get(`/api/api-keys/${keyId}/usage`)
      .set(authHeader);

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(2);
    expect(res.body.data[0].endpoint).toBeDefined();
  });

  it('returns 404 for unknown key', async () => {
    const res = await request(app)
      .get('/api/api-keys/key_nonexistent/usage')
      .set(authHeader);

    expect(res.status).toBe(404);
  });

  it('respects the limit parameter', async () => {
    const { manager } = freshManager();
    
    const createRes = await request(app)
      .post('/api/api-keys')
      .set(authHeader)
      .send({ name: 'Test Key' });

    const keyId = createRes.body.id;

    for (let i = 0; i < 10; i++) {
      manager.recordUsage(keyId, `/endpoint/${i}`);
    }

    const res = await request(app)
      .get(`/api/api-keys/${keyId}/usage?limit=5`)
      .set(authHeader);

    expect(res.body.data).toHaveLength(5);
  });
});

// ── Key Statistics ──────────────────────────────────────────────────────────

describe('GET /api/api-keys/stats/overview', () => {
  it('returns key statistics for an issuer', async () => {
    // Create 3 keys
    const key1 = await request(app)
      .post('/api/api-keys')
      .set(authHeader)
      .send({ name: 'Key 1' });

    const key2 = await request(app)
      .post('/api/api-keys')
      .set(authHeader)
      .send({ name: 'Key 2' });

    const key3 = await request(app)
      .post('/api/api-keys')
      .set(authHeader)
      .send({ name: 'Key 3' });

    // Revoke one
    await request(app)
      .delete(`/api/api-keys/${key1.body.id}`)
      .set(authHeader);

    const res = await request(app)
      .get('/api/api-keys/stats/overview')
      .set(authHeader);

    expect(res.status).toBe(200);
    expect(res.body.totalKeys).toBe(3);
    expect(res.body.activeKeys).toBe(2);
    expect(res.body.revokedKeys).toBe(1);
  });
});

// ── Key Verification (Direct Manager Test) ─────────────────────────────────

describe('ApiKeyManager.verifyKey', () => {
  it('verifies a valid key and returns key info', () => {
    const manager = new ApiKeyManager();
    const secret = manager.generateKey('test-issuer', 'Test Key');

    const verified = manager.verifyKey(secret.key);
    expect(verified).toBeDefined();
    expect(verified?.issuer).toBe('test-issuer');
    expect(verified?.name).toBe('Test Key');
  });

  it('returns undefined for an invalid key', () => {
    const manager = new ApiKeyManager();
    manager.generateKey('test-issuer', 'Test Key');

    const verified = manager.verifyKey('qp_invalid');
    expect(verified).toBeUndefined();
  });

  it('returns undefined for a revoked key', () => {
    const manager = new ApiKeyManager();
    const secret = manager.generateKey('test-issuer', 'Test Key');

    manager.revokeKey(secret.id);

    const verified = manager.verifyKey(secret.key);
    expect(verified).toBeUndefined();
  });

  it('updates lastUsedAt timestamp on verification', () => {
    const manager = new ApiKeyManager();
    const secret = manager.generateKey('test-issuer', 'Test Key');

    // Verify the key
    const before = new Date().getTime();
    manager.verifyKey(secret.key);
    const after = new Date().getTime();

    const key = manager.getKey(secret.id);
    expect(key?.lastUsedAt).toBeDefined();

    if (key?.lastUsedAt) {
      const usedTime = new Date(key.lastUsedAt).getTime();
      expect(usedTime).toBeGreaterThanOrEqual(before);
      expect(usedTime).toBeLessThanOrEqual(after);
    }
  });
});

// ── Rate Limiting Per Key ───────────────────────────────────────────────────

describe('Rate limiting per API key', () => {
  it('tracks usage for rate limiting purposes', () => {
    const { manager } = freshManager();
    const secret = manager.generateKey('test-issuer', 'Test Key');

    // Record multiple usages
    for (let i = 0; i < 5; i++) {
      manager.recordUsage(secret.id, `/endpoint/${i}`);
    }

    const usage = manager.getUsageHistory(secret.id);
    expect(usage.length).toBeGreaterThanOrEqual(5);
  });

  it('allows rate limiter to query usage within a time window', () => {
    const { manager } = freshManager();
    const secret = manager.generateKey('test-issuer', 'Test Key');

    const now = Date.now();
    for (let i = 0; i < 10; i++) {
      manager.recordUsage(secret.id, '/api/test');
    }

    const usage = manager.getUsageHistory(secret.id);
    const recentUsage = usage.filter(u => {
      const usedTime = new Date(u.usedAt).getTime();
      return usedTime >= now - 5000; // Last 5 seconds
    });

    expect(recentUsage.length).toBeGreaterThan(0);
  });
});
