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
 *   - Pagination uses `cursor` (not `next_cursor`).
 *   - Errors follow RFC 9457 Problem Details.
 */

import { Router, Request, Response } from 'express';
import { randomBytes } from 'crypto';
import { problemJson } from '../../middleware/problemDetails.js';

const router = Router();

// ---------------------------------------------------------------------------
// In-process store (testable without a live DB in this sprint).
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

const bbsStore = new Map<string, BbsCredential>();

function newId(): string {
  return randomBytes(8).toString('hex');
}

function stubSignature(): string {
  // Stub: in production this would be a real BBS+ signature from the
  // bbs_plus_v1 contract.
  return randomBytes(32).toString('base64');
}

// ---------------------------------------------------------------------------
// POST /api/v2/bbs-credentials
// Body: { stellar_address, claim_type, metadata_hash, issuer_key }
// ---------------------------------------------------------------------------
router.post('/', (req: Request, res: Response) => {
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
  const credential: BbsCredential = {
    id,
    stellar_address: stellar_address.trim(),
    claim_type: claim_type.trim(),
    metadata_hash: metadata_hash.trim(),
    issued_at: new Date().toISOString(),
    issuer_key: issuer_key.trim(),
    status: 'active',
    signature: stubSignature(),
  };

  bbsStore.set(id, credential);
  res.status(201).json(credential);
});

// ---------------------------------------------------------------------------
// GET /api/v2/bbs-credentials?stellar_address=<addr>&cursor=<opaque>&limit=20
// ---------------------------------------------------------------------------
router.get('/', (req: Request, res: Response) => {
  const addressFilter = typeof req.query.stellar_address === 'string' ? req.query.stellar_address : undefined;
  const limit = Math.min(parseInt((req.query.limit as string) ?? '20', 10) || 20, 100);
  const cursorParam = typeof req.query.cursor === 'string' ? req.query.cursor : undefined;

  let items = Array.from(bbsStore.values()).sort(
    (a, b) => new Date(b.issued_at).getTime() - new Date(a.issued_at).getTime(),
  );

  if (addressFilter) {
    items = items.filter((c) => c.stellar_address === addressFilter);
  }

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
    cursor, // v2: renamed from next_cursor
  });
});

// ---------------------------------------------------------------------------
// GET /api/v2/bbs-credentials/:id
// ---------------------------------------------------------------------------
router.get('/:id', (req: Request, res: Response) => {
  const credential = bbsStore.get(req.params.id);
  if (!credential) {
    res.status(404).json(problemJson(404, 'not-found', `BBS+ credential "${req.params.id}" not found`));
    return;
  }
  res.json(credential);
});

// ---------------------------------------------------------------------------
// POST /api/v2/bbs-credentials/:id/present
// Body: { disclosed_attributes: string[] }
// Returns a selective-disclosure presentation (stub)
// ---------------------------------------------------------------------------
router.post('/:id/present', (req: Request, res: Response) => {
  const credential = bbsStore.get(req.params.id);
  if (!credential) {
    res.status(404).json(problemJson(404, 'not-found', `BBS+ credential "${req.params.id}" not found`));
    return;
  }
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

/** Exposed for testing. */
export { bbsStore as _bbsStore };
export default router;
