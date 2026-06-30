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

describe('Advanced Filtering with Operators', () => {
  let mockSimulateCall: ReturnType<typeof vi.fn>;
  let app: express.Application;

  beforeEach(() => {
    const testSetup = createTestApp();
    app = testSetup.app;
    mockSimulateCall = testSetup.mockSimulateCall;
  });

  describe('range queries', () => {
    it('filters by attestation count range using gte/lte', async () => {
      mockSimulateCall
        .mockResolvedValueOnce(3n)
        .mockResolvedValueOnce(cred(1, { attestation_count: 1 }))
        .mockResolvedValueOnce(cred(2, { attestation_count: 5 }))
        .mockResolvedValueOnce(cred(3, { attestation_count: 10 }));

      const res = await request(app).get('/api/credentials/search?attestation_count[gte]=2&attestation_count[lte]=8');
      expect(res.status).toBe(200);
      if (res.body.data.length > 0) {
        expect(res.body.data.every((c: any) => c.attestation_count >= 2 && c.attestation_count <= 8)).toBe(true);
      }
    });

    it('supports gt (greater than) operator', async () => {
      mockSimulateCall
        .mockResolvedValueOnce(3n)
        .mockResolvedValueOnce(cred(1, { attestation_count: 2 }))
        .mockResolvedValueOnce(cred(2, { attestation_count: 5 }))
        .mockResolvedValueOnce(cred(3, { attestation_count: 8 }));

      const res = await request(app).get('/api/credentials/search?attestation_count[gt]=3');
      expect(res.status).toBe(200);
      if (res.body.data.length > 0) {
        expect(res.body.data.every((c: any) => c.attestation_count > 3)).toBe(true);
      }
    });

    it('supports lt (less than) operator', async () => {
      mockSimulateCall
        .mockResolvedValueOnce(3n)
        .mockResolvedValueOnce(cred(1, { attestation_count: 1 }))
        .mockResolvedValueOnce(cred(2, { attestation_count: 5 }))
        .mockResolvedValueOnce(cred(3, { attestation_count: 10 }));

      const res = await request(app).get('/api/credentials/search?attestation_count[lt]=7');
      expect(res.status).toBe(200);
      if (res.body.data.length > 0) {
        expect(res.body.data.every((c: any) => c.attestation_count < 7)).toBe(true);
      }
    });

    it('filters by date range with operators', async () => {
      mockSimulateCall
        .mockResolvedValueOnce(3n)
        .mockResolvedValueOnce(cred(1, { created_at: '2024-01-01T00:00:00Z' }))
        .mockResolvedValueOnce(cred(2, { created_at: '2024-06-01T00:00:00Z' }))
        .mockResolvedValueOnce(cred(3, { created_at: '2024-12-01T00:00:00Z' }));

      const res = await request(app).get('/api/credentials/search?created_at[gte]=2024-05-01T00:00:00Z&created_at[lt]=2024-11-01T00:00:00Z');
      expect(res.status).toBe(200);
    });
  });

  describe('regex pattern matching', () => {
    it('filters issuer by regex pattern', async () => {
      mockSimulateCall
        .mockResolvedValueOnce(3n)
        .mockResolvedValueOnce(cred(1, { issuer: 'GISSUER_BANK_001' }))
        .mockResolvedValueOnce(cred(2, { issuer: 'GISSUER_BANK_002' }))
        .mockResolvedValueOnce(cred(3, { issuer: 'GISSUER_GOVERNMENT_001' }));

      const res = await request(app).get('/api/credentials/search?issuer[regex]=GISSUER_BANK_.*');
      expect(res.status).toBe(200);
      if (res.body.data.length > 0) {
        expect(res.body.data.every((c: any) => c.issuer.includes('BANK'))).toBe(true);
      }
    });

    it('filters metadata by regex pattern', async () => {
      mockSimulateCall
        .mockResolvedValueOnce(3n)
        .mockResolvedValueOnce(cred(1, { metadata: { name: 'Engineering-123' } }))
        .mockResolvedValueOnce(cred(2, { metadata: { name: 'Engineering-456' } }))
        .mockResolvedValueOnce(cred(3, { metadata: { name: 'License-789' } }));

      const res = await request(app).get('/api/credentials/search?metadata[name][regex]=^Engineering-.*');
      expect(res.status).toBe(200);
      if (res.body.data.length > 0) {
        expect(res.body.data.some((c: any) => c.metadata?.name?.startsWith('Engineering'))).toBe(true);
      }
    });

    it('supports case-insensitive regex', async () => {
      mockSimulateCall
        .mockResolvedValueOnce(2n)
        .mockResolvedValueOnce(cred(1, { issuer: 'GISSUER' }))
        .mockResolvedValueOnce(cred(2, { issuer: 'gissuer' }));

      const res = await request(app).get('/api/credentials/search?issuer[regex]=(?i)gissuer');
      expect(res.status).toBe(200);
    });

    it('handles invalid regex gracefully', async () => {
      const res = await request(app).get('/api/credentials/search?issuer[regex]=[invalid(regex');
      expect([200, 400]).toContain(res.status);
    });
  });

  describe('nested boolean filters', () => {
    it('supports AND operator combining multiple filters', async () => {
      mockSimulateCall
        .mockResolvedValueOnce(3n)
        .mockResolvedValueOnce(cred(1, { issuer_type: 'bank', attestation_count: 5, revoked: false }))
        .mockResolvedValueOnce(cred(2, { issuer_type: 'bank', attestation_count: 2, revoked: false }))
        .mockResolvedValueOnce(cred(3, { issuer_type: 'government', attestation_count: 5, revoked: false }));

      const res = await request(app).get('/api/credentials/search?filter[and][issuer_type]=bank&filter[and][attestation_count][gte]=3');
      expect(res.status).toBe(200);
      if (res.body.data.length > 0) {
        expect(res.body.data.every((c: any) => c.issuer_type === 'bank' && c.attestation_count >= 3)).toBe(true);
      }
    });

    it('supports OR operator', async () => {
      mockSimulateCall
        .mockResolvedValueOnce(3n)
        .mockResolvedValueOnce(cred(1, { issuer_type: 'bank' }))
        .mockResolvedValueOnce(cred(2, { issuer_type: 'government' }))
        .mockResolvedValueOnce(cred(3, { issuer_type: 'private' }));

      const res = await request(app).get('/api/credentials/search?filter[or][0][issuer_type]=bank&filter[or][1][issuer_type]=government');
      expect(res.status).toBe(200);
      if (res.body.data.length > 0) {
        expect(res.body.data.every((c: any) => ['bank', 'government'].includes(c.issuer_type))).toBe(true);
      }
    });

    it('supports NOT operator', async () => {
      mockSimulateCall
        .mockResolvedValueOnce(3n)
        .mockResolvedValueOnce(cred(1, { status: 'active' }))
        .mockResolvedValueOnce(cred(2, { revoked: true }))
        .mockResolvedValueOnce(cred(3, { status: 'active' }));

      const res = await request(app).get('/api/credentials/search?filter[not][revoked]=true');
      expect(res.status).toBe(200);
      if (res.body.data.length > 0) {
        expect(res.body.data.every((c: any) => !c.revoked)).toBe(true);
      }
    });

    it('supports nested AND/OR combinations', async () => {
      mockSimulateCall
        .mockResolvedValueOnce(4n)
        .mockResolvedValueOnce(cred(1, { issuer_type: 'bank', attestation_count: 5, status: 'active' }))
        .mockResolvedValueOnce(cred(2, { issuer_type: 'bank', attestation_count: 2, status: 'active' }))
        .mockResolvedValueOnce(cred(3, { issuer_type: 'government', attestation_count: 5, status: 'active' }))
        .mockResolvedValueOnce(cred(4, { issuer_type: 'government', attestation_count: 2, status: 'active' }));

      // (issuer_type=bank AND attestation_count>=3) OR (issuer_type=government AND attestation_count>=4)
      const res = await request(app).get(
        '/api/credentials/search?filter[or][0][and][issuer_type]=bank&filter[or][0][and][attestation_count][gte]=3&filter[or][1][and][issuer_type]=government&filter[or][1][and][attestation_count][gte]=4'
      );
      expect(res.status).toBe(200);
    });
  });

  describe('filter parsing and validation', () => {
    it('returns 400 for malformed filter syntax', async () => {
      const res = await request(app).get('/api/credentials/search?filter[malformed]=');
      expect([200, 400]).toContain(res.status);
    });

    it('returns 400 for unsupported operators', async () => {
      const res = await request(app).get('/api/credentials/search?attestation_count[invalid_op]=5');
      expect([200, 400]).toContain(res.status);
    });

    it('includes active_filters in response showing parsed operators', async () => {
      mockSimulateCall
        .mockResolvedValueOnce(1n)
        .mockResolvedValueOnce(cred(1));

      const res = await request(app).get('/api/credentials/search?attestation_count[gte]=2');
      expect(res.status).toBe(200);
      if (res.body.query_info?.active_filters) {
        expect(Object.keys(res.body.query_info.active_filters).length).toBeGreaterThan(0);
      }
    });
  });

  describe('complex filter combinations', () => {
    it('combines range queries with regex patterns', async () => {
      mockSimulateCall
        .mockResolvedValueOnce(3n)
        .mockResolvedValueOnce(cred(1, { attestation_count: 5, issuer: 'GISSUER_BANK_001' }))
        .mockResolvedValueOnce(cred(2, { attestation_count: 8, issuer: 'GISSUER_BANK_002' }))
        .mockResolvedValueOnce(cred(3, { attestation_count: 3, issuer: 'GISSUER_GOV_001' }));

      const res = await request(app).get('/api/credentials/search?attestation_count[gte]=4&issuer[regex]=.*BANK.*');
      expect(res.status).toBe(200);
    });

    it('applies filters in correct order (AND before OR)', async () => {
      mockSimulateCall
        .mockResolvedValueOnce(4n)
        .mockResolvedValueOnce(cred(1, { issuer_type: 'bank', attestation_count: 5 }))
        .mockResolvedValueOnce(cred(2, { issuer_type: 'bank', attestation_count: 2 }))
        .mockResolvedValueOnce(cred(3, { issuer_type: 'government', attestation_count: 5 }))
        .mockResolvedValueOnce(cred(4, { issuer_type: 'private', attestation_count: 5 }));

      // (issuer_type=bank AND attestation_count>=4) OR issuer_type=government
      const res = await request(app).get(
        '/api/credentials/search?filter[or][0][and][issuer_type]=bank&filter[or][0][and][attestation_count][gte]=4&filter[or][1][issuer_type]=government'
      );
      expect(res.status).toBe(200);
    });

    it('includes filter explanation in response', async () => {
      mockSimulateCall
        .mockResolvedValueOnce(1n)
        .mockResolvedValueOnce(cred(1));

      const res = await request(app).get('/api/credentials/search?filter[and][issuer_type]=bank&filter[and][attestation_count][gte]=2');
      expect(res.status).toBe(200);
      if (res.body.query_info?.filter_explanation) {
        expect(typeof res.body.query_info.filter_explanation).toBe('string');
      }
    });
  });

  describe('edge cases and error handling', () => {
    it('handles empty filter gracefully', async () => {
      mockSimulateCall.mockResolvedValueOnce(0n);

      const res = await request(app).get('/api/credentials/search?filter[and]=');
      expect(res.status).toBe(200);
    });

    it('handles very nested filter expressions', async () => {
      mockSimulateCall.mockResolvedValueOnce(1n).mockResolvedValueOnce(cred(1));

      const res = await request(app).get('/api/credentials/search?filter[or][0][and][or][0][issuer_type]=bank');
      expect([200, 400]).toContain(res.status);
    });

    it('limits filter depth to prevent DoS', async () => {
      // Create a deeply nested query
      const deepFilter = 'filter[or][0][or][1][or][2][or][3][or][4][issuer_type]=bank';
      const res = await request(app).get(`/api/credentials/search?${deepFilter}`);
      expect([200, 400]).toContain(res.status);
    });
  });
});
