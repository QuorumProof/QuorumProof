import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createGraphqlRouter } from '../src/routes/graphql.js';

const mockSimulateCall = vi.fn();
const mockSoroban = {
  simulateCall: mockSimulateCall,
  u64Val: (n: number | bigint) => n as any,
  addressVal: (a: string) => a as any,
};

const app = express();
app.use(express.json());
app.use('/api/graphql', createGraphqlRouter(mockSoroban));

const mockCredential = {
  id: '1', subject: 'GABC', issuer: 'GISSUER',
  credential_type: 1, revoked: false, suspended: false,
  expires_at: null, metadata_hash: 'abc', version: 1,
};

const mockSlice = {
  id: '1', creator: 'GCREATOR', attestors: ['GATT1'], weights: [1], threshold: 1,
};

describe('GET /api/graphql', () => {
  it('returns schema description', async () => {
    const res = await request(app).get('/api/graphql');
    expect(res.status).toBe(200);
    expect(res.body.endpoint).toContain('POST');
    expect(Array.isArray(res.body.supported_fields)).toBe(true);
  });
});

describe('POST /api/graphql', () => {
  beforeEach(() => mockSimulateCall.mockReset());

  it('returns 400 for missing query', async () => {
    const res = await request(app).post('/api/graphql').send({});
    expect(res.status).toBe(400);
    expect(res.body.errors[0].message).toBeTruthy();
  });

  it('resolves credential query', async () => {
    mockSimulateCall.mockResolvedValueOnce(mockCredential);

    const res = await request(app)
      .post('/api/graphql')
      .send({ query: '{ credential(id: "1") { id subject issuer } }' });

    expect(res.status).toBe(200);
    expect(res.body.data.credential).toBeTruthy();
    expect(res.body.data.credential.subject).toBe('GABC');
  });

  it('resolves credentials batch query', async () => {
    mockSimulateCall
      .mockResolvedValueOnce(mockCredential)
      .mockResolvedValueOnce({ ...mockCredential, id: '2', subject: 'GDEF' });

    const res = await request(app)
      .post('/api/graphql')
      .send({ query: '{ credentials(ids: ["1","2"]) { id subject } }' });

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data.credentials)).toBe(true);
    expect(res.body.data.credentials).toHaveLength(2);
  });

  it('resolves slice query', async () => {
    mockSimulateCall.mockResolvedValueOnce(mockSlice);

    const res = await request(app)
      .post('/api/graphql')
      .send({ query: '{ slice(id: "1") { id creator } }' });

    expect(res.status).toBe(200);
    expect(res.body.data.slice.creator).toBe('GCREATOR');
  });

  it('resolves credentialCount', async () => {
    mockSimulateCall.mockResolvedValueOnce(42n);

    const res = await request(app)
      .post('/api/graphql')
      .send({ query: '{ credentialCount }' });

    expect(res.status).toBe(200);
    expect(res.body.data.credentialCount).toBe(42);
  });

  it('resolves multiple fields in one query', async () => {
    mockSimulateCall
      .mockResolvedValueOnce(mockCredential)
      .mockResolvedValueOnce(5n);

    const res = await request(app)
      .post('/api/graphql')
      .send({ query: '{ credential(id: "1") { id } credentialCount }' });

    expect(res.status).toBe(200);
    expect(res.body.data.credential).toBeTruthy();
    expect(res.body.data.credentialCount).toBe(5);
  });

  it('returns errors for unknown fields without crashing', async () => {
    const res = await request(app)
      .post('/api/graphql')
      .send({ query: '{ unknownField }' });

    expect(res.status).toBe(200);
    expect(res.body.errors).toBeTruthy();
  });

  it('returns null for credential when soroban throws', async () => {
    mockSimulateCall.mockRejectedValueOnce(new Error('CredentialNotFound'));

    const res = await request(app)
      .post('/api/graphql')
      .send({ query: '{ credential(id: "999") { id } }' });

    expect(res.status).toBe(200);
    expect(res.body.data.credential).toBeNull();
    expect(res.body.errors).toBeTruthy();
  });

  it('handles __schema introspection', async () => {
    const res = await request(app)
      .post('/api/graphql')
      .send({ query: '{ __schema { types { name } } }' });

    expect(res.status).toBe(200);
    expect(res.body.data.__schema).toBeTruthy();
  });
});
