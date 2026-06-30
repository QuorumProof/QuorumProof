import { Router, Request, Response } from 'express';
import type { simulateCall as SimulateCallType } from '../soroban.js';
import { getUsageReport } from '../analytics.js';

export type SorobanClient = {
  simulateCall: typeof SimulateCallType;
  u64Val: (n: number | bigint) => ReturnType<typeof SimulateCallType>;
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

type Credential = {
  id: string;
  subject: string;
  issuer: string;
  credential_type: number;
  revoked: boolean;
  suspended: boolean;
  expires_at: string | null;
};

export function createReportsRouter(soroban: SorobanClient) {
  const router = Router();

  /**
   * GET /api/reports/compliance
   * #582 — Monthly compliance report: audit trail completeness and gaps.
   * Query params: year (default current), month (default current, 1-12)
   */
  router.get('/compliance', async (req: Request, res: Response) => {
    const now = new Date();
    const year = parseInt(String(req.query.year ?? now.getUTCFullYear()), 10);
    const month = parseInt(String(req.query.month ?? now.getUTCMonth() + 1), 10);

    if (isNaN(year) || year < 2020 || year > 2100) {
      res.status(400).json({ error: 'year must be between 2020 and 2100' });
      return;
    }
    if (isNaN(month) || month < 1 || month > 12) {
      res.status(400).json({ error: 'month must be between 1 and 12' });
      return;
    }

    try {
      const credCount: bigint = await soroban.simulateCall('get_credential_count', []);
      const total = Number(credCount);

      const credentials: Credential[] = [];
      for (let i = 1; i <= total; i++) {
        try {
          const c = await soroban.simulateCall('get_credential', [soroban.u64Val(i)]);
          credentials.push(serializeBigInt(c) as Credential);
        } catch {
          // skip inaccessible credentials
        }
      }

      const active = credentials.filter((c) => !c.revoked && !c.suspended);
      const revoked = credentials.filter((c) => c.revoked);
      const suspended = credentials.filter((c) => c.suspended);
      const missingSubject = credentials.filter((c) => !c.subject);
      const missingIssuer = credentials.filter((c) => !c.issuer);

      res.json({
        period: { year, month },
        generatedAt: new Date().toISOString(),
        summary: {
          total: credentials.length,
          active: active.length,
          revoked: revoked.length,
          suspended: suspended.length,
        },
        auditTrailCompleteness: {
          withSubject: credentials.length - missingSubject.length,
          withIssuer: credentials.length - missingIssuer.length,
          total: credentials.length,
        },
        gaps: {
          missingSubject: missingSubject.map((c) => c.id),
          missingIssuer: missingIssuer.map((c) => c.id),
        },
      });
    } catch (err: unknown) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  /**
   * GET /api/reports/costs
   * #583 — Contract cost analysis: identifies expensive operations via simulation fee data.
   */
  router.get('/costs', async (req: Request, res: Response) => {
    // Operations to probe with minimal valid args (read-only, safe to simulate)
    const operations: Array<{ name: string; args: ReturnType<typeof SimulateCallType>[] }> = [
      { name: 'get_credential_count', args: [] },
      { name: 'get_slice_count', args: [] },
      { name: 'get_credential', args: [soroban.u64Val(1)] },
      { name: 'get_slice', args: [soroban.u64Val(1)] },
      { name: 'is_attested', args: [soroban.u64Val(1), soroban.u64Val(1)] },
    ];

    const results = await Promise.all(
      operations.map(async ({ name, args }) => {
        try {
          // simulateCall returns the native value; we need raw fee — re-simulate via server
          // Since we only have simulateCall abstraction, we record relative timing as a cost proxy
          const start = Date.now();
          await soroban.simulateCall(name, args as any);
          const durationMs = Date.now() - start;
          return { operation: name, durationMs, status: 'ok' };
        } catch {
          return { operation: name, durationMs: null, status: 'error' };
        }
      })
    );

    const successful = results.filter((r) => r.durationMs !== null) as {
      operation: string;
      durationMs: number;
      status: string;
    }[];
    successful.sort((a, b) => b.durationMs - a.durationMs);

    res.json({
      generatedAt: new Date().toISOString(),
      note: 'durationMs is a simulation latency proxy; on-chain fee data requires direct RPC access.',
      operations: results,
      mostExpensive: successful.slice(0, 3).map((r) => r.operation),
      optimizationSuggestions: successful
        .filter((r) => r.durationMs > 500)
        .map((r) => ({
          operation: r.operation,
          suggestion: `Consider caching results for ${r.operation} — simulation took ${r.durationMs}ms`,
        })),
    });
  });

  /**
   * GET /api/reports/usage
   * #585 — Contract usage analytics: function call frequency and error rates.
   */
  router.get('/usage', (_req: Request, res: Response) => {
    res.json(getUsageReport());
  });

  /**
   * GET /api/reports/audit
   * Audit compliance report: summarises credential issuance, verification (attestation),
   * and revocation events pulled from the on-chain audit log.
   * Query params:
   *   - limit: max entries to scan (default: 200, max: 1000)
   */
  router.get('/audit', async (req: Request, res: Response) => {
    const limit = Math.min(
      1000,
      Math.max(1, parseInt(String(req.query.limit ?? '200'), 10) || 200)
    );

    type AuditEntry = {
      id?: unknown;
      action?: unknown;
      credential_id?: unknown;
      actor?: unknown;
      timestamp?: unknown;
    };

    const ACTION_LABELS: Record<string, string> = {
      '1': 'CredentialIssued',
      '2': 'CredentialRevoked',
      '3': 'CredentialAttested',
      '4': 'CredentialSuspended',
      '5': 'CredentialRenewed',
      '6': 'SbtMinted',
      '7': 'SbtBurned',
    };

    try {
      const raw = await soroban.simulateCall('get_entries', [
        soroban.u64Val(1),
        { u32: limit } as unknown as ReturnType<typeof SimulateCallType>,
      ]);
      const entries = (Array.isArray(raw) ? raw : []) as AuditEntry[];
      const serialized = serializeBigInt(entries) as AuditEntry[];

      const issued = serialized.filter((e) => String(e.action) === '1');
      const revoked = serialized.filter((e) => String(e.action) === '2');
      const attested = serialized.filter((e) => String(e.action) === '3');
      const suspended = serialized.filter((e) => String(e.action) === '4');

      const byCategoryMap: Record<string, AuditEntry[]> = {};
      for (const entry of serialized) {
        const label = ACTION_LABELS[String(entry.action)] ?? `Action_${entry.action}`;
        if (!byCategoryMap[label]) byCategoryMap[label] = [];
        byCategoryMap[label].push(entry);
      }
      const byCategory = Object.fromEntries(
        Object.entries(byCategoryMap).map(([k, v]) => [k, { count: v.length, recentEntries: v.slice(-5) }])
      );

      res.json({
        generatedAt: new Date().toISOString(),
        scannedEntries: serialized.length,
        summary: {
          issued: issued.length,
          revoked: revoked.length,
          attested: attested.length,
          suspended: suspended.length,
          total: serialized.length,
        },
        byCategory,
      });
    } catch (err: unknown) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  return router;
}

import { simulateCall, u64Val } from '../soroban.js';
export default createReportsRouter({ simulateCall, u64Val: u64Val as SorobanClient['u64Val'] });
