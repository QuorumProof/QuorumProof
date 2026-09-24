import type { simulateCall as SimulateCallType } from '../soroban.js';
import { credentialTieringService } from './credentialTiering.js';
import { credentialRedemptionService } from './credentialRedemption.js';
import { SearchIndex, type SearchOptions, type CredentialRecord as SearchCredentialRecord } from '../searchIndex.js';
import { SearchIndexStore } from './searchIndexStore.js';

export type SorobanClient = {
  simulateCall: typeof SimulateCallType;
  u64Val: (n: number | bigint) => ReturnType<typeof SimulateCallType>;
  u32Val: (n: number) => ReturnType<typeof SimulateCallType>;
  addressVal: (a: string) => ReturnType<typeof SimulateCallType>;
};

type GraphQLVariables = Record<string, unknown>;

interface ResolverContext {
  soroban: SorobanClient;
  searchIndex?: SearchIndex;
  startTime?: number;
}

function serializeBigInt(value: unknown): unknown {
  if (typeof value === 'bigint') return value.toString();
  if (Array.isArray(value)) return value.map(serializeBigInt);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, serializeBigInt(v)])
    );
  }
  return value;
}

function encodePageCursor(offset: number, limit: number): string {
  return Buffer.from(JSON.stringify({ offset, limit })).toString('base64');
}

function decodePageCursor(cursor: string): { offset: number; limit: number } | null {
  try {
    return JSON.parse(Buffer.from(cursor, 'base64').toString('utf-8'));
  } catch {
    return null;
  }
}

export class GraphQLResolvers {
  constructor(private ctx: ResolverContext) {}

  async resolveCredential(args: GraphQLVariables): Promise<unknown> {
    const id = args['id'];
    if (!id) throw new Error('credential requires id argument');
    const numId = parseInt(String(id), 10);
    if (!Number.isInteger(numId) || numId <= 0) throw new Error('id must be a positive integer');

    const cred = await this.ctx.soroban.simulateCall('get_credential', [this.ctx.soroban.u64Val(numId)]);
    const serialized = serializeBigInt(cred) as Record<string, unknown>;

    const tier = await credentialTieringService.getTier(numId);
    const rewards = await credentialRedemptionService.getCredentialRewards(numId);

    return {
      ...serialized,
      tier,
      rewards,
    };
  }

  async resolveCredentials(args: GraphQLVariables): Promise<unknown[]> {
    const ids = args['ids'];
    if (!Array.isArray(ids) || ids.length === 0) throw new Error('credentials requires ids array');
    if (ids.length > 50) throw new Error('credentials ids cannot exceed 50 items');

    return Promise.all(
      ids.map(async (id: unknown) => {
        try {
          const numId = parseInt(String(id), 10);
          if (!Number.isInteger(numId) || numId <= 0) return null;
          const cred = await this.ctx.soroban.simulateCall('get_credential', [this.ctx.soroban.u64Val(numId)]);
          const serialized = serializeBigInt(cred);

          const tier = await credentialTieringService.getTier(numId);
          const rewards = await credentialRedemptionService.getCredentialRewards(numId);

          return { ...serialized, tier, rewards };
        } catch {
          return null;
        }
      })
    );
  }

  async resolveCredentialsByIssuer(args: GraphQLVariables): Promise<unknown> {
    const issuer = args['issuer'];
    if (typeof issuer !== 'string') throw new Error('issuer must be a string');

    const limit = Math.min(parseInt(String(args['limit'] ?? 10), 10), 100);
    const offset = parseInt(String(args['offset'] ?? 0), 10);

    if (!this.ctx.searchIndex) return { edges: [], pageInfo: { hasNextPage: false }, totalCount: 0 };

    const searchOptions: SearchOptions = {
      filters: [{ issuer }],
      sort: 'relevance',
      limit: limit + 1,
      offset,
    };

    const results = this.ctx.searchIndex.search('', searchOptions);
    const hasNextPage = results.length > limit;
    const credentials = results.slice(0, limit);

    return {
      edges: credentials.map((cred: unknown, idx: number) => ({
        node: cred,
        cursor: encodePageCursor(offset + idx, limit),
      })),
      pageInfo: {
        hasNextPage,
        hasPreviousPage: offset > 0,
        startCursor: credentials.length > 0 ? encodePageCursor(offset, limit) : null,
        endCursor: credentials.length > 0 ? encodePageCursor(offset + credentials.length - 1, limit) : null,
      },
      totalCount: results.length,
    };
  }

