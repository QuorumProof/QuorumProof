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

describe('POST /api/credentials/verify-batch', () => {
  beforeEach(() => mockSimulateCall.mockReset());

  it('returns verification results for valid batch', async () => {
    mockSimulateCall
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);

    const res = await request(app)
      .post('/api/credentials/verify-batch')
      .send({ credential_ids: [1, 2, 3], slice_id: 1 });

    expect(res.status).toBe(200);
    expect(res.body.results).toHaveLength(3);
    expect(res.body.results[0]).toEqual({ credential_id: 1, attested: true, error: null });
    expect(res.body.results[1]).toEqual({ credential_id: 2, attested: false, error: null });
    expect(res.body.results[2]).toEqual({ credential_id: 3, attested: true, error: null });
  });

  it('returns 400 for missing credential_ids', async () => {
    const res = await request(app)
      .post('/api/credentials/verify-batch')
      .send({ slice_id: 1 });
    expect(res.status).toBe(400);
  });

  it('returns 400 for empty credential_ids', async () => {
    const res = await request(app)
      .post('/api/credentials/verify-batch')
      .send({ credential_ids: [], slice_id: 1 });
    expect(res.status).toBe(400);
  });

  it('returns 400 for missing slice_id', async () => {
    const res = await request(app)
      .post('/api/credentials/verify-batch')
      .send({ credential_ids: [1, 2] });
    expect(res.status).toBe(400);
  });

  it('returns 400 when batch exceeds 50 items', async () => {
    const ids = Array.from({ length: 51 }, (_, i) => i + 1);
    const res = await request(app)
      .post('/api/credentials/verify-batch')
      .send({ credential_ids: ids, slice_id: 1 });
    expect(res.status).toBe(400);
  });

  it('includes error field when credential lookup fails', async () => {
    mockSimulateCall.mockRejectedValueOnce(new Error('CredentialNotFound'));

    const res = await request(app)
      .post('/api/credentials/verify-batch')
      .send({ credential_ids: [999], slice_id: 1 });

    expect(res.status).toBe(200);
    expect(res.body.results[0].attested).toBe(false);
    expect(res.body.results[0].error).toContain('CredentialNotFound');
  });
});
