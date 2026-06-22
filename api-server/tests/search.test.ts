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

describe('GET /api/credentials/search', () => {
  let mockSimulateCall: ReturnType<typeof vi.fn>;
  let app: express.Application;

  beforeEach(() => {
    const testSetup = createTestApp();
    app = testSetup.app;
    mockSimulateCall = testSetup.mockSimulateCall;
  });

  it('returns all credentials when no filters', async () => {
    mockSimulateCall
      .mockResolvedValueOnce(3n)
      .mockResolvedValueOnce(cred(1))
      .mockResolvedValueOnce(cred(2))
      .mockResolvedValueOnce(cred(3));

    const res = await request(app).get('/api/credentials/search');
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(3);
    expect(res.body.pagination.total).toBe(3);
    expect(res.body.facets).toBeDefined();
  });

  it('filters by type', async () => {
    mockSimulateCall
      .mockResolvedValueOnce(2n)
      .mockResolvedValueOnce(cred(1, { credential_type: 1 }))
      .mockResolvedValueOnce(cred(2, { credential_type: 2 }));

    const res = await request(app).get('/api/credentials/search?type=1');
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].credential_type).toBe(1);
  });

  it('filters by multiple types', async () => {
    mockSimulateCall
      .mockResolvedValueOnce(3n)
      .mockResolvedValueOnce(cred(1, { credential_type: 1 }))
      .mockResolvedValueOnce(cred(2, { credential_type: 2 }))
      .mockResolvedValueOnce(cred(3, { credential_type: 3 }));

    const res = await request(app).get('/api/credentials/search?type=1&type=2');
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(2);
    expect(res.body.data.map((c: any) => c.credential_type)).toContain(1);
    expect(res.body.data.map((c: any) => c.credential_type)).toContain(2);
  });

  it('filters by issuer', async () => {
    mockSimulateCall
      .mockResolvedValueOnce(2n)
      .mockResolvedValueOnce(cred(1, { issuer: 'GISSUER1' }))
      .mockResolvedValueOnce(cred(2, { issuer: 'GISSUER2' }));

    const res = await request(app).get('/api/credentials/search?issuer=GISSUER1');
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].issuer).toBe('GISSUER1');
  });

  it('filters by issuer_type', async () => {
    mockSimulateCall
      .mockResolvedValueOnce(3n)
      .mockResolvedValueOnce(cred(1, { issuer_type: 'bank' }))
      .mockResolvedValueOnce(cred(2, { issuer_type: 'government' }))
      .mockResolvedValueOnce(cred(3, { issuer_type: 'bank' }));

    const res = await request(app).get('/api/credentials/search?issuer_type=bank');
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(2);
    expect(res.body.data.every((c: any) => c.issuer_type === 'bank')).toBe(true);
  });

  it('filters by status=revoked', async () => {
    mockSimulateCall
      .mockResolvedValueOnce(2n)
      .mockResolvedValueOnce(cred(1, { revoked: true }))
      .mockResolvedValueOnce(cred(2, { revoked: false }));

    const res = await request(app).get('/api/credentials/search?status=revoked');
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].revoked).toBe(true);
  });

  it('filters by status=active', async () => {
    mockSimulateCall
      .mockResolvedValueOnce(3n)
      .mockResolvedValueOnce(cred(1))
      .mockResolvedValueOnce(cred(2, { revoked: true }))
      .mockResolvedValueOnce(cred(3, { suspended: true }));

    const res = await request(app).get('/api/credentials/search?status=active');
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
  });

  it('filters by attestation count range', async () => {
    mockSimulateCall
      .mockResolvedValueOnce(3n)
      .mockResolvedValueOnce(cred(1, { attestation_count: 1 }))
      .mockResolvedValueOnce(cred(2, { attestation_count: 5 }))
      .mockResolvedValueOnce(cred(3, { attestation_count: 10 }));

    const res = await request(app).get('/api/credentials/search?attestation_count_min=2&attestation_count_max=8');
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].attestation_count).toBe(5);
  });

  it('filters by created date range', async () => {
    mockSimulateCall
      .mockResolvedValueOnce(3n)
      .mockResolvedValueOnce(cred(1, { created_at: '2024-01-01T00:00:00Z' }))
      .mockResolvedValueOnce(cred(2, { created_at: '2024-06-01T00:00:00Z' }))
      .mockResolvedValueOnce(cred(3, { created_at: '2024-12-01T00:00:00Z' }));

    const res = await request(app).get('/api/credentials/search?created_after=2024-05-01T00:00:00Z&created_before=2024-11-01T00:00:00Z');
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].id).toBe('2');
  });

  it('performs full-text search', async () => {
    mockSimulateCall
      .mockResolvedValueOnce(3n)
      .mockResolvedValueOnce(cred(1, { issuer: 'GISSUER1', metadata: { name: 'Test Credential' } }))
      .mockResolvedValueOnce(cred(2, { issuer: 'GISSUER2', metadata: { name: 'Other Credential' } }))
      .mockResolvedValueOnce(cred(3, { issuer: 'GISSUER3', metadata: { name: 'Test Document' } }));

    const res = await request(app).get('/api/credentials/search?q=Test');
    expect(res.status).toBe(200);
    expect(res.body.data.length).toBeGreaterThan(0);
    expect(res.body.query_info.full_text_query).toBe('Test');
  });

  it('returns facet aggregation', async () => {
    mockSimulateCall
      .mockResolvedValueOnce(3n)
      .mockResolvedValueOnce(cred(1, { issuer: 'GISSUER1', credential_type: 1 }))
      .mockResolvedValueOnce(cred(2, { issuer: 'GISSUER2', credential_type: 2 }))
      .mockResolvedValueOnce(cred(3, { issuer: 'GISSUER1', credential_type: 1 }));

    const res = await request(app).get('/api/credentials/search?facets=issuer,credential_type');
    expect(res.status).toBe(200);
    expect(res.body.facets).toBeDefined();
    expect(res.body.facets.length).toBeGreaterThan(0);

    const issuerFacet = res.body.facets.find((f: any) => f.name === 'issuer');
    expect(issuerFacet).toBeDefined();
    expect(issuerFacet.values.length).toBeGreaterThan(0);
  });

  it('sorts by id desc', async () => {
    mockSimulateCall
      .mockResolvedValueOnce(2n)
      .mockResolvedValueOnce(cred(1))
      .mockResolvedValueOnce(cred(2));

    const res = await request(app).get('/api/credentials/search?sort_by=id&sort_order=desc');
    expect(res.status).toBe(200);
    expect(res.body.data[0].id).toBe('2');
    expect(res.body.data[1].id).toBe('1');
  });

  it('sorts by created_at', async () => {
    mockSimulateCall
      .mockResolvedValueOnce(2n)
      .mockResolvedValueOnce(cred(1, { created_at: '2024-01-01T00:00:00Z' }))
      .mockResolvedValueOnce(cred(2, { created_at: '2024-06-01T00:00:00Z' }));

    const res = await request(app).get('/api/credentials/search?sort_by=created_at&sort_order=asc');
    expect(res.status).toBe(200);
    expect(res.body.data[0].created_at).toBe('2024-01-01T00:00:00Z');
  });

  it('paginates results', async () => {
    mockSimulateCall
      .mockResolvedValueOnce(3n)
      .mockResolvedValueOnce(cred(1))
      .mockResolvedValueOnce(cred(2))
      .mockResolvedValueOnce(cred(3));

    const res = await request(app).get('/api/credentials/search?page=2&page_size=2');
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.pagination.page).toBe(2);
    expect(res.body.pagination.total).toBe(3);
    expect(res.body.pagination.total_pages).toBe(2);
  });

  it('returns 400 for invalid sort_by', async () => {
    const res = await request(app).get('/api/credentials/search?sort_by=invalid');
    expect(res.status).toBe(400);
  });

  it('returns 400 for invalid page', async () => {
    const res = await request(app).get('/api/credentials/search?page=0');
    expect(res.status).toBe(400);
  });

  it('returns 400 for page_size > 100', async () => {
    const res = await request(app).get('/api/credentials/search?page_size=101');
    expect(res.status).toBe(400);
  });

  it('includes query_info in response', async () => {
    mockSimulateCall
      .mockResolvedValueOnce(1n)
      .mockResolvedValueOnce(cred(1));

    const res = await request(app).get('/api/credentials/search?q=test&type=1');
    expect(res.status).toBe(200);
    expect(res.body.query_info).toBeDefined();
    expect(res.body.query_info.full_text_query).toBe('test');
    expect(res.body.query_info.active_filters.type).toBeDefined();
    expect(res.body.query_info.execution_time_ms).toBeGreaterThanOrEqual(0);
  });
});

describe('POST /api/credentials/search/refresh-index', () => {
  let mockSimulateCall: ReturnType<typeof vi.fn>;
  let app: express.Application;

  beforeEach(() => {
    const testSetup = createTestApp();
    app = testSetup.app;
    mockSimulateCall = testSetup.mockSimulateCall;
  });

  it('refreshes the search index', async () => {
    mockSimulateCall
      .mockResolvedValueOnce(2n)
      .mockResolvedValueOnce(cred(1))
      .mockResolvedValueOnce(cred(2));

    const res = await request(app).post('/api/credentials/search/refresh-index');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.index_size).toBe(2);
    expect(res.body.last_indexed).toBeDefined();
  });
});

describe('GET /api/credentials/search/index-stats', () => {
  let app: express.Application;

  beforeEach(() => {
    const testSetup = createTestApp();
    app = testSetup.app;
  });

  it('returns index statistics', async () => {
    const res = await request(app).get('/api/credentials/search/index-stats');
    expect(res.status).toBe(200);
    expect(res.body.index_size).toBeDefined();
    expect(res.body.timestamp).toBeDefined();
  });
});
