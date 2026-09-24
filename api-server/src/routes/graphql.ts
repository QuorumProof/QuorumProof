import { Router, Request, Response } from 'express';
import type { simulateCall as SimulateCallType } from '../soroban.js';
import { GraphQLResolvers, type SorobanClient } from '../services/graphqlResolvers.js';
import { graphqlSchema } from '../services/graphqlSchema.js';

type GraphQLVariables = Record<string, unknown>;


// Simple operation parser: extracts top-level field selections and their arguments
// Handles patterns like:  fieldName(arg: value) { ... }  and  fieldName
function parseOperations(query: string): Array<{
  alias: string | null;
  field: string;
  args: GraphQLVariables;
}> {
  const ops: Array<{ alias: string | null; field: string; args: GraphQLVariables }> = [];

  // Strip comments and collapse whitespace
  const stripped = query.replace(/#[^\n]*/g, ' ').replace(/\s+/g, ' ').trim();

  // Remove outer query/mutation wrapper if present
  const bodyMatch = stripped.match(/^(?:query|mutation)\s*\w*\s*\{([\s\S]*)\}$/) ??
    stripped.match(/^\{([\s\S]*)\}$/);
  const body = bodyMatch ? bodyMatch[1] : stripped;

  // Match: [alias:] fieldName [(args)] [{...}]
  const pattern = /(\w+)\s*:\s*(\w+)\s*(?:\(([^)]*)\))?|(\w+)\s*(?:\(([^)]*)\))?(?=\s*\{|\s*\w|\s*$)/g;
  let m: RegExpExecArray | null;

  while ((m = pattern.exec(body)) !== null) {
    const hasAlias = !!m[1];
    const alias = hasAlias ? m[1] : null;
    const field = hasAlias ? m[2] : m[4];
    const rawArgs = hasAlias ? (m[3] ?? '') : (m[5] ?? '');

    if (!field || field === 'on') continue;

    // Parse args: key: value pairs (strings, numbers, arrays of quoted strings/numbers)
    const args: GraphQLVariables = {};
    const argPattern = /(\w+)\s*:\s*(\[[^\]]*\]|"[^"]*"|'[^']*'|\d+|true|false|null)/g;
    let am: RegExpExecArray | null;
    while ((am = argPattern.exec(rawArgs)) !== null) {
      const key = am[1];
      const raw = am[2];
      if (raw.startsWith('[')) {
        // Parse array
        const items = raw
          .slice(1, -1)
          .split(',')
          .map((s) => s.trim().replace(/^["']|["']$/g, ''))
          .filter(Boolean);
        args[key] = items;
      } else if (raw.startsWith('"') || raw.startsWith("'")) {
        args[key] = raw.slice(1, -1);
      } else if (raw === 'true') {
        args[key] = true;
      } else if (raw === 'false') {
        args[key] = false;
      } else if (raw === 'null') {
        args[key] = null;
      } else {
        args[key] = parseFloat(raw);
      }
    }

    ops.push({ alias, field, args });
  }

  return ops;
}

export function createGraphqlRouter(soroban: SorobanClient) {
  const router = Router();

  /**
   * POST /api/graphql
   * #1604 — GraphQL endpoint for batch queries with federation support.
   * Body: { query: string, variables?: object }
   *
   * Supported top-level fields:
   *   credential(id: ID)
   *   credentials(ids: [ID])
   *   credentialsByIssuer(issuer: String!)
   *   slice(id: ID)
   *   credentialCount
   *   attestorReputation(address: String)
   *   credentialTier(credentialId: ID!)
   *   credentialRewards(credentialId: ID!, status: String)
   *   rewardsSummary(credentialId: ID!)
   *   searchCredentials(query: String!)
   *   tierStats
   */
  router.post('/', async (req: Request, res: Response) => {
    const startTime = Date.now();
    const { query, variables } = req.body as { query?: unknown; variables?: unknown };

    if (typeof query !== 'string' || !query.trim()) {
      res.status(400).json({ errors: [{ message: 'query must be a non-empty string' }] });
      return;
    }

    const vars = (variables && typeof variables === 'object' && !Array.isArray(variables))
      ? (variables as GraphQLVariables)
      : {};

    // Handle introspection queries
    if (query.includes('__schema') || query.includes('__type')) {
      res.json({
        data: {
          __schema: {
            types: [
              { name: 'Query', kind: 'OBJECT', description: 'Root query type' },
              { name: 'Mutation', kind: 'OBJECT', description: 'Root mutation type' },
              { name: 'Credential', kind: 'OBJECT' },
              { name: 'CredentialTier', kind: 'OBJECT' },
              { name: 'Reward', kind: 'OBJECT' },
              { name: 'TierStatistic', kind: 'OBJECT' },
            ],
          },
        },
      });
      return;
    }

    const operations = parseOperations(query);
    if (operations.length === 0) {
      res.status(400).json({ errors: [{ message: 'No recognizable fields in query' }] });
      return;
    }

    const data: Record<string, unknown> = {};
    const errors: Array<{ message: string; path: string }> = [];
    const resolvers = new GraphQLResolvers({ soroban, startTime });

    await Promise.all(
      operations.map(async ({ alias, field, args }) => {
        const key = alias ?? field;
        const resolvedArgs: GraphQLVariables = { ...vars, ...args };
        try {
          switch (field) {
            case 'credential':
              data[key] = await resolvers.resolveCredential(resolvedArgs);
              break;
            case 'credentials':
              data[key] = await resolvers.resolveCredentials(resolvedArgs);
              break;
            case 'credentialsByIssuer':
              data[key] = await resolvers.resolveCredentialsByIssuer(resolvedArgs);
              break;
            case 'slice':
              data[key] = await resolvers.resolveSlice(resolvedArgs);
              break;
            case 'credentialCount':
              data[key] = await resolvers.resolveCredentialCount();
              break;
            case 'attestorReputation':
              data[key] = await resolvers.resolveAttestorReputation(resolvedArgs);
              break;
            case 'credentialTier':
              data[key] = await resolvers.resolveCredentialTier(resolvedArgs);
              break;
            case 'credentialRewards':
              data[key] = await resolvers.resolveCredentialRewards(resolvedArgs);
              break;
            case 'rewardsSummary':
              data[key] = await resolvers.resolveRewardsSummary(resolvedArgs);
              break;
            case 'searchCredentials':
              data[key] = await resolvers.resolveSearchCredentials(resolvedArgs);
              break;
            case 'tierStats':
              data[key] = await resolvers.resolveTierStats();
              break;
            default:
              errors.push({ message: `Unknown field: ${field}`, path: key });
          }
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          errors.push({ message: msg, path: key });
          data[key] = null;
        }
      }),
    );

    const response: Record<string, unknown> = { data };
    if (errors.length > 0) response['errors'] = errors;

    const metrics = resolvers.getBenchmarkMetrics();
    res.set('X-GraphQL-Duration-Ms', String(metrics.elapsedMs));
    res.json(response);
  });

  /**
   * GET /api/graphql
   * Returns schema information and federation metadata for discoverability.
   */
  router.get('/', (_req: Request, res: Response) => {
    res.json({
      endpoint: 'POST /api/graphql',
      description: 'GraphQL endpoint with federation support (#1604)',
      version: '2.0',
      schema: graphqlSchema,
      federation: {
        enabled: true,
        version: '2.0',
        entities: ['Credential', 'CredentialTier', 'AttestorReputation'],
      },
      supported_fields: {
        queries: [
          'credential(id: ID!)',
          'credentials(ids: [ID!]!)',
          'credentialsByIssuer(issuer: String!, limit: Int, offset: Int)',
          'slice(id: ID!)',
          'credentialCount',
          'attestorReputation(address: String!)',
          'credentialTier(credentialId: ID!)',
          'credentialRewards(credentialId: ID!, status: String)',
          'rewardsSummary(credentialId: ID!)',
          'searchCredentials(query: String!, limit: Int, offset: Int)',
          'tierStats',
        ],
        mutations: [
          'updateCredentialReputation(credentialId: ID!, scoreIncrement: Int!)',
          'claimReward(credentialId: ID!, rewardId: ID!)',
          'settleEscrow(escrowId: ID!, settlementHash: String!)',
        ],
      },
      benchmarking: {
        supported: true,
        metricsHeader: 'X-GraphQL-Duration-Ms',
      },
      example: {
        query: `{
  credential(id: "1") { id subject issuer tier { tier reputationScore } }
  tierStats { tier count avgReputation }
  credentialCount
}`,
      },
    });
  });

  return router;
}

import { simulateCall, u64Val, addressVal } from '../soroban.js';
export default createGraphqlRouter({
  simulateCall,
  u64Val: u64Val as SorobanClient['u64Val'],
  addressVal: addressVal as SorobanClient['addressVal'],
});
