/**
 * v2 Revocation-Registry route handler (Issue #1427).
 *
 * Batch-revocation with optional time-locks:
 *   POST  /api/v2/revocation-registry              — add credential(s) to the registry
 *   GET   /api/v2/revocation-registry              — list registry entries (paginated)
 *   GET   /api/v2/revocation-registry/:credentialId — check revocation status
 *   DELETE /api/v2/revocation-registry/:credentialId — un-revoke (if time-lock allows)
 *
 * v2 response contract:
 *   - No { ok, version, data } envelope.
 *   - Pagination uses `cursor` (not `next_cursor`).
 *   - Errors follow RFC 9457 Problem Details.
 */

import { Router, Request, Response } from 'express';
import { problemJson } from '../../middleware/problemDetails.js';

const router = Router();

// ---------------------------------------------------------------------------
// In-process registry store (testable without a live DB in this sprint).
// ---------------------------------------------------------------------------

export interface RevocationEntry {
  credential_id: number;
  revoked_by: string;        // Stellar address of the revoker
  reason?: string | null;
  /** ISO-8601 */
  revoked_at: string;
  /** ISO-8601 — if set, the entry cannot be removed before this time */
  locked_until?: string | null;
}

const registry = new Map<number, RevocationEntry>();

// ---------------------------------------------------------------------------
// POST /api/v2/revocation-registry
// Body: { entries: Array<{ credential_id, revoked_by, reason?, locked_until? }> }
// ---------------------------------------------------------------------------
router.post('/', (req: Request, res: Response) => {
  const { entries } = req.body as { entries?: unknown };

  if (!Array.isArray(entries) || entries.length === 0) {
    res.status(400).json(problemJson(400, 'missing-parameter', 'entries must be a non-empty array'));
    return;
  }

  const added: RevocationEntry[] = [];
  const skipped: number[] = [];

  for (const entry of entries) {
    const { credential_id, revoked_by, reason, locked_until } = entry as Record<string, unknown>;

    if (typeof credential_id !== 'number' || !Number.isInteger(credential_id) || credential_id < 1) {
      res.status(400).json(problemJson(400, 'invalid-parameter', 'Each entry must have a valid credential_id (positive integer)'));
      return;
    }
    if (typeof revoked_by !== 'string' || !revoked_by.trim()) {
      res.status(400).json(problemJson(400, 'missing-parameter', 'Each entry must have a revoked_by field'));
      return;
    }

    // Skip duplicates silently
    if (registry.has(credential_id)) {
      skipped.push(credential_id);
      continue;
    }

    const record: RevocationEntry = {
      credential_id,
      revoked_by: (revoked_by as string).trim(),
      reason: typeof reason === 'string' ? reason : null,
      revoked_at: new Date().toISOString(),
      locked_until: typeof locked_until === 'string' ? locked_until : null,
    };

    registry.set(credential_id, record);
    added.push(record);
  }

  res.status(201).json({ added, skipped, total_revoked: registry.size });
});

// ---------------------------------------------------------------------------
// GET /api/v2/revocation-registry?cursor=<opaque>&limit=20
// ---------------------------------------------------------------------------
router.get('/', (req: Request, res: Response) => {
  const limit = Math.min(parseInt((req.query.limit as string) ?? '20', 10) || 20, 100);
  const cursorParam = typeof req.query.cursor === 'string' ? req.query.cursor : undefined;

  const items = Array.from(registry.values()).sort(
    (a, b) => new Date(b.revoked_at).getTime() - new Date(a.revoked_at).getTime(),
  );

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
// GET /api/v2/revocation-registry/:credentialId
// ---------------------------------------------------------------------------
router.get('/:credentialId', (req: Request, res: Response) => {
  const id = parseInt(req.params.credentialId, 10);
  if (!Number.isInteger(id) || id < 1) {
    res.status(400).json(problemJson(400, 'invalid-parameter', 'credentialId must be a positive integer'));
    return;
  }

  const entry = registry.get(id);
  if (!entry) {
    res.status(200).json({ credential_id: id, revoked: false });
    return;
  }
  res.json({ ...entry, revoked: true });
});

// ---------------------------------------------------------------------------
// DELETE /api/v2/revocation-registry/:credentialId — un-revoke
// ---------------------------------------------------------------------------
router.delete('/:credentialId', (req: Request, res: Response) => {
  const id = parseInt(req.params.credentialId, 10);
  if (!Number.isInteger(id) || id < 1) {
    res.status(400).json(problemJson(400, 'invalid-parameter', 'credentialId must be a positive integer'));
    return;
  }

  const entry = registry.get(id);
  if (!entry) {
    res.status(404).json(problemJson(404, 'not-found', `Credential ${id} is not in the revocation registry`));
    return;
  }

  // Enforce time-lock
  if (entry.locked_until && new Date(entry.locked_until) > new Date()) {
    res.status(409).json(
      problemJson(409, 'time-lock-active', `Revocation entry for credential ${id} is locked until ${entry.locked_until}`),
    );
    return;
  }

  registry.delete(id);
  res.json({ credential_id: id, revoked: false, message: 'Credential removed from revocation registry' });
});

/** Exposed for testing. */
export { registry as _revocationRegistry };
export default router;
