import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createGraphqlRouter } from '../src/routes/graphql.js';
import {
  PostgresGraphQLSubscriptionStore,
  PubSubGraphQLSubscriptionStore,
  type GraphQLSubscriptionRecord,
} from '../src/services/graphqlSubscriptions.js';
import type { PubSubBackend } from '../src/ws/pubsub.js';
import * as db from '../src/db.js';

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

function createSharedTestPubSub(): PubSubBackend {
  const handlers = new Map<string, Set<(payload: string) => void>>();
  return {
    publish(channel: string, payload: string) {
      const set = handlers.get(channel);
      if (!set) return;
      for (const handler of set) handler(payload);
    },
    subscribe(channel: string, handler: (payload: string) => void) {
      let set = handlers.get(channel);
      if (!set) {
        set = new Set();
        handlers.set(channel, set);
      }
      set.add(handler);
    },
    async close() {
      handlers.clear();
    },
  };
}

describe('GraphQL subscriptions across replicas and restarts', () => {
  it('propagates subscriptions across replicas via the pub/sub layer', async () => {
    const pubsub = createSharedTestPubSub();
    const replicaA = express();
    replicaA.use(express.json());
    replicaA.use(
      '/api/graphql',
      createGraphqlRouter(mockSoroban, new PubSubGraphQLSubscriptionStore(pubsub, 'replica-a')),
    );

    const replicaB = express();
    replicaB.use(express.json());
    replicaB.use(
      '/api/graphql',
      createGraphqlRouter(mockSoroban, new PubSubGraphQLSubscriptionStore(pubsub, 'replica-b')),
    );

    const createRes = await request(replicaA)
      .post('/api/graphql/subscriptions')
      .send({ query: 'subscription { credentialUpdated(id: "1") { id } }', variables: { id: '1' } });
    expect(createRes.status).toBe(201);
    const subId = createRes.body.subscription.id as string;

    // Replica B should immediately see and manage the subscription created on Replica A
    const getOnB = await request(replicaB).get(`/api/graphql/subscriptions/${subId}`);
    expect(getOnB.status).toBe(200);
    expect(getOnB.body.subscription.id).toBe(subId);

    const deleteOnB = await request(replicaB).delete(`/api/graphql/subscriptions/${subId}`);
    expect(deleteOnB.status).toBe(204);

    // Deletion on Replica B should propagate back to Replica A
    const getOnA = await request(replicaA).get(`/api/graphql/subscriptions/${subId}`);
    expect(getOnA.status).toBe(404);
  });

  it('survives a server restart when backed by the shared persistent store', async () => {
    const persistedRows = new Map<string, GraphQLSubscriptionRecord>();
    const fakePool = {
      query: vi.fn(async (sql: string, params: unknown[] = []) => {
        if (sql.includes('CREATE TABLE')) return { rows: [], rowCount: 0 };
        if (sql.includes('INSERT INTO graphql_subscriptions')) {
          const [id, query, variablesJson, createdAt] = params as [string, string, string, string];
          persistedRows.set(id, {
            id,
            query,
            variables: JSON.parse(variablesJson) as Record<string, unknown>,
            created_at: createdAt,
          });
          return { rows: [], rowCount: 1 };
        }
        if (sql.includes('SELECT id, query, variables, created_at FROM graphql_subscriptions WHERE id = $1')) {
          const record = persistedRows.get(String(params[0]));
          return { rows: record ? [record] : [], rowCount: record ? 1 : 0 };
        }
        if (sql.includes('DELETE FROM graphql_subscriptions WHERE id = $1')) {
          const id = String(params[0]);
          const existed = persistedRows.delete(id);
          return { rows: existed ? [{ id }] : [], rowCount: existed ? 1 : 0 };
        }
        return { rows: Array.from(persistedRows.values()), rowCount: persistedRows.size };
      }),
    };
    const poolSpy = vi.spyOn(db, 'getPool').mockReturnValue(fakePool as any);

    try {
      const pubsub = createSharedTestPubSub();
      const instanceBeforeRestart = express();
      instanceBeforeRestart.use(express.json());
      instanceBeforeRestart.use(
        '/api/graphql',
        createGraphqlRouter(mockSoroban, new PostgresGraphQLSubscriptionStore(pubsub)),
      );

      const createRes = await request(instanceBeforeRestart)
        .post('/api/graphql/subscriptions')
        .send({ query: 'subscription { tierChanged { id } }' });
      expect(createRes.status).toBe(201);
      const subId = createRes.body.subscription.id as string;

      // Simulate full process restart with a fresh router and fresh store instance
      const instanceAfterRestart = express();
      instanceAfterRestart.use(express.json());
      instanceAfterRestart.use(
        '/api/graphql',
        createGraphqlRouter(mockSoroban, new PostgresGraphQLSubscriptionStore(pubsub)),
      );

      const getAfterRestart = await request(instanceAfterRestart).get(`/api/graphql/subscriptions/${subId}`);
      expect(getAfterRestart.status).toBe(200);
      expect(getAfterRestart.body.subscription).toMatchObject({
        id: subId,
        query: 'subscription { tierChanged { id } }',
      });

      const deleteAfterRestart = await request(instanceAfterRestart).delete(`/api/graphql/subscriptions/${subId}`);
      expect(deleteAfterRestart.status).toBe(204);
    } finally {
      poolSpy.mockRestore();
    }
  });
});
