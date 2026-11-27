/**
 * v2 Proof-Requests route handler (Issue #1427).
 *
 * Manages the lifecycle of ZK proof-requests:
 *   POST   /api/v2/proof-requests          — create a new proof-request
 *   GET    /api/v2/proof-requests          — list proof-requests (paginated)
 *   GET    /api/v2/proof-requests/:id      — fetch a single proof-request
 *   DELETE /api/v2/proof-requests/:id      — cancel / expire a proof-request
 *
 * v2 response contract:
 *   - No { ok, version, data } envelope — raw resource objects returned directly.
 *   - Field names use snake_case throughout.
 *   - Pagination uses `cursor` (keyed on created_at + id, not an offset).
 *   - Errors follow RFC 9457 Problem Details.
 *
 * Storage: Postgres via getPool() (Issue #1958).
 * Migrated from an in-process Map following the pattern used by recovery.ts (#1429).
 */

import { Router, Request, Response } from 'express';
import { randomBytes } from 'crypto';
import { problemJson } from '../../middleware/problemDetails.js';
import { getPool } from '../../db.js';
import { validate, schemas } from '../../middleware/validate.js';

const router = Router();

export const proofRequestCreateSchema = schemas.proofRequestCreate;
export const proofRequestParamsSchema = schemas.proofRequestParams;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ProofRequest {
  id: string;
  credential_id: number;
  claim_type: string;
  requester: string;         // Stellar address of the verifier
  /** ISO-8601 */
  created_at: string;
  /** ISO-8601 */
  expires_at: string;
  status: 'pending' | 'fulfilled' | 'expired' | 'cancelled';
  /** Base64-encoded opaque proof blob when fulfilled */
  proof?: string | null;
}

function newId(): string {
  return randomBytes(8).toString('hex');
}

function rowToProofRequest(row: any): ProofRequest {
  return {
    id: row.id,
    credential_id: Number(row.credential_id),
    claim_type: row.claim_type,
    requester: row.requester,
    created_at: row.created_at instanceof Date
      ? row.created_at.toISOString()
      : String(row.created_at),
    expires_at: row.expires_at instanceof Date
      ? row.expires_at.toISOString()
      : String(row.expires_at),
    status: row.status as ProofRequest['status'],
    proof: row.proof ?? null,
  };
}

// ---------------------------------------------------------------------------
// POST /api/v2/proof-requests
// ---------------------------------------------------------------------------
router.post(
  '/',
  validate(proofRequestCreateSchema, { coerceTypes: false }),
  async (req: Request, res: Response) => {
    const { credential_id, claim_type, requester } = req.body as {
      credential_id?: unknown;
      claim_type?: unknown;
      requester?: unknown;
    };

    if (typeof credential_id !== 'number' || !Number.isInteger(credential_id) || credential_id < 1) {
      res.status(400).json(problemJson(400, 'missing-parameter', 'credential_id must be a positive integer'));
      return;
    }
    if (typeof claim_type !== 'string' || !claim_type.trim()) {
      res.status(400).json(problemJson(400, 'missing-parameter', 'claim_type is required'));
      return;
    }
    if (typeof requester !== 'string' || !requester.trim()) {
      res.status(400).json(problemJson(400, 'missing-parameter', 'requester is required'));
      return;
    }

    const id = newId();
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24 h TTL

    const { rows } = await getPool().query<any>(
      `INSERT INTO proof_requests (id, credential_id, claim_type, requester, expires_at)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, credential_id, claim_type, requester, created_at, expires_at, status, proof`,
      [id, credential_id, claim_type.trim(), requester.trim(), expiresAt.toISOString()],
    );

    res.status(201).json(rowToProofRequest(rows[0]));
  },
);

