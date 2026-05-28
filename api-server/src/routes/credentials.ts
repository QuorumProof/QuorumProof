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

type CredentialRecord = {
  id: string;
  subject: string;
  issuer: string;
  credential_type: number;
  metadata_hash: string;
  revoked: boolean;
  suspended: boolean;
  expires_at: string | null;
  version: number;
};

export function createCredentialsRouter(soroban: SorobanClient) {
  const router = Router();

  /**
   * GET /api/credentials/search
   * Query params: type, issuer, subject, status (active|revoked|suspended),
   *               page, page_size, sort_by (id|type), sort_order (asc|desc)
   */
  router.get('/search', async (req: Request, res: Response) => {
    const {
      type,
      issuer,
      subject,
      status,
      page: pageQ = '1',
      page_size: pageSizeQ = '20',
      sort_by: sortBy = 'id',
      sort_order: sortOrder = 'asc',
    } = req.query as Record<string, string>;

    const page = Math.max(1, parseInt(pageQ, 10) || 1);
    const pageSize = Math.min(100, Math.max(1, parseInt(pageSizeQ, 10) || 20));

    if (sortBy && !['id', 'type'].includes(sortBy)) {
      res.status(400).json({ error: 'sort_by must be "id" or "type"' });
      return;
    }
    if (sortOrder && !['asc', 'desc'].includes(sortOrder)) {
      res.status(400).json({ error: 'sort_order must be "asc" or "desc"' });
      return;
    }

    try {
      const credCount: bigint = await soroban.simulateCall('get_credential_count', []);
      const total = Number(credCount);

      // Fetch all credentials and filter in-memory
      // (On-chain filtering is not supported; this is a read-only query layer)
      const all: CredentialRecord[] = [];
      for (let i = 1; i <= total; i++) {
        try {
          const cred = await soroban.simulateCall('get_credential', [soroban.u64Val(i)]);
          all.push(serializeBigInt(cred) as CredentialRecord);
        } catch {
          // skip missing/expired credentials
        }
      }

      // Filter
      let filtered = all.filter((c) => {
        if (type !== undefined && c.credential_type !== parseInt(type, 10)) return false;
        if (issuer !== undefined && c.issuer !== issuer) return false;
        if (subject !== undefined && c.subject !== subject) return false;
        if (status === 'revoked' && !c.revoked) return false;
        if (status === 'suspended' && !c.suspended) return false;
        if (status === 'active' && (c.revoked || c.suspended)) return false;
        return true;
      });

      // Sort
      filtered.sort((a, b) => {
        const aVal = sortBy === 'type' ? a.credential_type : parseInt(a.id, 10);
        const bVal = sortBy === 'type' ? b.credential_type : parseInt(b.id, 10);
        return sortOrder === 'desc' ? bVal - aVal : aVal - bVal;
      });

      const totalFiltered = filtered.length;
      const start = (page - 1) * pageSize;
      const data = filtered.slice(start, start + pageSize);

      res.json({
        data,
        pagination: { page, page_size: pageSize, total: totalFiltered },
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: msg });
    }
  });

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
