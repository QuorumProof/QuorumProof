import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createGdprRouter } from '../src/routes/gdpr.js';

const mockSimulateCall = vi.fn();
const mockSoroban = {
  simulateCall: mockSimulateCall,
  u64Val: (n: number | bigint) => n as any,
};

const app = express();
app.use(express.json());
app.use('/api/gdpr', createGdprRouter(mockSoroban));

describe('POST /api/gdpr/request', () => {
  beforeEach(() => mockSimulateCall.mockReset());

  it('creates a GDPR request with no attestors — immediately anonymized', async () => {
    mockSimulateCall.mockResolvedValueOnce([]); // get_attestors returns empty

    const res = await request(app)
      .post('/api/gdpr/request')
      .send({ credentialId: 1 });

    expect(res.status).toBe(201);
    expect(res.body.credentialId).toBe(1);
    expect(res.body.status).toBe('anonymized');
    expect(res.body.requestId).toMatch(/^gdpr_/);
  });

  it('creates a pending request when attestors exist', async () => {
    mockSimulateCall.mockResolvedValueOnce(['GATT1', 'GATT2']); // two attestors

    const res = await request(app)
      .post('/api/gdpr/request')
      .send({ credentialId: 2 });

    expect(res.status).toBe(201);
    expect(res.body.status).toBe('pending_consent');
    expect(res.body.requiredConsents).toBe(2);
  });

  it('returns 400 for non-integer credentialId', async () => {
    const res = await request(app)
      .post('/api/gdpr/request')
      .send({ credentialId: 'abc' });
    expect(res.status).toBe(400);
  });

  it('returns 404 when get_attestors and get_credential both fail', async () => {
    mockSimulateCall
      .mockRejectedValueOnce(new Error('not found')) // get_attestors
      .mockRejectedValueOnce(new Error('not found')); // get_credential fallback
    const res = await request(app)
      .post('/api/gdpr/request')
      .send({ credentialId: 999 });
    expect(res.status).toBe(404);
  });
});

describe('GET /api/gdpr/request/:requestId', () => {
  beforeEach(() => mockSimulateCall.mockReset());

  it('returns 404 for unknown request ID', async () => {
    const res = await request(app).get('/api/gdpr/request/gdpr_unknown');
    expect(res.status).toBe(404);
  });

  it('returns the request record for a known ID', async () => {
    mockSimulateCall.mockResolvedValueOnce([]);
    const createRes = await request(app)
      .post('/api/gdpr/request')
      .send({ credentialId: 10 });
    const { requestId } = createRes.body;

    const res = await request(app).get(`/api/gdpr/request/${requestId}`);
    expect(res.status).toBe(200);
    expect(res.body.requestId).toBe(requestId);
  });
});

describe('POST /api/gdpr/consent', () => {
  let requestId: string;

  beforeEach(async () => {
    mockSimulateCall.mockReset();
    mockSimulateCall.mockResolvedValueOnce(['GATT1', 'GATT2']);
    const res = await request(app)
      .post('/api/gdpr/request')
      .send({ credentialId: 5 });
    requestId = res.body.requestId;
  });

  it('records consent and advances status when threshold reached', async () => {
    await request(app)
      .post('/api/gdpr/consent')
      .send({ requestId, attestorAddress: 'GATT1' });

    const res = await request(app)
      .post('/api/gdpr/consent')
      .send({ requestId, attestorAddress: 'GATT2' });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('anonymized');
    expect(res.body.attestorConsents).toHaveLength(2);
  });

  it('returns 400 for unknown requestId', async () => {
    const res = await request(app)
      .post('/api/gdpr/consent')
      .send({ requestId: 'gdpr_nope', attestorAddress: 'GATT1' });
    expect(res.status).toBe(400);
  });

  it('returns 400 when attestorAddress is missing', async () => {
    const res = await request(app)
      .post('/api/gdpr/consent')
      .send({ requestId });
    expect(res.status).toBe(400);
  });
});
