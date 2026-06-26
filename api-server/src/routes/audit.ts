import { Router, Request, Response } from 'express';
import type { simulateCall as SimulateCallType } from '../soroban.js';
import {
  exportAuditLogs,
  verifyMerkleRoot,
  validateLogIntegrity,
} from '../services/audit.js';
import { validate, schemas } from '../middleware/validate.js';

export type SorobanClient = {
  simulateCall: typeof SimulateCallType;
  u64Val: (n: number | bigint) => ReturnType<typeof SimulateCallType>;
  u32Val: (n: number) => ReturnType<typeof SimulateCallType>;
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

// AuditAction enum values matching the Soroban contract.
const ACTION_VALUES: Record<string, number> = {
  CredentialIssued: 1,
  CredentialRevoked: 2,
  CredentialAttested: 3,
  CredentialSuspended: 4,
  CredentialRenewed: 5,
  SbtMinted: 6,
  SbtBurned: 7,
};

export function createAuditRouter(soroban: SorobanClient) {
  const router = Router();

  /**
   * GET /api/audit/entries
   * Paginated audit log entries with optional filtering.
   * Query params:
   *   - from_id: starting entry id (default: 1)
   *   - limit: max entries to return (default: 20, max: 100)
   *   - credential_id: filter by credential id
   *   - action: filter by action name (e.g. CredentialIssued)
   */
  router.get('/entries', async (req: Request, res: Response) => {
    const fromId = Math.max(1, parseInt(String(req.query.from_id ?? '1'), 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(String(req.query.limit ?? '20'), 10) || 20));
    const credentialId = req.query.credential_id ? parseInt(String(req.query.credential_id), 10) : null;
    const action = req.query.action ? String(req.query.action) : null;

    try {
      if (credentialId !== null && Number.isInteger(credentialId) && credentialId > 0) {
        // Filter by credential_id.
        const entries = await soroban.simulateCall('get_entries_for_credential', [
          soroban.u64Val(credentialId),
        ]);
        res.json({ data: serializeBigInt(entries) });
        return;
      }

      if (action !== null) {
        const actionNum = ACTION_VALUES[action];
        if (!actionNum) {
          res.status(400).json({ error: `Unknown action: ${action}. Valid values: ${Object.keys(ACTION_VALUES).join(', ')}` });
          return;
        }
        // Filter by action type.
        const entries = await soroban.simulateCall('get_entries_by_action', [
          { u32: actionNum },
          soroban.u64Val(fromId),
          soroban.u32Val(limit),
        ]);
        res.json({ data: serializeBigInt(entries) });
        return;
      }

      // Paginated fetch.
      const entries = await soroban.simulateCall('get_entries', [
        soroban.u64Val(fromId),
        soroban.u32Val(limit),
      ]);
      const total = await soroban.simulateCall('get_entry_count', []);
      res.json({
        data: serializeBigInt(entries),
        pagination: { from_id: fromId, limit, total: serializeBigInt(total) },
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: msg });
    }
  });

  /**
   * GET /api/audit/entries/:id
   * Fetch a single audit entry by id.
   */
  router.get('/entries/:id', async (req: Request, res: Response) => {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id) || id <= 0) {
      res.status(400).json({ error: 'Invalid entry ID' });
      return;
    }
    try {
      const entry = await soroban.simulateCall('get_entry', [soroban.u64Val(id)]);
      res.json(serializeBigInt(entry));
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('EntryNotFound') || msg.includes('not found')) {
        res.status(404).json({ error: 'Audit entry not found' });
      } else {
        res.status(500).json({ error: msg });
      }
    }
  });

  /**
   * GET /api/audit/notarizations/:batch_id
   * Fetch a notarization record by batch id.
   */
  router.get('/notarizations/:batch_id', async (req: Request, res: Response) => {
    const batchId = parseInt(req.params.batch_id, 10);
    if (!Number.isInteger(batchId) || batchId <= 0) {
      res.status(400).json({ error: 'Invalid batch ID' });
      return;
    }
    try {
      const record = await soroban.simulateCall('get_notarization', [soroban.u64Val(batchId)]);
      res.json(serializeBigInt(record));
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('EntryNotFound') || msg.includes('not found')) {
        res.status(404).json({ error: 'Notarization record not found' });
      } else {
        res.status(500).json({ error: msg });
      }
    }
  });

  /**
   * GET /api/audit/stats
   * Returns total entry count and batch count.
   */
  router.get('/stats', async (_req: Request, res: Response) => {
    try {
      const [entryCount, batchCount] = await Promise.all([
        soroban.simulateCall('get_entry_count', []),
        soroban.simulateCall('get_batch_count', []),
      ]);
      res.json({
        entry_count: serializeBigInt(entryCount),
        batch_count: serializeBigInt(batchCount),
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: msg });
    }
  });

  /**
   * GET /api/audit/export
   * Export audit logs in JSON Lines or JSON format for compliance audits.
   * Query params:
   *   - format: 'jsonl' (default) or 'json'
   *   - credential_id: optional filter by credential
   *   - action: optional filter by action type
   */
  router.get('/export', async (req: Request, res: Response) => {
    const format = (req.query.format as string) === 'json' ? 'json' : 'jsonl';
    const credentialId = req.query.credential_id ? parseInt(String(req.query.credential_id), 10) : null;
    const action = req.query.action ? String(req.query.action) : null;

    try {
      let entries;
      if (credentialId !== null && Number.isInteger(credentialId) && credentialId > 0) {
        entries = await soroban.simulateCall('get_entries_for_credential', [
          soroban.u64Val(credentialId),
        ]);
      } else if (action !== null) {
        const actionNum = ACTION_VALUES[action];
        if (!actionNum) {
          res.status(400).json({ error: `Unknown action: ${action}` });
          return;
        }
        entries = await soroban.simulateCall('get_entries_by_action', [
          { u32: actionNum },
          soroban.u64Val(1),
          soroban.u32Val(1000),
        ]);
      } else {
        entries = await soroban.simulateCall('get_entries', [
          soroban.u64Val(1),
          soroban.u32Val(1000),
        ]);
      }

      const exported = exportAuditLogs(entries as never[], format);
      res.setHeader('Content-Type', format === 'json' ? 'application/json' : 'text/plain');
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="audit-export-${Date.now()}.${format === 'json' ? 'json' : 'jsonl'}"`
      );
      res.send(exported);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: msg });
    }
  });

  /**
   * POST /api/audit/verify
   * Verify Merkle root integrity for a batch of entries.
   * Body: { batch_id: number }
   */
  router.post('/verify', validate(schemas.auditVerify), async (req: Request, res: Response) => {
    const batchId = req.body.batch_id as number;

    try {
      const notarization = await soroban.simulateCall('get_notarization', [soroban.u64Val(batchId)]);
      const entries = await soroban.simulateCall('get_entries', [
        soroban.u64Val((notarization as Record<string, unknown>).first_entry_id),
        soroban.u32Val((notarization as Record<string, unknown>).entry_count as number),
      ]);

      const valid = verifyMerkleRoot(entries as never[], notarization as never);
      res.json({
        batch_id: batchId,
        valid,
        merkle_root: (notarization as Record<string, unknown>).merkle_root,
        entry_count: (notarization as Record<string, unknown>).entry_count,
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: msg });
    }
  });

  /**
   * GET /api/audit/integrity
   * Validate overall log integrity (sequential IDs, monotonic timestamps).
   */
  router.get('/integrity', async (_req: Request, res: Response) => {
    try {
      const [entryCount, entries, batchCount] = await Promise.all([
        soroban.simulateCall('get_entry_count', []),
        soroban.simulateCall('get_entries', [soroban.u64Val(1), soroban.u32Val(1000)]),
        soroban.simulateCall('get_batch_count', []),
      ]);

      const notarizations = [];
      for (let i = 1; i <= Math.min(10, Number(batchCount as bigint)); i++) {
        try {
          const record = await soroban.simulateCall('get_notarization', [soroban.u64Val(i)]);
          notarizations.push(record);
        } catch {
          // Skip if not found
        }
      }

      const result = validateLogIntegrity(entries as never[], notarizations as never[]);
      res.json({
        total_entries: serializeBigInt(entryCount),
        validation_result: result,
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: msg });
    }
  });

  return router;
}

// Default export using real soroban client.
import { simulateCall, u64Val, u32Val } from '../soroban.js';
export default createAuditRouter({ simulateCall, u64Val: u64Val as SorobanClient['u64Val'], u32Val: u32Val as SorobanClient['u32Val'] });
