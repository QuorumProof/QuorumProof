import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createGraphqlRouter } from '../src/routes/graphql.js';

const serviceMocks = vi.hoisted(() => ({
  getTier: vi.fn(),
  getCredentialRewards: vi.fn(),
}));

vi.mock('../src/services/credentialTiering.js', () => ({
  credentialTieringService: { getTier: serviceMocks.getTier },
}));
vi.mock('../src/services/credentialRedemption.js', () => ({
  credentialRedemptionService: { getCredentialRewards: serviceMocks.getCredentialRewards },
}));

const mockSimulateCall = vi.fn();
const mockSoroban = {
  simulateCall: mockSimulateCall,
  u64Val: (n: number | bigint) => n as any,
  u32Val: (n: number) => n as any,
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
  beforeEach(() => {
    mockSimulateCall.mockReset();
    serviceMocks.getTier.mockReset().mockResolvedValue(null);
    serviceMocks.getCredentialRewards.mockReset().mockResolvedValue([]);
  });

  it('returns 400 for missing query', async () => {
    const res = await request(app).post('/api/graphql').send({});
    expect(res.status).toBe(400);
    expect(res.body.location).toBe('body');
    expect(Array.isArray(res.body.details)).toBe(true);
    expect(res.body.details.length).toBeGreaterThan(0);
  });

  it('returns 400 for non-string or whitespace-only query', async () => {
    const nonString = await request(app).post('/api/graphql').send({ query: 123 });
    expect(nonString.status).toBe(400);
    expect(nonString.body.location).toBe('body');

    const whitespace = await request(app).post('/api/graphql').send({ query: '   ' });
    expect(whitespace.status).toBe(400);
    expect(whitespace.body.location).toBe('body');
  });

  it('returns 400 for invalid variables type', async () => {
    const res = await request(app)
      .post('/api/graphql')
      .send({ query: '{ credentialCount }', variables: ['invalid'] });
    expect(res.status).toBe(400);
    expect(res.body.location).toBe('body');
  });

  it('enforces maximum operation size on POST /api/graphql', async () => {
    const oversizedQuery = `{ credential(id: "${'a'.repeat(16_400)}") { id } }`;
    const resQuery = await request(app).post('/api/graphql').send({ query: oversizedQuery });
    expect(resQuery.status).toBe(400);
    expect(resQuery.body.location).toBe('body');

    const resVars = await request(app)
      .post('/api/graphql')
      .send({
        query: '{ credentialCount }',
        variables: { payload: 'x'.repeat(16_400) },
      });
    expect(resVars.status).toBe(400);
    expect(resVars.body.location).toBe('body');
    expect(resVars.body.details[0].message).toContain('exceeds maximum allowed size');
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

describe('POST & DELETE /api/graphql/subscriptions', () => {
  it('validates subscription request body and enforces max operation size', async () => {
    const missing = await request(app).post('/api/graphql/subscriptions').send({});
    expect(missing.status).toBe(400);
    expect(missing.body.location).toBe('body');

    const oversized = await request(app)
      .post('/api/graphql/subscriptions')
      .send({ query: `{ credential(id: "${'a'.repeat(16_400)}") { id } }` });
    expect(oversized.status).toBe(400);
    expect(oversized.body.location).toBe('body');
  });

  it('creates and deletes a valid subscription', async () => {
    const createRes = await request(app)
      .post('/api/graphql/subscriptions')
      .send({ query: '{ credentialCount }', variables: { channel: 'events' } });
    expect(createRes.status).toBe(201);
    expect(createRes.body.subscription.id).toBeTruthy();
    expect(createRes.body.subscription.variables).toEqual({ channel: 'events' });

    const delRes = await request(app).delete(`/api/graphql/subscriptions/${createRes.body.subscription.id}`);
    expect(delRes.status).toBe(204);

    const notFound = await request(app).delete(`/api/graphql/subscriptions/${createRes.body.subscription.id}`);
    expect(notFound.status).toBe(404);
  });

  it('rejects invalid subscription id param on DELETE', async () => {
    const tooLong = await request(app).delete(`/api/graphql/subscriptions/${'a'.repeat(129)}`);
    expect(tooLong.status).toBe(400);
    expect(tooLong.body.location).toBe('params');
  });
});
