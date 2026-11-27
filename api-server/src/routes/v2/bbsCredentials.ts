/**
 * v2 BBS+ Credentials route handler (Issue #1427).
 *
 * Selective-disclosure credential issuance and verification via BBS+:
 *   POST   /api/v2/bbs-credentials              — issue a new BBS+ credential
 *   GET    /api/v2/bbs-credentials              — list issued credentials (paginated)
 *   GET    /api/v2/bbs-credentials/:id          — fetch a single BBS+ credential
 *   POST   /api/v2/bbs-credentials/:id/present  — create a selective-disclosure presentation
 *
 * v2 response contract:
 *   - No { ok, version, data } envelope.
 *   - Field renames: `metadata` → `metadata_hash`, `address` → `stellar_address`.
 *   - Pagination uses `cursor` (opaque, keyed by issued_at + id).
 *   - Errors follow RFC 9457 Problem Details.
 *
 * Storage: Postgres via getPool() (Issue #1957).
 * Migrated from an in-process Map following the pattern used by recovery.ts (#1429).
 */

import { Router, Request, Response } from 'express';
import { randomBytes } from 'crypto';
import { problemJson } from '../../middleware/problemDetails.js';
import { getPool } from '../../db.js';

const router = Router();

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface BbsCredential {
  id: string;
  /** v2 renamed field: was `address` in v1 */
  stellar_address: string;
  claim_type: string;
  /** v2 renamed field: was `metadata` in v1 */
  metadata_hash: string;
  issued_at: string;   // ISO-8601
  /** BBS+ public key of the issuer */
  issuer_key: string;
  status: 'active' | 'revoked';
  /** Base64-encoded BBS+ signature */
  signature: string;
}

function newId(): string {
  return randomBytes(8).toString('hex');
}

function stubSignature(): string {
  // Stub: in production this would be a real BBS+ signature from the
  // bbs_plus_v1 contract.
  return randomBytes(32).toString('base64');
}

function rowToCredential(row: any): BbsCredential {
  return {
    id: row.id,
    stellar_address: row.stellar_address,
    claim_type: row.claim_type,
    metadata_hash: row.metadata_hash,
    issued_at: row.issued_at instanceof Date
      ? row.issued_at.toISOString()
      : String(row.issued_at),
    issuer_key: row.issuer_key,
    status: row.status as 'active' | 'revoked',
    signature: row.signature,
  };
}

// ---------------------------------------------------------------------------
// POST /api/v2/bbs-credentials
// Body: { stellar_address, claim_type, metadata_hash, issuer_key }
// ---------------------------------------------------------------------------
router.post('/', async (req: Request, res: Response) => {
  const { stellar_address, claim_type, metadata_hash, issuer_key } = req.body as {
    stellar_address?: unknown;
    claim_type?: unknown;
    metadata_hash?: unknown;
    issuer_key?: unknown;
  };

  if (typeof stellar_address !== 'string' || !stellar_address.trim()) {
    res.status(400).json(problemJson(400, 'missing-parameter', 'stellar_address is required'));
    return;
  }
  if (typeof claim_type !== 'string' || !claim_type.trim()) {
    res.status(400).json(problemJson(400, 'missing-parameter', 'claim_type is required'));
    return;
  }
  if (typeof metadata_hash !== 'string' || !metadata_hash.trim()) {
    res.status(400).json(problemJson(400, 'missing-parameter', 'metadata_hash is required'));
    return;
  }
  if (typeof issuer_key !== 'string' || !issuer_key.trim()) {
    res.status(400).json(problemJson(400, 'missing-parameter', 'issuer_key is required'));
    return;
  }

  const id = newId();
  const signature = stubSignature();

  const { rows } = await getPool().query<any>(
    `INSERT INTO bbs_credentials (id, stellar_address, claim_type, metadata_hash, issuer_key, signature)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id, stellar_address, claim_type, metadata_hash, issued_at, issuer_key, status, signature`,
    [id, stellar_address.trim(), claim_type.trim(), metadata_hash.trim(), issuer_key.trim(), signature],
  );

  res.status(201).json(rowToCredential(rows[0]));
});

