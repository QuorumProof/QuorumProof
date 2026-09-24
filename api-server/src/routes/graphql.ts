import { Router, Request, Response } from 'express';
import type { simulateCall as SimulateCallType } from '../soroban.js';
import { getPool } from '../db.js';

export type SorobanClient = {
  simulateCall: typeof SimulateCallType;
  u64Val: (n: number | bigint) => ReturnType<typeof SimulateCallType>;
  addressVal: (a: string) => ReturnType<typeof SimulateCallType>;
};

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

// Minimal introspection schema returned for __schema queries
const SCHEMA_DESCRIPTION = {
  types: [
    {
      name: 'Query',
      kind: 'OBJECT',
      fields: [
        { name: 'credential', description: 'Fetch a single credential by ID' },
        { name: 'credentials', description: 'Fetch multiple credentials by IDs' },
        { name: 'slice', description: 'Fetch a quorum slice by ID' },
        { name: 'credentialCount', description: 'Total number of credentials' },
        { name: 'attestorReputation', description: 'Reputation score for an attestor address' },
        { name: 'credentialTier', description: 'Fetch tier information for a credential' },
        { name: 'credentialRewards', description: 'Fetch reward balance for a credential' },
        { name: 'tierRequirements', description: 'Fetch tier advancement requirements' },
        { name: 'redemptionRequests', description: 'Fetch redemption requests for a credential' },
      ],
    },
    { name: 'Credential', kind: 'OBJECT' },
    { name: 'Slice', kind: 'OBJECT' },
    { name: 'AttestorReputation', kind: 'OBJECT' },
    { name: 'CredentialTier', kind: 'OBJECT' },
    { name: 'CredentialRewards', kind: 'OBJECT' },
    { name: 'TierRequirement', kind: 'OBJECT' },
    { name: 'RedemptionRequest', kind: 'OBJECT' },
  ],
};

type GraphQLVariables = Record<string, unknown>;

interface ResolverContext {
  soroban: SorobanClient;
}

async function resolveCredential(
  args: GraphQLVariables,
  ctx: ResolverContext,
): Promise<unknown> {
  const id = args['id'];
  if (!id) throw new Error('credential requires id argument');
  const numId = parseInt(String(id), 10);
  if (!Number.isInteger(numId) || numId <= 0) throw new Error('id must be a positive integer');
  const cred = await ctx.soroban.simulateCall('get_credential', [ctx.soroban.u64Val(numId)]);
  return serializeBigInt(cred);
}

async function resolveCredentials(
  args: GraphQLVariables,
  ctx: ResolverContext,
): Promise<unknown[]> {
  const ids = args['ids'];
  if (!Array.isArray(ids) || ids.length === 0) throw new Error('credentials requires ids array');
  if (ids.length > 50) throw new Error('credentials ids cannot exceed 50 items');
  const results = await Promise.all(
    ids.map(async (id: unknown) => {
      try {
        const numId = parseInt(String(id), 10);
        if (!Number.isInteger(numId) || numId <= 0) return null;
        const cred = await ctx.soroban.simulateCall('get_credential', [ctx.soroban.u64Val(numId)]);
        return serializeBigInt(cred);
      } catch {
        return null;
      }
    }),
  );
  return results;
}

async function resolveSlice(
  args: GraphQLVariables,
  ctx: ResolverContext,
): Promise<unknown> {
  const id = args['id'];
  if (!id) throw new Error('slice requires id argument');
  const numId = parseInt(String(id), 10);
  if (!Number.isInteger(numId) || numId <= 0) throw new Error('id must be a positive integer');
  const slice = await ctx.soroban.simulateCall('get_slice', [ctx.soroban.u64Val(numId)]);
  return serializeBigInt(slice);
}

async function resolveCredentialCount(ctx: ResolverContext): Promise<number> {
  const count: bigint = await ctx.soroban.simulateCall('get_credential_count', []);
  return Number(count);
}

async function resolveAttestorReputation(
  args: GraphQLVariables,
  ctx: ResolverContext,
): Promise<unknown> {
  const address = args['address'];
  if (!address || typeof address !== 'string') throw new Error('attestorReputation requires address argument');
  const score = await ctx.soroban.simulateCall('get_attestor_reputation', [ctx.soroban.addressVal(address)]);
  const scoreNum = typeof score === 'bigint' ? Number(score) : (typeof score === 'number' ? score : 0);
  return { address, score: scoreNum };
}

async function resolveCredentialTier(
  args: GraphQLVariables,
  _ctx: ResolverContext,
): Promise<unknown> {
  const id = args['id'];
  if (!id) throw new Error('credentialTier requires id argument');

  try {
    const pool = getPool();
    const result = await pool.query(
      `SELECT credential_id, tier, tier_points, tier_acquired_at
       FROM credential_tiers WHERE credential_id = $1`,
      [id]
    );

    if (result.rows.length === 0) return null;

    const tierRow = result.rows[0];
    const benefitsResult = await pool.query(
      `SELECT benefit_name, benefit_value FROM tier_benefits WHERE tier = $1`,
      [tierRow.tier]
    );

    const benefits: Record<string, string> = {};
    for (const benefit of benefitsResult.rows) {
      benefits[benefit.benefit_name] = benefit.benefit_value;
    }

    return {
      credential_id: tierRow.credential_id,
      tier: tierRow.tier,
      tier_points: tierRow.tier_points,
      tier_acquired_at: tierRow.tier_acquired_at,
      benefits,
    };
  } catch {
    return null;
  }
}

