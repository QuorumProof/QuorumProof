import { Router, Request, Response } from 'express';
import { validate, schemas } from '../middleware/validate.js';
import { GraphQLResolvers, type SorobanClient } from '../services/graphqlResolvers.js';

type BulkOperationType =
  | 'credential'
  | 'credentials'
  | 'slice'
  | 'attestorReputation'
  | 'credentialTier'
  | 'credentialRewards'
  | 'rewardsSummary';

interface BulkOperation {
  id?: string;
  type?: BulkOperationType;
  args?: Record<string, unknown>;
}

export function createBulkOperationsRouter(soroban: SorobanClient) {
  const router = Router();

  router.post('/', validate(schemas.bulkOperations), async (req: Request, res: Response) => {
    const operations = (req.body as { operations: BulkOperation[] }).operations;

    const resolvers = new GraphQLResolvers({ soroban, startTime: Date.now() });
    const results = await Promise.all(
      operations.map(async (op, index) => {
        const id = op.id ?? String(index);
        const args = op.args ?? {};
        try {
          if (!op.type) throw new Error('type is required');
          return { id, ok: true, data: await resolveBulkOperation(resolvers, op.type, args) };
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          return { id, ok: false, error: message };
        }
      }),
    );

    const failed = results.filter((result) => !result.ok).length;
    res.status(failed > 0 ? 207 : 200).json({
      results,
      summary: {
        total: results.length,
        succeeded: results.length - failed,
        failed,
      },
    });
  });

  return router;
}

async function resolveBulkOperation(
  resolvers: GraphQLResolvers,
  type: BulkOperationType,
  args: Record<string, unknown>,
): Promise<unknown> {
  switch (type) {
    case 'credential':
      return resolvers.resolveCredential(args);
    case 'credentials':
      return resolvers.resolveCredentials(args);
    case 'slice':
      return resolvers.resolveSlice(args);
    case 'attestorReputation':
      return resolvers.resolveAttestorReputation(args);
    case 'credentialTier':
      return resolvers.resolveCredentialTier(args);
    case 'credentialRewards':
      return resolvers.resolveCredentialRewards(args);
    case 'rewardsSummary':
      return resolvers.resolveRewardsSummary(args);
    default:
      throw new Error(`unsupported bulk operation: ${type}`);
  }
}