// ---------------------------------------------------------------------------
// GET /api/v2/bbs-credentials?stellar_address=<addr>&cursor=<opaque>&limit=20
//
// Cursor-based pagination keyed on (issued_at DESC, id).
// The cursor encodes the last-seen issued_at and id as base64 JSON so that
// it stays stable across concurrent inserts, unlike offset-based pagination.
// ---------------------------------------------------------------------------
router.get('/', async (req: Request, res: Response) => {
  const addressFilter = typeof req.query.stellar_address === 'string' ? req.query.stellar_address : undefined;
  const limit = Math.min(parseInt((req.query.limit as string) ?? '20', 10) || 20, 100);
  const cursorParam = typeof req.query.cursor === 'string' ? req.query.cursor : undefined;

  // Decode cursor: { issued_at: string, id: string }
  let cursorIssuedAt: string | null = null;
  let cursorId: string | null = null;
  if (cursorParam) {
    try {
      const decoded = JSON.parse(Buffer.from(cursorParam, 'base64url').toString('utf8'));
      cursorIssuedAt = decoded.issued_at ?? null;
      cursorId = decoded.id ?? null;
    } catch {
      // Ignore malformed cursor — start from the beginning.
    }
  }

  // Build the query. We fetch limit + 1 to determine whether a next page exists.
  const queryParams: any[] = [];
  const conditions: string[] = [];

  if (addressFilter) {
    queryParams.push(addressFilter);
    conditions.push(`stellar_address = $${queryParams.length}`);
  }

  if (cursorIssuedAt && cursorId) {
    queryParams.push(cursorIssuedAt, cursorId);
    const p1 = queryParams.length - 1;
    const p2 = queryParams.length;
    // Rows that come after the cursor in (issued_at DESC, id ASC) order.
    conditions.push(`(issued_at < $${p1} OR (issued_at = $${p1} AND id > $${p2}))`);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  queryParams.push(limit + 1);

  const { rows } = await getPool().query<any>(
    `SELECT id, stellar_address, claim_type, metadata_hash, issued_at, issuer_key, status, signature
     FROM bbs_credentials
     ${where}
     ORDER BY issued_at DESC, id ASC
     LIMIT $${queryParams.length}`,
    queryParams,
  );

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;

  let cursor: string | null = null;
  if (hasMore) {
    const last = page[page.length - 1];
    const cursorPayload = JSON.stringify({
      issued_at: last.issued_at instanceof Date ? last.issued_at.toISOString() : String(last.issued_at),
      id: last.id,
    });
    cursor = Buffer.from(cursorPayload).toString('base64url');
  }

  // Total count (without cursor/limit filters) for informational purposes.
  const countParams: any[] = [];
  const countConditions: string[] = [];
  if (addressFilter) {
    countParams.push(addressFilter);
    countConditions.push(`stellar_address = $${countParams.length}`);
  }
  const countWhere = countConditions.length > 0 ? `WHERE ${countConditions.join(' AND ')}` : '';
  const { rows: countRows } = await getPool().query<any>(
    `SELECT COUNT(*)::int AS total FROM bbs_credentials ${countWhere}`,
    countParams,
  );

  res.json({
    items: page.map(rowToCredential),
    total: countRows[0].total,
    limit,
    cursor,
  });
});

// ---------------------------------------------------------------------------
// GET /api/v2/bbs-credentials/:id
// ---------------------------------------------------------------------------
router.get('/:id', async (req: Request, res: Response) => {
  const { rows } = await getPool().query<any>(
    'SELECT id, stellar_address, claim_type, metadata_hash, issued_at, issuer_key, status, signature FROM bbs_credentials WHERE id = $1',
    [req.params.id],
  );
  if (rows.length === 0) {
    res.status(404).json(problemJson(404, 'not-found', `BBS+ credential "${req.params.id}" not found`));
    return;
  }
  res.json(rowToCredential(rows[0]));
});

// ---------------------------------------------------------------------------
// POST /api/v2/bbs-credentials/:id/present
// Body: { disclosed_attributes: string[] }
// Returns a selective-disclosure presentation (stub)
// ---------------------------------------------------------------------------
router.post('/:id/present', async (req: Request, res: Response) => {
  const { rows } = await getPool().query<any>(
    'SELECT id, stellar_address, claim_type, metadata_hash, issued_at, issuer_key, status, signature FROM bbs_credentials WHERE id = $1',
    [req.params.id],
  );
  if (rows.length === 0) {
    res.status(404).json(problemJson(404, 'not-found', `BBS+ credential "${req.params.id}" not found`));
    return;
  }
  const credential = rowToCredential(rows[0]);
  if (credential.status !== 'active') {
    res.status(409).json(problemJson(409, 'credential-not-active', `Cannot present a credential with status "${credential.status}"`));
    return;
  }

  const { disclosed_attributes } = req.body as { disclosed_attributes?: unknown };
  if (!Array.isArray(disclosed_attributes) || disclosed_attributes.length === 0) {
    res.status(400).json(problemJson(400, 'missing-parameter', 'disclosed_attributes must be a non-empty array'));
    return;
  }

  // Stub: real presentation would invoke the bbs_plus_v1 contract's
  // derive_proof() function. Tracked in the ZK-IMPL issue.
  const presentation = {
    credential_id: credential.id,
    stellar_address: credential.stellar_address,
    claim_type: credential.claim_type,
    disclosed_attributes,
    presentation_proof: randomBytes(64).toString('base64'),
    created_at: new Date().toISOString(),
  };

  res.status(201).json(presentation);
});

export default router;
