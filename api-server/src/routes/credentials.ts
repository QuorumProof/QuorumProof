import { Router, Request, Response } from 'express';
import type { simulateCall as SimulateCallType } from '../soroban.js';

export type SorobanClient = {
  simulateCall: typeof SimulateCallType;
  u64Val: (n: number | bigint) => ReturnType<typeof SimulateCallType>;
  u32Val: (n: number) => ReturnType<typeof SimulateCallType>;
  addressVal: (a: string) => ReturnType<typeof SimulateCallType>;
};

/** Recursively convert BigInt values to strings for JSON serialization. */
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

export function createCredentialsRouter(soroban: SorobanClient) {
  const router = Router();

  /**
   * POST /api/credentials/verify-batch
   * Body: { credential_ids: number[], slice_id: number }
   * Returns array of { credential_id, attested } results.
   */
  router.post('/verify-batch', async (req: Request, res: Response) => {
    const { credential_ids, slice_id } = req.body as {
      credential_ids?: unknown;
      slice_id?: unknown;
    };

    if (!Array.isArray(credential_ids) || credential_ids.length === 0) {
      res.status(400).json({ error: 'credential_ids must be a non-empty array' });
      return;
    }
    if (typeof slice_id !== 'number' || !Number.isInteger(slice_id) || slice_id <= 0) {
      res.status(400).json({ error: 'slice_id must be a positive integer' });
      return;
    }
    if (credential_ids.length > 50) {
      res.status(400).json({ error: 'credential_ids cannot exceed 50 items' });
      return;
    }
    for (const id of credential_ids) {
      if (typeof id !== 'number' || !Number.isInteger(id) || id <= 0) {
        res.status(400).json({ error: `Invalid credential_id: ${id}` });
        return;
      }
    }

    const results = await Promise.all(
      (credential_ids as number[]).map(async (credential_id) => {
        try {
          const attested: boolean = await soroban.simulateCall('is_attested', [
            soroban.u64Val(credential_id),
            soroban.u64Val(slice_id),
          ]);
          return { credential_id, attested: Boolean(attested), error: null };
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          return { credential_id, attested: false, error: msg };
        }
      })
    );

    res.json({ results: serializeBigInt(results) });
  });

  return router;
}

// Default export using real soroban client
import { simulateCall, u64Val, u32Val, addressVal } from '../soroban.js';
export default createCredentialsRouter({
  simulateCall,
  u64Val: u64Val as SorobanClient['u64Val'],
  u32Val: u32Val as SorobanClient['u32Val'],
  addressVal: addressVal as SorobanClient['addressVal'],
});
