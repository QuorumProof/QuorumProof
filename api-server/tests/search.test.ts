import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createCredentialsRouter } from '../src/routes/credentials.js';

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

const cred = (id: number, overrides = {}) => ({
  id: BigInt(id),
  subject: 'GSUBJECT',
  issuer: 'GISSUER',
  credential_type: 1,
  metadata_hash: 'hash',
  revoked: false,
  suspended: false,
  expires_at: null,
  version: 1,
  ...overrides,
});

describe('GET /api/credentials/search', () => {
  beforeEach(() => mockSimulateCall.mockReset());

  it('returns all credentials when no filters', async () => {
    mockSimulateCall
      .mockResolvedValueOnce(3n) // get_credential_count
      .mockResolvedValueOnce(cred(1))
      .mockResolvedValueOnce(cred(2))
      .mockResolvedValueOnce(cred(3));

    const res = await request(app).get('/api/credentials/search');
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(3);
    expect(res.body.pagination.total).toBe(3);
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

  it('filters by issuer', async () => {
    mockSimulateCall
      .mockResolvedValueOnce(2n)
      .mockResolvedValueOnce(cred(1, { issuer: 'GISSUER1' }))
      .mockResolvedValueOnce(cred(2, { issuer: 'GISSUER2' }));

    const res = await request(app).get('/api/credentials/search?issuer=GISSUER1');
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
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
  });

  it('returns 400 for invalid sort_by', async () => {
    const res = await request(app).get('/api/credentials/search?sort_by=invalid');
    expect(res.status).toBe(400);
  });
});