// ---------------------------------------------------------------------------
// GET /api/v2/proof-requests?status=pending&cursor=<opaque>&limit=20
//
// Cursor-based pagination keyed on (created_at DESC, id ASC) so that the
// page boundary is stable under concurrent inserts.
// ---------------------------------------------------------------------------
router.get('/', async (req: Request, res: Response) => {
  const statusFilter = typeof req.query.status === 'string' ? req.query.status : undefined;
  const limit = Math.min(parseInt((req.query.limit as string) ?? '20', 10) || 20, 100);
  const cursorParam = typeof req.query.cursor === 'string' ? req.query.cursor : undefined;

  // Decode cursor: { created_at: string, id: string }
  let cursorCreatedAt: string | null = null;
  let cursorId: string | null = null;
  if (cursorParam) {
    try {
      const decoded = JSON.parse(Buffer.from(cursorParam, 'base64url').toString('utf8'));
      cursorCreatedAt = decoded.created_at ?? null;
      cursorId = decoded.id ?? null;
    } catch {
      // Ignore malformed cursor — start from the beginning.
    }
  }

  const queryParams: any[] = [];
  const conditions: string[] = [];

  if (statusFilter) {
    queryParams.push(statusFilter);
    conditions.push(`status = $${queryParams.length}`);
  }

  if (cursorCreatedAt && cursorId) {
    queryParams.push(cursorCreatedAt, cursorId);
    const p1 = queryParams.length - 1;
    const p2 = queryParams.length;
    conditions.push(`(created_at < $${p1} OR (created_at = $${p1} AND id > $${p2}))`);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  queryParams.push(limit + 1);

  const { rows } = await getPool().query<any>(
    `SELECT id, credential_id, claim_type, requester, created_at, expires_at, status, proof
     FROM proof_requests
     ${where}
     ORDER BY created_at DESC, id ASC
     LIMIT $${queryParams.length}`,
    queryParams,
  );

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;

  let cursor: string | null = null;
  if (hasMore) {
    const last = page[page.length - 1];
    const payload = JSON.stringify({
      created_at: last.created_at instanceof Date ? last.created_at.toISOString() : String(last.created_at),
      id: last.id,
    });
    cursor = Buffer.from(payload).toString('base64url');
  }

  // Total count (filtered by status only, not cursor) for informational purposes.
  const countParams: any[] = [];
  const countConditions: string[] = [];
  if (statusFilter) {
    countParams.push(statusFilter);
    countConditions.push(`status = $${countParams.length}`);
  }
  const countWhere = countConditions.length > 0 ? `WHERE ${countConditions.join(' AND ')}` : '';
  const { rows: countRows } = await getPool().query<any>(
    `SELECT COUNT(*)::int AS total FROM proof_requests ${countWhere}`,
    countParams,
  );

  res.json({
    items: page.map(rowToProofRequest),
    total: countRows[0].total,
    limit,
    cursor,
  });
});

// ---------------------------------------------------------------------------
// GET /api/v2/proof-requests/:id
// ---------------------------------------------------------------------------
router.get('/:id', async (req: Request, res: Response) => {
  const { rows } = await getPool().query<any>(
    'SELECT id, credential_id, claim_type, requester, created_at, expires_at, status, proof FROM proof_requests WHERE id = $1',
    [req.params.id],
  );
  if (rows.length === 0) {
    res.status(404).json(problemJson(404, 'not-found', `Proof request "${req.params.id}" not found`));
    return;
  }
  res.json(rowToProofRequest(rows[0]));
});

// ---------------------------------------------------------------------------
// DELETE /api/v2/proof-requests/:id — cancel
// ---------------------------------------------------------------------------
router.delete(
  '/:id',
  validate(proofRequestParamsSchema, { coerceTypes: false }),
  async (req: Request, res: Response) => {
    const { rows } = await getPool().query<any>(
      'SELECT id, credential_id, claim_type, requester, created_at, expires_at, status, proof FROM proof_requests WHERE id = $1',
      [req.params.id],
    );
    if (rows.length === 0) {
      res.status(404).json(problemJson(404, 'not-found', `Proof request "${req.params.id}" not found`));
      return;
    }
    const item = rowToProofRequest(rows[0]);
    if (item.status !== 'pending') {
      res.status(409).json(problemJson(409, 'invalid-state', `Cannot cancel a proof request with status "${item.status}"`));
      return;
    }

    const { rows: updated } = await getPool().query<any>(
      `UPDATE proof_requests SET status = 'cancelled' WHERE id = $1
       RETURNING id, credential_id, claim_type, requester, created_at, expires_at, status, proof`,
      [req.params.id],
    );
    res.json(rowToProofRequest(updated[0]));
  },
);

export default router;
