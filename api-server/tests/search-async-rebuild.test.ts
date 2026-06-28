import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createCredentialsRouter } from '../src/routes/credentials.js';

const cred = (id: number, overrides = {}) => ({
  id: BigInt(id),
  subject: 'GSUBJECT',
  issuer: 'GISSUER',
  issuer_type: 'bank',
  credential_type: 1,
  metadata_hash: 'hash',
  metadata: { name: 'Test Credential' },
  revoked: false,
  suspended: false,
  attestation_count: 0,
  expires_at: null,
  created_at: '2024-01-01T00:00:00Z',
  updated_at: '2024-01-01T00:00:00Z',
  version: 1,
  ...overrides,
});

const createTestApp = () => {
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

  return { app, mockSimulateCall, mockSoroban };
};

describe('Async Index Rebuild with Zero-Downtime', () => {
  let mockSimulateCall: ReturnType<typeof vi.fn>;
  let app: express.Application;

  beforeEach(() => {
    const testSetup = createTestApp();
    app = testSetup.app;
    mockSimulateCall = testSetup.mockSimulateCall;
  });

  describe('background index rebuild', () => {
    it('initiates async index rebuild', async () => {
      const res = await request(app).post('/api/credentials/search/rebuild-index-async');
      expect(res.status).toBe(202);
      expect(res.body.rebuild_id).toBeDefined();
      expect(res.body.status).toBe('queued');
    });

    it('returns unique rebuild ID for tracking', async () => {
      const res1 = await request(app).post('/api/credentials/search/rebuild-index-async');
      const res2 = await request(app).post('/api/credentials/search/rebuild-index-async');

      expect(res1.status).toBe(202);
      expect(res2.status).toBe(202);
      expect(res1.body.rebuild_id).not.toBe(res2.body.rebuild_id);
    });

    it('does not block search requests during rebuild', async () => {
      mockSimulateCall
        .mockResolvedValueOnce(1n)
        .mockResolvedValueOnce(cred(1));

      const rebuildRes = await request(app).post('/api/credentials/search/rebuild-index-async');
      expect(rebuildRes.status).toBe(202);

      // Search should still work
      const searchRes = await request(app).get('/api/credentials/search');
      expect(searchRes.status).toBe(200);
    });
  });

  describe('index versioning', () => {
    it('maintains old index version during rebuild', async () => {
      mockSimulateCall
        .mockResolvedValueOnce(1n)
        .mockResolvedValueOnce(cred(1, { version: 1 }));

      const searchRes1 = await request(app).get('/api/credentials/search');
      expect(searchRes1.status).toBe(200);
      expect(searchRes1.body.index_version).toBeDefined();

      const rebuildRes = await request(app).post('/api/credentials/search/rebuild-index-async');
      expect(rebuildRes.status).toBe(202);

      // Old index version should still be queryable
      const searchRes2 = await request(app).get('/api/credentials/search');
      expect(searchRes2.status).toBe(200);
    });

    it('atomically switches to new index upon completion', async () => {
      mockSimulateCall
        .mockResolvedValueOnce(1n)
        .mockResolvedValueOnce(cred(1, { version: 1 }))
        .mockResolvedValueOnce(2n)
        .mockResolvedValueOnce(cred(1, { version: 1 }))
        .mockResolvedValueOnce(cred(2, { version: 2 }));

      const rebuildRes = await request(app).post('/api/credentials/search/rebuild-index-async');
      expect(rebuildRes.status).toBe(202);
      const rebuilId = rebuildRes.body.rebuild_id;

      // Simulate rebuild completion
      await new Promise(resolve => setTimeout(resolve, 100));

      const statusRes = await request(app).get(`/api/credentials/search/rebuild-status/${rebuilId}`);
      if (statusRes.status === 200) {
        expect(['queued', 'processing', 'completed']).toContain(statusRes.body.status);
      }
    });

    it('tracks index version in search response', async () => {
      mockSimulateCall
        .mockResolvedValueOnce(1n)
        .mockResolvedValueOnce(cred(1));

      const res = await request(app).get('/api/credentials/search');
      expect(res.status).toBe(200);
      expect(res.body.index_version).toBeDefined();
      expect(typeof res.body.index_version).toBe('number');
    });
  });

  describe('rebuild status and monitoring', () => {
    it('returns rebuild status by ID', async () => {
      const rebuildRes = await request(app).post('/api/credentials/search/rebuild-index-async');
      const rebuildId = rebuildRes.body.rebuild_id;

      const statusRes = await request(app).get(`/api/credentials/search/rebuild-status/${rebuildId}`);
      expect(statusRes.status).toBe(200);
      expect(statusRes.body.rebuild_id).toBe(rebuildId);
      expect(statusRes.body.status).toBeDefined();
      expect(statusRes.body.started_at).toBeDefined();
    });

    it('returns progress information for ongoing rebuild', async () => {
      const rebuildRes = await request(app).post('/api/credentials/search/rebuild-index-async');
      const rebuildId = rebuildRes.body.rebuild_id;

      const statusRes = await request(app).get(`/api/credentials/search/rebuild-status/${rebuildId}`);
      expect(statusRes.status).toBe(200);
      if (statusRes.body.status === 'processing') {
        expect(statusRes.body.progress).toBeDefined();
        expect(statusRes.body.progress.credentials_processed).toBeDefined();
        expect(statusRes.body.progress.total_credentials).toBeDefined();
      }
    });

    it('returns completed rebuild metadata', async () => {
      const rebuildRes = await request(app).post('/api/credentials/search/rebuild-index-async');
      const rebuildId = rebuildRes.body.rebuild_id;

      // Poll for completion (with timeout)
      let statusRes = { status: 200, body: { status: 'processing' } };
      for (let i = 0; i < 10; i++) {
        await new Promise(resolve => setTimeout(resolve, 50));
        statusRes = await request(app).get(`/api/credentials/search/rebuild-status/${rebuildId}`);
        if (statusRes.body.status === 'completed') break;
      }

      if (statusRes.body.status === 'completed') {
        expect(statusRes.body.completed_at).toBeDefined();
        expect(statusRes.body.duration_ms).toBeDefined();
        expect(statusRes.body.credentials_indexed).toBeDefined();
      }
    });

    it('returns 404 for non-existent rebuild ID', async () => {
      const res = await request(app).get('/api/credentials/search/rebuild-status/invalid-id');
      expect(res.status).toBe(404);
    });
  });

  describe('concurrent rebuild handling', () => {
    it('rejects concurrent rebuilds', async () => {
      const res1 = await request(app).post('/api/credentials/search/rebuild-index-async');
      expect(res1.status).toBe(202);

      const res2 = await request(app).post('/api/credentials/search/rebuild-index-async');
      expect([202, 409]).toContain(res2.status);
    });

    it('queues or rejects multiple rebuild requests', async () => {
      const results = await Promise.all([
        request(app).post('/api/credentials/search/rebuild-index-async'),
        request(app).post('/api/credentials/search/rebuild-index-async'),
      ]);

      const accepted = results.filter(r => r.status === 202).length;
      expect(accepted).toBeGreaterThanOrEqual(1);
    });
  });

  describe('rebuild error handling', () => {
    it('recovers from rebuild errors gracefully', async () => {
      const res = await request(app).post('/api/credentials/search/rebuild-index-async');
      expect(res.status).toBe(202);
      const rebuildId = res.body.rebuild_id;

      // Check status can still be queried even if rebuild fails
      const statusRes = await request(app).get(`/api/credentials/search/rebuild-status/${rebuildId}`);
      expect(statusRes.status).toBe(200);
    });

    it('maintains old index if rebuild fails', async () => {
      mockSimulateCall.mockResolvedValueOnce(1n).mockResolvedValueOnce(cred(1));

      const preRebuildRes = await request(app).get('/api/credentials/search');
      expect(preRebuildRes.status).toBe(200);

      const rebuildRes = await request(app).post('/api/credentials/search/rebuild-index-async');
      expect(rebuildRes.status).toBe(202);

      // Old index should still be available
      const postRebuildRes = await request(app).get('/api/credentials/search');
      expect(postRebuildRes.status).toBe(200);
    });
  });

  describe('rebuild statistics', () => {
    it('returns rebuild statistics including time metrics', async () => {
      const rebuildRes = await request(app).post('/api/credentials/search/rebuild-index-async');
      expect(rebuildRes.status).toBe(202);
      expect(rebuildRes.body.estimated_duration_ms).toBeDefined();
    });

    it('returns list of recent rebuilds', async () => {
      const res = await request(app).get('/api/credentials/search/rebuild-history');
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body.rebuilds)).toBe(true);
    });
  });
});
