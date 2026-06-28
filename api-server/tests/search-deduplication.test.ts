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

describe('Credential Deduplication in Search', () => {
  let mockSimulateCall: ReturnType<typeof vi.fn>;
  let app: express.Application;

  beforeEach(() => {
    const testSetup = createTestApp();
    app = testSetup.app;
    mockSimulateCall = testSetup.mockSimulateCall;
  });

  describe('deduplicate mode (default)', () => {
    it('returns only latest version of duplicate credentials', async () => {
      mockSimulateCall
        .mockResolvedValueOnce(2n)
        .mockResolvedValueOnce(cred(1, { subject: 'GSUBJECT1', version: 1, updated_at: '2024-01-01T00:00:00Z' }))
        .mockResolvedValueOnce(cred(2, { subject: 'GSUBJECT1', version: 2, updated_at: '2024-06-01T00:00:00Z' }));

      const res = await request(app).get('/api/credentials/search?deduplicate=true');
      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(1);
      expect(res.body.data[0].version).toBe(2);
      expect(res.body.pagination.total).toBe(1);
    });

    it('deduplicates by subject and issuer combination', async () => {
      mockSimulateCall
        .mockResolvedValueOnce(3n)
        .mockResolvedValueOnce(cred(1, { subject: 'GSUBJ1', issuer: 'GISS1', version: 1 }))
        .mockResolvedValueOnce(cred(2, { subject: 'GSUBJ1', issuer: 'GISS1', version: 2 }))
        .mockResolvedValueOnce(cred(3, { subject: 'GSUBJ2', issuer: 'GISS1', version: 1 }));

      const res = await request(app).get('/api/credentials/search?deduplicate=true');
      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(2);
      expect(res.body.data.map((c: any) => c.subject)).toContain('GSUBJ1');
      expect(res.body.data.map((c: any) => c.subject)).toContain('GSUBJ2');
    });

    it('keeps latest by updated_at when versions are equal', async () => {
      mockSimulateCall
        .mockResolvedValueOnce(2n)
        .mockResolvedValueOnce(cred(1, { subject: 'GSUBJ', version: 1, updated_at: '2024-01-01T00:00:00Z' }))
        .mockResolvedValueOnce(cred(2, { subject: 'GSUBJ', version: 1, updated_at: '2024-12-01T00:00:00Z' }));

      const res = await request(app).get('/api/credentials/search?deduplicate=true');
      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(1);
      expect(res.body.data[0].id).toBe('2');
    });
  });

  describe('show_all mode', () => {
    it('returns all versions when show_all is true', async () => {
      mockSimulateCall
        .mockResolvedValueOnce(2n)
        .mockResolvedValueOnce(cred(1, { subject: 'GSUBJECT1', version: 1 }))
        .mockResolvedValueOnce(cred(2, { subject: 'GSUBJECT1', version: 2 }));

      const res = await request(app).get('/api/credentials/search?deduplicate=false');
      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(2);
    });

    it('groups metadata in response when show_all is true', async () => {
      mockSimulateCall
        .mockResolvedValueOnce(2n)
        .mockResolvedValueOnce(cred(1, { subject: 'GSUBJ', version: 1 }))
        .mockResolvedValueOnce(cred(2, { subject: 'GSUBJ', version: 2 }));

      const res = await request(app).get('/api/credentials/search?deduplicate=false&include_versions=true');
      expect(res.status).toBe(200);
      expect(res.body.versions).toBeDefined();
    });
  });

  describe('deduplication with filters', () => {
    it('deduplicates after applying filters', async () => {
      mockSimulateCall
        .mockResolvedValueOnce(4n)
        .mockResolvedValueOnce(cred(1, { subject: 'GSUBJ1', issuer_type: 'bank', version: 1 }))
        .mockResolvedValueOnce(cred(2, { subject: 'GSUBJ1', issuer_type: 'bank', version: 2 }))
        .mockResolvedValueOnce(cred(3, { subject: 'GSUBJ2', issuer_type: 'government', version: 1 }))
        .mockResolvedValueOnce(cred(4, { subject: 'GSUBJ3', issuer_type: 'bank', version: 1 }));

      const res = await request(app).get('/api/credentials/search?deduplicate=true&issuer_type=bank');
      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(2);
    });

    it('deduplicates with full-text search', async () => {
      mockSimulateCall
        .mockResolvedValueOnce(2n)
        .mockResolvedValueOnce(cred(1, { subject: 'GSUBJ', metadata: { name: 'Engineering License' }, version: 1 }))
        .mockResolvedValueOnce(cred(2, { subject: 'GSUBJ', metadata: { name: 'Engineering License' }, version: 2 }));

      const res = await request(app).get('/api/credentials/search?deduplicate=true&q=Engineering');
      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(1);
    });
  });

  describe('deduplication with pagination', () => {
    it('maintains consistent pagination with deduplication', async () => {
      mockSimulateCall
        .mockResolvedValueOnce(4n)
        .mockResolvedValueOnce(cred(1, { subject: 'GSUBJ1', version: 1 }))
        .mockResolvedValueOnce(cred(2, { subject: 'GSUBJ1', version: 2 }))
        .mockResolvedValueOnce(cred(3, { subject: 'GSUBJ2', version: 1 }))
        .mockResolvedValueOnce(cred(4, { subject: 'GSUBJ3', version: 1 }));

      const res = await request(app).get('/api/credentials/search?deduplicate=true&limit=2');
      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(2);
      expect(res.body.pagination.total).toBe(3);
      expect(res.body.pagination.has_more).toBe(true);
    });

    it('cursor pagination works with deduplication', async () => {
      mockSimulateCall
        .mockResolvedValueOnce(3n)
        .mockResolvedValueOnce(cred(1, { subject: 'GSUBJ1', version: 1 }))
        .mockResolvedValueOnce(cred(2, { subject: 'GSUBJ1', version: 2 }))
        .mockResolvedValueOnce(cred(3, { subject: 'GSUBJ2', version: 1 }));

      const res = await request(app).get('/api/credentials/search?deduplicate=true&limit=1');
      expect(res.status).toBe(200);
      expect(res.body.pagination.next_cursor).toBeTruthy();
    });
  });

  describe('deduplication statistics', () => {
    it('returns deduplication stats in response', async () => {
      mockSimulateCall
        .mockResolvedValueOnce(3n)
        .mockResolvedValueOnce(cred(1, { subject: 'GSUBJ1', version: 1 }))
        .mockResolvedValueOnce(cred(2, { subject: 'GSUBJ1', version: 2 }))
        .mockResolvedValueOnce(cred(3, { subject: 'GSUBJ2', version: 1 }));

      const res = await request(app).get('/api/credentials/search?deduplicate=true');
      expect(res.status).toBe(200);
      expect(res.body.deduplication_stats).toBeDefined();
      expect(res.body.deduplication_stats.total_before).toBe(3);
      expect(res.body.deduplication_stats.total_after).toBe(2);
      expect(res.body.deduplication_stats.duplicates_removed).toBe(1);
    });
  });

  describe('invalid deduplication options', () => {
    it('accepts deduplicate parameter', async () => {
      mockSimulateCall.mockResolvedValueOnce(0n);

      const res = await request(app).get('/api/credentials/search?deduplicate=invalid');
      expect([200, 400]).toContain(res.status);
    });
  });
});
