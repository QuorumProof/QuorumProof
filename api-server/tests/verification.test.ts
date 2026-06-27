import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createVerificationRouter } from '../src/routes/verification.js';

const mockSimulateCall = vi.fn();
const mockSoroban = {
  simulateCall: mockSimulateCall,
  u64Val: (n: number | bigint) => n as any,
};

const app = express();
app.use(express.json());
app.use('/api/verification-services', createVerificationRouter(mockSoroban));

describe('GET /api/verification-services', () => {
  it('returns empty list initially', async () => {
    const res = await request(app).get('/api/verification-services');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.services)).toBe(true);
  });
});

describe('POST /api/verification-services/register', () => {
  it('registers a new provider', async () => {
    const res = await request(app)
      .post('/api/verification-services/register')
      .send({ name: 'Acme Checks', serviceType: 'background_check', webhookUrl: 'https://acme.example/hook' });

    expect(res.status).toBe(201);
    expect(res.body.name).toBe('Acme Checks');
    expect(res.body.serviceType).toBe('background_check');
    expect(res.body.id).toMatch(/^svc_/);
  });

  it('returns 400 when name is missing', async () => {
    const res = await request(app)
      .post('/api/verification-services/register')
      .send({ serviceType: 'identity' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/name/i);
  });

  it('returns 400 when serviceType is missing', async () => {
    const res = await request(app)
      .post('/api/verification-services/register')
      .send({ name: 'Test' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/serviceType/i);
  });
});

describe('POST /api/verification-services/attest', () => {
  let serviceId: string;

  beforeEach(async () => {
    mockSimulateCall.mockReset();
    const reg = await request(app)
      .post('/api/verification-services/register')
      .send({ name: 'Test Svc', serviceType: 'education' });
    serviceId = reg.body.id;
  });

  it('records an attestation for a known credential', async () => {
    mockSimulateCall.mockResolvedValueOnce({ id: '1', issuer: 'G123' });

    const res = await request(app)
      .post('/api/verification-services/attest')
      .send({ serviceId, credentialId: 1, result: 'pass', notes: 'Verified' });

    expect(res.status).toBe(201);
    expect(res.body.entry.result).toBe('pass');
    expect(res.body.entry.credentialId).toBe(1);
  });

  it('returns 400 for invalid result value', async () => {
    const res = await request(app)
      .post('/api/verification-services/attest')
      .send({ serviceId, credentialId: 1, result: 'unknown' });
    expect(res.status).toBe(400);
  });

  it('returns 400 for unknown serviceId', async () => {
    const res = await request(app)
      .post('/api/verification-services/attest')
      .send({ serviceId: 'svc_nope', credentialId: 1, result: 'pass' });
    expect(res.status).toBe(400);
  });

  it('returns 404 when credential does not exist', async () => {
    mockSimulateCall.mockRejectedValueOnce(new Error('CredentialNotFound'));
    const res = await request(app)
      .post('/api/verification-services/attest')
      .send({ serviceId, credentialId: 999, result: 'fail' });
    expect(res.status).toBe(404);
  });
});

describe('GET /api/verification-services/attestations', () => {
  it('returns 400 for invalid credentialId', async () => {
    const res = await request(app).get('/api/verification-services/attestations?credentialId=abc');
    expect(res.status).toBe(400);
  });

  it('returns filtered attestations by credentialId', async () => {
    const res = await request(app).get('/api/verification-services/attestations?credentialId=1');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.attestations)).toBe(true);
  });
});
