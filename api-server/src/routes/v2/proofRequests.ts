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
 *   - Pagination uses `cursor` (not `next_cursor`).
 *   - Errors follow RFC 9457 Problem Details.
 */

import { Router, Request, Response } from 'express';
import { randomBytes } from 'crypto';
import { problemJson } from '../../middleware/problemDetails.js';

const router = Router();

// ---------------------------------------------------------------------------
// In-process store (demonstrable, testable without a live DB in this sprint).
// A follow-up issue can migrate this to Postgres using the same pattern as
// recovery.ts (Issue #1429).
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

// Keyed by id
const store = new Map<string, ProofRequest>();

function newId(): string {
  return randomBytes(8).toString('hex');
}

// ---------------------------------------------------------------------------
// POST /api/v2/proof-requests
// ---------------------------------------------------------------------------
router.post('/', (req: Request, res: Response) => {
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
  const now = new Date();
  const expiresAt = new Date(now.getTime() + 24 * 60 * 60 * 1000); // 24 h TTL

  const proofRequest: ProofRequest = {
    id,
    credential_id,
    claim_type: claim_type.trim(),
    requester: requester.trim(),
    created_at: now.toISOString(),
    expires_at: expiresAt.toISOString(),
    status: 'pending',
    proof: null,
  };

  store.set(id, proofRequest);
  res.status(201).json(proofRequest);
});

// ---------------------------------------------------------------------------
// GET /api/v2/proof-requests?status=pending&cursor=<opaque>&limit=20
// ---------------------------------------------------------------------------
router.get('/', (req: Request, res: Response) => {
  const statusFilter = typeof req.query.status === 'string' ? req.query.status : undefined;
  const limit = Math.min(parseInt((req.query.limit as string) ?? '20', 10) || 20, 100);
  const cursorParam = typeof req.query.cursor === 'string' ? req.query.cursor : undefined;

  let items = Array.from(store.values()).sort(
    (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
  );

  if (statusFilter) {
    items = items.filter((r) => r.status === statusFilter);
  }

  // Decode cursor (opaque base64 → index offset)
  let offset = 0;
  if (cursorParam) {
    try {
      offset = parseInt(Buffer.from(cursorParam, 'base64').toString('utf8'), 10) || 0;
    } catch {
      // Ignore malformed cursor
    }
  }

  const page = items.slice(offset, offset + limit);
  const nextOffset = offset + limit;
  const cursor = nextOffset < items.length
    ? Buffer.from(String(nextOffset)).toString('base64')
    : null;

  res.json({
    items: page,
    total: items.length,
    limit,
    cursor,  // v2: renamed from next_cursor
  });
});

// ---------------------------------------------------------------------------
// GET /api/v2/proof-requests/:id
// ---------------------------------------------------------------------------
router.get('/:id', (req: Request, res: Response) => {
  const item = store.get(req.params.id);
  if (!item) {
    res.status(404).json(problemJson(404, 'not-found', `Proof request "${req.params.id}" not found`));
    return;
  }
  res.json(item);
});

// ---------------------------------------------------------------------------
// DELETE /api/v2/proof-requests/:id — cancel
// ---------------------------------------------------------------------------
router.delete('/:id', (req: Request, res: Response) => {
  const item = store.get(req.params.id);
  if (!item) {
    res.status(404).json(problemJson(404, 'not-found', `Proof request "${req.params.id}" not found`));
    return;
  }
  if (item.status !== 'pending') {
    res.status(409).json(problemJson(409, 'invalid-state', `Cannot cancel a proof request with status "${item.status}"`));
    return;
  }
  item.status = 'cancelled';
  res.json(item);
});

/** Exposed for testing. */
export { store as _proofRequestStore };
export default router;