async function resolveCredentialRewards(
  args: GraphQLVariables,
  _ctx: ResolverContext,
): Promise<unknown> {
  const id = args['id'];
  if (!id) throw new Error('credentialRewards requires id argument');

  try {
    const pool = getPool();
    const result = await pool.query(
      `SELECT credential_id, reward_points, accumulated_value
       FROM credential_rewards WHERE credential_id = $1`,
      [id]
    );

    if (result.rows.length === 0) return null;

    const row = result.rows[0];
    return {
      credential_id: row.credential_id,
      reward_points: row.reward_points,
      accumulated_value: row.accumulated_value,
    };
  } catch {
    return null;
  }
}

async function resolveTierRequirements(
  _args: GraphQLVariables,
  _ctx: ResolverContext,
): Promise<unknown[]> {
  try {
    const pool = getPool();
    const result = await pool.query(
      `SELECT tier, min_points, min_attestations, min_age_days
       FROM tier_requirements ORDER BY min_points ASC`
    );
    return result.rows;
  } catch {
    return [];
  }
}

async function resolveRedemptionRequests(
  args: GraphQLVariables,
  _ctx: ResolverContext,
): Promise<unknown[]> {
  const id = args['id'];
  if (!id) throw new Error('redemptionRequests requires id argument');

  try {
    const pool = getPool();
    const limit = Math.min(parseInt(String(args['limit'] ?? '50'), 10), 100);

    const result = await pool.query(
      `SELECT id, credential_id, amount, destination_address, status, submitted_at, processed_at
       FROM redemption_requests WHERE credential_id = $1
       ORDER BY submitted_at DESC LIMIT $2`,
      [id, limit]
    );

    return result.rows;
  } catch {
    return [];
  }
}

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
  const ctx: ResolverContext = { soroban };

  /**
   * POST /api/graphql
   * #869 — GraphQL-compatible endpoint for batch queries.
   * Body: { query: string, variables?: object }
   *
   * Supported top-level fields:
   *   credential(id: ID)
   *   credentials(ids: [ID])
   *   slice(id: ID)
   *   credentialCount
   *   attestorReputation(address: String)
   */
  router.post('/', async (req: Request, res: Response) => {
    const { query, variables } = req.body as { query?: unknown; variables?: unknown };

    if (typeof query !== 'string' || !query.trim()) {
      res.status(400).json({ errors: [{ message: 'query must be a non-empty string' }] });
      return;
    }

    // Resolve variables into args for each operation
    const vars = (variables && typeof variables === 'object' && !Array.isArray(variables))
      ? (variables as GraphQLVariables)
      : {};

    // Handle introspection
    if (query.includes('__schema') || query.includes('__type')) {
      res.json({ data: { __schema: SCHEMA_DESCRIPTION } });
      return;
    }

    const operations = parseOperations(query);
    if (operations.length === 0) {
      res.status(400).json({ errors: [{ message: 'No recognizable fields in query' }] });
      return;
    }

    const data: Record<string, unknown> = {};
    const errors: Array<{ message: string; path: string }> = [];

    await Promise.all(
      operations.map(async ({ alias, field, args }) => {
        const key = alias ?? field;
        // Merge query-level variables (by matching var references like $varName)
        const resolvedArgs: GraphQLVariables = { ...vars, ...args };
        try {
          switch (field) {
            case 'credential':
              data[key] = await resolveCredential(resolvedArgs, ctx);
              break;
            case 'credentials':
              data[key] = await resolveCredentials(resolvedArgs, ctx);
              break;
            case 'slice':
              data[key] = await resolveSlice(resolvedArgs, ctx);
              break;
            case 'credentialCount':
              data[key] = await resolveCredentialCount(ctx);
              break;
            case 'attestorReputation':
              data[key] = await resolveAttestorReputation(resolvedArgs, ctx);
              break;
            case 'credentialTier':
              data[key] = await resolveCredentialTier(resolvedArgs, ctx);
              break;
            case 'credentialRewards':
              data[key] = await resolveCredentialRewards(resolvedArgs, ctx);
              break;
            case 'tierRequirements':
              data[key] = await resolveTierRequirements(resolvedArgs, ctx);
              break;
            case 'redemptionRequests':
              data[key] = await resolveRedemptionRequests(resolvedArgs, ctx);
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
    res.json(response);
  });

  /**
   * GET /api/graphql
   * Returns schema information for discoverability.
   */
  router.get('/', (_req: Request, res: Response) => {
    res.json({
      endpoint: 'POST /api/graphql',
      description: 'GraphQL-compatible batch query endpoint',
      supported_fields: [
        'credential(id: ID)',
        'credentials(ids: [ID])',
        'slice(id: ID)',
        'credentialCount',
        'attestorReputation(address: String)',
        'credentialTier(id: ID)',
        'credentialRewards(id: ID)',
        'tierRequirements',
        'redemptionRequests(id: ID, limit: Int)',
      ],
      example: {
        query: '{ credential(id: "1") { id subject issuer } credentialTier(id: "1") { tier tier_points } tierRequirements { tier min_points } }',
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
