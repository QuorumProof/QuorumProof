import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { ShardedCredentialStore } from '../src/services/shardedStorage.js';
import { createCredentialsRouter } from '../src/routes/credentials.js';

// Unit tests for ShardedCredentialStore
describe('ShardedCredentialStore', () => {
  it('initialises with the configured shard count', () => {
    const store = new ShardedCredentialStore(4);
    expect(store.shardCount).toBe(4);
    expect(store.getShardStats()).toHaveLength(4);
  });

  it('stores and retrieves a credential by subject', () => {
    const store = new ShardedCredentialStore();
    const cred = {
      id: '1', subject: 'GABC', issuer: 'GISSUER',
      credential_type: 1, revoked: false, suspended: false,
      expires_at: null, metadata_hash: 'abc', version: 1,
    };
    store.set(cred);
    const results = store.getBySubject('GABC');
    expect(results).toHaveLength(1);
    expect(results[0].id).toBe('1');
  });

  it('returns empty array for unknown subject', () => {
    const store = new ShardedCredentialStore();
    expect(store.getBySubject('GUNKNOWN')).toHaveLength(0);
  });

  it('routes different subjects to potentially different shards', () => {
    const store = new ShardedCredentialStore(8);
    const idx1 = store.getShardIndex('GABC');
    const idx2 = store.getShardIndex('GXYZ');
    expect(idx1).toBeGreaterThanOrEqual(0);
    expect(idx1).toBeLessThan(8);
    expect(idx2).toBeGreaterThanOrEqual(0);
    expect(idx2).toBeLessThan(8);
  });

  it('getAll returns credentials across all shards', () => {
    const store = new ShardedCredentialStore(4);
    const base = { issuer: 'G', credential_type: 1, revoked: false, suspended: false, expires_at: null, metadata_hash: '', version: 1 };
    store.set({ ...base, id: '1', subject: 'GABC' });
    store.set({ ...base, id: '2', subject: 'GXYZ' });
    store.set({ ...base, id: '3', subject: 'GFOO' });
    expect(store.getAll()).toHaveLength(3);
    expect(store.totalSize).toBe(3);
  });

  it('delete removes a credential from its shard', () => {
    const store = new ShardedCredentialStore();
    const cred = {
      id: '1', subject: 'GABC', issuer: 'G',
      credential_type: 1, revoked: false, suspended: false,
      expires_at: null, metadata_hash: '', version: 1,
    };
    store.set(cred);
    expect(store.delete('1', 'GABC')).toBe(true);
    expect(store.getBySubject('GABC')).toHaveLength(0);
  });

  it('clear empties all shards', () => {
    const store = new ShardedCredentialStore();
    store.set({ id: '1', subject: 'GABC', issuer: 'G', credential_type: 1, revoked: false, suspended: false, expires_at: null, metadata_hash: '', version: 1 });
    store.clear();
    expect(store.totalSize).toBe(0);
  });

  it('getShardStats reports per-shard counts', () => {
    const store = new ShardedCredentialStore(4);
    store.set({ id: '1', subject: 'GABC', issuer: 'G', credential_type: 1, revoked: false, suspended: false, expires_at: null, metadata_hash: '', version: 1 });
    const stats = store.getShardStats();
    const total = stats.reduce((s, x) => s + x.count, 0);
    expect(total).toBe(1);
    expect(stats[0]).toHaveProperty('shard_index');
    expect(stats[0]).toHaveProperty('count');
  });
});

// Integration tests for the shard routes
describe('GET /api/credentials/shards/stats', () => {
  const mockSimulateCall = vi.fn();
  const mockSoroban = {
    simulateCall: mockSimulateCall,
    u64Val: (n: number | bigint) => n as any,
    u32Val: (n: number) => n as any,
    addressVal: (a: string) => a as any,
  };

  const app = express();
  app.use(express.json());
  app.use('/api/credentials', createCredentialsRouter(mockSoroban));

  beforeEach(() => mockSimulateCall.mockReset());

  it('returns shard statistics', async () => {
    const res = await request(app).get('/api/credentials/shards/stats');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('shard_count');
    expect(res.body).toHaveProperty('total_credentials');
    expect(Array.isArray(res.body.shards)).toBe(true);
  });
});

describe('GET /api/credentials/shards/by-subject', () => {
  const mockSimulateCall = vi.fn();
  const mockSoroban = {
    simulateCall: mockSimulateCall,
    u64Val: (n: number | bigint) => n as any,
    u32Val: (n: number) => n as any,
    addressVal: (a: string) => a as any,
  };

  const app = express();
  app.use(express.json());
  app.use('/api/credentials', createCredentialsRouter(mockSoroban));

  beforeEach(() => mockSimulateCall.mockReset());

  it('returns 400 when subject is missing', async () => {
    const res = await request(app).get('/api/credentials/shards/by-subject');
    expect(res.status).toBe(400);
  });

  it('returns credentials for a subject', async () => {
    const res = await request(app).get('/api/credentials/shards/by-subject?subject=GABC');
    expect(res.status).toBe(200);
    expect(res.body.subject).toBe('GABC');
    expect(res.body).toHaveProperty('shard_index');
    expect(Array.isArray(res.body.credentials)).toBe(true);
  });
});