  async resolveSlice(args: GraphQLVariables): Promise<unknown> {
    const id = args['id'];
    if (!id) throw new Error('slice requires id argument');
    const numId = parseInt(String(id), 10);
    if (!Number.isInteger(numId) || numId <= 0) throw new Error('id must be a positive integer');

    const slice = await this.ctx.soroban.simulateCall('get_slice', [this.ctx.soroban.u64Val(numId)]);
    return serializeBigInt(slice);
  }

  async resolveCredentialCount(): Promise<number> {
    const count: bigint = await this.ctx.soroban.simulateCall('get_credential_count', []);
    return Number(count);
  }

  async resolveAttestorReputation(args: GraphQLVariables): Promise<unknown> {
    const address = args['address'];
    if (!address || typeof address !== 'string') throw new Error('attestorReputation requires address argument');

    const score = await this.ctx.soroban.simulateCall('get_attestor_reputation', [this.ctx.soroban.addressVal(address)]);
    const scoreNum = typeof score === 'bigint' ? Number(score) : (typeof score === 'number' ? score : 0);
    return { address, score: scoreNum };
  }

  async resolveCredentialTier(args: GraphQLVariables): Promise<unknown> {
    const credentialId = parseInt(String(args['credentialId']), 10);
    if (!Number.isInteger(credentialId) || credentialId <= 0) throw new Error('credentialId must be a positive integer');

    return credentialTieringService.getOrCreateTier(credentialId);
  }

  async resolveCredentialRewards(args: GraphQLVariables): Promise<unknown[]> {
    const credentialId = parseInt(String(args['credentialId']), 10);
    if (!Number.isInteger(credentialId) || credentialId <= 0) throw new Error('credentialId must be a positive integer');

    const status = args['status'] as string | undefined;
    return credentialRedemptionService.getCredentialRewards(credentialId, status);
  }

  async resolveRewardsSummary(args: GraphQLVariables): Promise<unknown> {
    const credentialId = parseInt(String(args['credentialId']), 10);
    if (!Number.isInteger(credentialId) || credentialId <= 0) throw new Error('credentialId must be a positive integer');

    return credentialRedemptionService.getTotalRewardsByCredential(credentialId);
  }

  async resolveSearchCredentials(args: GraphQLVariables): Promise<unknown> {
    const query = args['query'];
    if (typeof query !== 'string') throw new Error('query must be a string');

    const limit = Math.min(parseInt(String(args['limit'] ?? 10), 10), 100);
    const offset = parseInt(String(args['offset'] ?? 0), 10);

    if (!this.ctx.searchIndex) return { results: [], totalCount: 0, hasMore: false };

    const searchOptions: SearchOptions = { sort: 'relevance', limit: limit + 1, offset };
    const results = this.ctx.searchIndex.search(query, searchOptions);
    const hasMore = results.length > limit;

    return {
      results: results.slice(0, limit),
      totalCount: results.length,
      hasMore,
    };
  }

  async resolveTierStats(): Promise<unknown> {
    return credentialTieringService.getTierStats();
  }

  async updateCredentialReputation(args: GraphQLVariables): Promise<unknown> {
    const credentialId = parseInt(String(args['credentialId']), 10);
    const scoreIncrement = parseInt(String(args['scoreIncrement']), 10);

    if (!Number.isInteger(credentialId) || credentialId <= 0) throw new Error('credentialId must be a positive integer');
    if (!Number.isInteger(scoreIncrement)) throw new Error('scoreIncrement must be an integer');

    return credentialTieringService.updateReputationScore(credentialId, scoreIncrement);
  }

  async claimReward(args: GraphQLVariables): Promise<unknown> {
    const rewardId = args['rewardId'];
    if (typeof rewardId !== 'string') throw new Error('rewardId must be a string');

    return credentialRedemptionService.claimReward(rewardId);
  }

  async settleEscrow(args: GraphQLVariables): Promise<unknown> {
    const escrowId = args['escrowId'];
    const settlementHash = args['settlementHash'];

    if (typeof escrowId !== 'string') throw new Error('escrowId must be a string');
    if (typeof settlementHash !== 'string') throw new Error('settlementHash must be a string');

    return credentialRedemptionService.settleEscrow(escrowId, settlementHash);
  }

  getBenchmarkMetrics(): { elapsedMs: number; operationCount: number } {
    const elapsedMs = this.ctx.startTime ? Date.now() - this.ctx.startTime : 0;
    return { elapsedMs, operationCount: 1 };
  }
}
