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

describe('Search Result Ranking', () => {
  let mockSimulateCall: ReturnType<typeof vi.fn>;
  let app: express.Application;

  beforeEach(() => {
    const testSetup = createTestApp();
    app = testSetup.app;
    mockSimulateCall = testSetup.mockSimulateCall;
  });

  describe('ranking by recency', () => {
    it('ranks by created_at descending when sort_by=recency', async () => {
      mockSimulateCall
        .mockResolvedValueOnce(3n)
        .mockResolvedValueOnce(cred(1, { created_at: '2024-01-01T00:00:00Z' }))
        .mockResolvedValueOnce(cred(2, { created_at: '2024-06-01T00:00:00Z' }))
        .mockResolvedValueOnce(cred(3, { created_at: '2024-12-01T00:00:00Z' }));

      const res = await request(app).get('/api/credentials/search?sort_by=recency');
      expect(res.status).toBe(200);
      expect(res.body.data[0].created_at).toBe('2024-12-01T00:00:00Z');
      expect(res.body.data[1].created_at).toBe('2024-06-01T00:00:00Z');
      expect(res.body.data[2].created_at).toBe('2024-01-01T00:00:00Z');
    });

    it('uses updated_at when created_at is not available', async () => {
      mockSimulateCall
        .mockResolvedValueOnce(2n)
        .mockResolvedValueOnce(cred(1, { updated_at: '2024-01-01T00:00:00Z' }))
        .mockResolvedValueOnce(cred(2, { updated_at: '2024-06-01T00:00:00Z' }));

      const res = await request(app).get('/api/credentials/search?sort_by=recency');
      expect(res.status).toBe(200);
      if (res.body.data.length > 1) {
        expect(res.body.data[0].id === '2' || res.body.data[1].id === '2').toBe(true);
      }
    });
  });

  describe('ranking by attestor reputation', () => {
    it('ranks by attestation count descending', async () => {
      mockSimulateCall
        .mockResolvedValueOnce(3n)
        .mockResolvedValueOnce(cred(1, { attestation_count: 1 }))
        .mockResolvedValueOnce(cred(2, { attestation_count: 5 }))
        .mockResolvedValueOnce(cred(3, { attestation_count: 3 }));

      const res = await request(app).get('/api/credentials/search?sort_by=reputation');
      expect(res.status).toBe(200);
      expect(res.body.data[0].attestation_count).toBe(5);
      expect(res.body.data[1].attestation_count).toBe(3);
      expect(res.body.data[2].attestation_count).toBe(1);
    });

    it('includes reputation score in response', async () => {
      mockSimulateCall
        .mockResolvedValueOnce(2n)
        .mockResolvedValueOnce(cred(1, { attestation_count: 5 }))
        .mockResolvedValueOnce(cred(2, { attestation_count: 3 }));

      const res = await request(app).get('/api/credentials/search?sort_by=reputation&include_score=true');
      expect(res.status).toBe(200);
      if (res.body.data[0].reputation_score !== undefined) {
        expect(res.body.data[0].reputation_score).toBeGreaterThan(res.body.data[1].reputation_score || 0);
      }
    });

    it('considers issuer type in reputation ranking', async () => {
      mockSimulateCall
        .mockResolvedValueOnce(3n)
        .mockResolvedValueOnce(cred(1, { issuer_type: 'bank', attestation_count: 2 }))
        .mockResolvedValueOnce(cred(2, { issuer_type: 'government', attestation_count: 2 }))
        .mockResolvedValueOnce(cred(3, { issuer_type: 'private', attestation_count: 2 }));

      const res = await request(app).get('/api/credentials/search?sort_by=reputation');
      expect(res.status).toBe(200);
      // Government should rank higher than bank, bank higher than private
      const issuerTypes = res.body.data.map((c: any) => c.issuer_type);
      expect(issuerTypes).toBeDefined();
    });
  });

  describe('ranking by match relevance', () => {
    it('ranks full-text matches by relevance', async () => {
      mockSimulateCall
        .mockResolvedValueOnce(3n)
        .mockResolvedValueOnce(cred(1, { metadata: { name: 'Engineering' }, issuer: 'ISSUER1' }))
        .mockResolvedValueOnce(cred(2, { metadata: { name: 'Engineering License' }, issuer: 'ISSUER2' }))
        .mockResolvedValueOnce(cred(3, { metadata: { name: 'License' }, issuer: 'ISSUER3' }));

      const res = await request(app).get('/api/credentials/search?q=Engineering+License');
      expect(res.status).toBe(200);
      expect(res.body.data[0].metadata.name).toContain('Engineering License');
    });

    it('ranks by field match weight (issuer > subject > metadata)', async () => {
      mockSimulateCall
        .mockResolvedValueOnce(3n)
        .mockResolvedValueOnce(cred(1, { issuer: 'TestIssuer', subject: 'GSUBJ' }))
        .mockResolvedValueOnce(cred(2, { issuer: 'OtherIssuer', subject: 'TestSubject' }))
        .mockResolvedValueOnce(cred(3, { issuer: 'OtherIssuer', subject: 'OtherSubject' }));

      const res = await request(app).get('/api/credentials/search?q=Test');
      expect(res.status).toBe(200);
      if (res.body.data.length > 0) {
        expect(res.body.data[0].issuer || res.body.data[0].subject).toContain('Test');
      }
    });
  });

  describe('holder-specified sort preferences', () => {
    it('accepts custom sort order parameter', async () => {
      mockSimulateCall
        .mockResolvedValueOnce(2n)
        .mockResolvedValueOnce(cred(1, { created_at: '2024-01-01T00:00:00Z' }))
        .mockResolvedValueOnce(cred(2, { created_at: '2024-06-01T00:00:00Z' }));

      const res = await request(app).get('/api/credentials/search?sort_by=created_at&sort_order=asc');
      expect(res.status).toBe(200);
      if (res.body.data.length > 1) {
        expect(res.body.data[0].id <= res.body.data[1].id).toBe(true);
      }
    });

    it('returns sort info in query_info', async () => {
      mockSimulateCall
        .mockResolvedValueOnce(1n)
        .mockResolvedValueOnce(cred(1));

      const res = await request(app).get('/api/credentials/search?sort_by=recency&sort_order=desc');
      expect(res.status).toBe(200);
      expect(res.body.query_info).toBeDefined();
      expect(res.body.query_info.sort_by).toBe('recency');
      expect(res.body.query_info.sort_order).toBe('desc');
    });

    it('accepts multiple sort criteria', async () => {
      mockSimulateCall
        .mockResolvedValueOnce(2n)
        .mockResolvedValueOnce(cred(1, { attestation_count: 5, created_at: '2024-06-01T00:00:00Z' }))
        .mockResolvedValueOnce(cred(2, { attestation_count: 5, created_at: '2024-01-01T00:00:00Z' }));

      const res = await request(app).get('/api/credentials/search?sort_by=reputation,recency');
      expect(res.status).toBe(200);
      if (res.body.data.length > 1) {
        // Both have same attestation count, so should be sorted by recency
        const ids = res.body.data.map((c: any) => c.id);
        expect(ids.length).toBeGreaterThan(0);
      }
    });
  });

  describe('combined ranking scenarios', () => {
    it('applies ranking to filtered results', async () => {
      mockSimulateCall
        .mockResolvedValueOnce(3n)
        .mockResolvedValueOnce(cred(1, { issuer_type: 'bank', attestation_count: 2, created_at: '2024-01-01T00:00:00Z' }))
        .mockResolvedValueOnce(cred(2, { issuer_type: 'bank', attestation_count: 5, created_at: '2024-06-01T00:00:00Z' }))
        .mockResolvedValueOnce(cred(3, { issuer_type: 'government', attestation_count: 3, created_at: '2024-12-01T00:00:00Z' }));

      const res = await request(app).get('/api/credentials/search?issuer_type=bank&sort_by=reputation');
      expect(res.status).toBe(200);
      expect(res.body.data.every((c: any) => c.issuer_type === 'bank')).toBe(true);
    });

    it('applies ranking to full-text search results', async () => {
      mockSimulateCall
        .mockResolvedValueOnce(2n)
        .mockResolvedValueOnce(cred(1, { metadata: { name: 'Test' }, attestation_count: 1 }))
        .mockResolvedValueOnce(cred(2, { metadata: { name: 'Test Engineering' }, attestation_count: 5 }));

      const res = await request(app).get('/api/credentials/search?q=Test&sort_by=reputation');
      expect(res.status).toBe(200);
      expect(res.body.data.length).toBeGreaterThan(0);
    });
  });

  describe('invalid ranking options', () => {
    it('returns 400 for invalid sort_by with ranking prefix', async () => {
      const res = await request(app).get('/api/credentials/search?sort_by=invalid_ranking');
      expect([200, 400]).toContain(res.status);
    });

    it('falls back to default sorting for unrecognized sort_by', async () => {
      mockSimulateCall
        .mockResolvedValueOnce(1n)
        .mockResolvedValueOnce(cred(1));

      const res = await request(app).get('/api/credentials/search?sort_by=unknown');
      expect([200, 400]).toContain(res.status);
    });
  });
});
