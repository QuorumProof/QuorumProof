import { beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { SearchIndex, type CredentialRecord } from '../src/searchIndex.js';
import { GraphQLResolvers } from '../src/services/graphqlResolvers.js';
import { createGraphqlRouter, type SorobanClient as RouterSorobanClient } from '../src/routes/graphql.js';
import { createCredentialTieringRouter } from '../src/routes/credentialTiering.js';

const mocks = vi.hoisted(() => ({
  getOrCreateTier: vi.fn(),
}));

vi.mock('../src/services/credentialTiering.js', () => ({
  credentialTieringService: { getOrCreateTier: mocks.getOrCreateTier },
}));

const soroban = {
  simulateCall: vi.fn(),
  u64Val: (value: number | bigint) => value,
  u32Val: (value: number) => value,
  addressVal: (value: string) => value,
} as unknown as RouterSorobanClient;

function credential(id: string): CredentialRecord {
  return {
    id,
    subject: `subject-${id}`,
    issuer: 'issuer-1',
    credential_type: 1,
    metadata_hash: `hash-${id}`,
    revoked: false,
    suspended: false,
    expires_at: null,
    version: 1,
  };
}

describe('GraphQLResolvers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('paginates issuer credentials using cursors emitted by the previous page', async () => {
    const searchIndex = new SearchIndex();
    searchIndex.indexCredentials([credential('1'), credential('2'), credential('3')]);
    const resolvers = new GraphQLResolvers({ soroban, searchIndex });

    const firstPage = await resolvers.resolveCredentialsByIssuer({ issuer: 'issuer-1', limit: 2 }) as {
      edges: Array<{ node: CredentialRecord; cursor: string }>;
      pageInfo: { hasNextPage: boolean; endCursor: string };
    };
    expect(firstPage.edges.map(({ node }) => node.id)).toEqual(['1', '2']);
    expect(firstPage.pageInfo.hasNextPage).toBe(true);

    const secondPage = await resolvers.resolveCredentialsByIssuer({
      issuer: 'issuer-1',
      cursor: firstPage.pageInfo.endCursor,
    }) as { edges: Array<{ node: CredentialRecord }>; pageInfo: { hasNextPage: boolean } };
    expect(secondPage.edges.map(({ node }) => node.id)).toEqual(['3']);
    expect(secondPage.pageInfo.hasNextPage).toBe(false);
  });

  it('rejects malformed cursors instead of silently treating them as the first page', async () => {
    const searchIndex = new SearchIndex();
    searchIndex.indexCredentials([credential('1')]);
    const resolvers = new GraphQLResolvers({ soroban, searchIndex });

    await expect(
      resolvers.resolveCredentialsByIssuer({ issuer: 'issuer-1', cursor: 'not-a-valid-cursor' }),
    ).rejects.toThrow('cursor is invalid');
  });

  it('matches the public authorization behavior of the REST tier route', async () => {
    const tier = { credential_id: 7, tier: 'bronze' };
    mocks.getOrCreateTier.mockResolvedValue(tier);

    const app = express();
    app.use(express.json());
    app.use('/api/credentials', createCredentialTieringRouter());
    app.use('/api/graphql', createGraphqlRouter(soroban));

    const restResponse = await request(app).get('/api/credentials/7/tier');
    const graphqlResponse = await request(app)
      .post('/api/graphql')
      .send({ query: '{ credentialTier(credentialId: "7") { tier } }' });

    expect(restResponse.status).toBe(200);
    expect(graphqlResponse.status).toBe(restResponse.status);
    expect(graphqlResponse.body.data.credentialTier).toEqual(tier);
    expect(mocks.getOrCreateTier).toHaveBeenCalledTimes(2);
  });
});
