/**
 * Issue #1001 — Issuer Analytics Endpoint
 *
 * Routes:
 *   GET /api/analytics/credentials?issuer=&range=7d|30d|90d
 *   GET /api/analytics/verifications?range=7d|30d|90d
 *   GET /api/analytics/disputes?issuer=&range=7d|30d|90d
 */
import { Router, Request, Response } from 'express';
import type { SorobanClient } from './credentials.js';
import { metricsStore, parseRangeParam } from '../services/metrics.js';

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

type ExpiryBucket = 'expired' | 'expiring_7d' | 'expiring_30d' | 'expiring_90d' | 'expiring_later' | 'no_expiry';

function bucketExpiry(expiresAt: unknown): ExpiryBucket {
  if (!expiresAt || typeof expiresAt !== 'string') return 'no_expiry';
  const at = new Date(expiresAt);
  if (isNaN(at.getTime())) return 'no_expiry';
  const days = (at.getTime() - Date.now()) / (24 * 60 * 60 * 1000);
  if (days < 0) return 'expired';
  if (days <= 7) return 'expiring_7d';
  if (days <= 30) return 'expiring_30d';
  if (days <= 90) return 'expiring_90d';
  return 'expiring_later';
}

export function createIssuerAnalyticsRouter(soroban: SorobanClient) {
  const router = Router();

  /**
   * GET /api/analytics/credentials
   * Query params: issuer (required), range (7d|30d|90d, default 30d)
   * Returns: total issued, breakdown by credential type, expiry distribution.
   */
  router.get('/credentials', async (req: Request, res: Response) => {
    const issuer = typeof req.query.issuer === 'string' ? req.query.issuer : undefined;
    if (!issuer) {
      res.status(400).json({ error: 'issuer query parameter is required' });
      return;
    }

    let window: ReturnType<typeof parseRangeParam>;
    try {
      window = parseRangeParam(typeof req.query.range === 'string' ? req.query.range : undefined);
    } catch (err: unknown) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'Invalid range' });
      return;
    }
    const windowStartMs = new Date(window.startDate).getTime();

    try {
      const credCount: bigint = await soroban.simulateCall('get_credential_count', []);
      const total = Number(credCount);

      let totalIssued = 0;
      const byType: Record<string, number> = {};
      const expiryDistribution: Record<ExpiryBucket, number> = {
        expired: 0,
        expiring_7d: 0,
        expiring_30d: 0,
        expiring_90d: 0,
        expiring_later: 0,
        no_expiry: 0,
      };

      for (let i = 1; i <= total; i++) {
        try {
          const cred = await soroban.simulateCall('get_credential', [soroban.u64Val(i)]);
          const record = serializeBigInt(cred) as Record<string, unknown>;
          if (record.issuer !== issuer) continue;

          const createdAt = typeof record.created_at === 'string' ? new Date(record.created_at).getTime() : NaN;
          if (!isNaN(createdAt) && createdAt < windowStartMs) continue;

          totalIssued++;
          const type = String(record.credential_type ?? 'unknown');
          byType[type] = (byType[type] ?? 0) + 1;
          expiryDistribution[bucketExpiry(record.expires_at)]++;
        } catch {
          // skip missing/inaccessible credentials
        }
      }

      res.json({
        issuer,
        range: `${window.days}d`,
        start_date: window.startDate,
        end_date: window.endDate,
        total_issued: totalIssued,
        by_type: byType,
        expiry_distribution: expiryDistribution,
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: msg });
    }
  });

  /**
   * GET /api/analytics/verifications
   * Query params: range (7d|30d|90d, default 30d)
   * Returns: verification count by claim type, verifier distribution.
   *
   * Sourced from the same analytics event log `POST /api/analytics/events`
   * writes to — `POST /api/verify/batch` and `GET /api/verify/:id` both
   * record a `verified` event (with `claim_type`/`verifier` in `metadata`)
   * on every successful verification.
   */
  router.get('/verifications', (req: Request, res: Response) => {
    let window: ReturnType<typeof parseRangeParam>;
    try {
      window = parseRangeParam(typeof req.query.range === 'string' ? req.query.range : undefined);
    } catch (err: unknown) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'Invalid range' });
      return;
    }

    const events = metricsStore.getEventLog({
      startDate: window.startDate,
      endDate: window.endDate,
      type: 'verified',
    });

    const byClaimType: Record<string, number> = {};
    const byVerifier: Record<string, number> = {};
    for (const event of events) {
      const claimType = String((event.metadata as Record<string, unknown> | undefined)?.claim_type ?? 'unknown');
      const verifier = String((event.metadata as Record<string, unknown> | undefined)?.verifier ?? 'unknown');
      byClaimType[claimType] = (byClaimType[claimType] ?? 0) + 1;
      byVerifier[verifier] = (byVerifier[verifier] ?? 0) + 1;
    }

    res.json({
      range: `${window.days}d`,
      start_date: window.startDate,
      end_date: window.endDate,
      total_verifications: events.length,
      by_claim_type: byClaimType,
      verifier_distribution: byVerifier,
    });
  });

  /**
   * GET /api/analytics/disputes
   * Query params: issuer (optional), range (7d|30d|90d, default 30d)
   * Returns: dispute rate, average resolution time, common reasons.
   *
   * Dispute rate is disputed-events / issued-events within the same window,
   * mirroring `MetricsStore.getIssuerMetrics`'s existing formula. Resolution
   * time and reason are read from a disputed event's `metadata.resolved_at`
   * / `metadata.reason` when present — neither is populated automatically
   * today (there's no dispute-resolution event feed yet), so both degrade
   * gracefully (null / "unspecified") until a caller starts recording them.
   */
  router.get('/disputes', (req: Request, res: Response) => {
    const issuer = typeof req.query.issuer === 'string' ? req.query.issuer : undefined;

    let window: ReturnType<typeof parseRangeParam>;
    try {
      window = parseRangeParam(typeof req.query.range === 'string' ? req.query.range : undefined);
    } catch (err: unknown) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'Invalid range' });
      return;
    }

    const query = { startDate: window.startDate, endDate: window.endDate };
    let issuedEvents = metricsStore.getEventLog({ ...query, type: 'issued' });
    let disputedEvents = metricsStore.getEventLog({ ...query, type: 'disputed' });
    if (issuer) {
      issuedEvents = issuedEvents.filter((e) => e.issuer === issuer);
      disputedEvents = disputedEvents.filter((e) => e.issuer === issuer);
    }

    const disputeRate = issuedEvents.length > 0 ? disputedEvents.length / issuedEvents.length : 0;

    const resolutionTimes: number[] = [];
    const reasonCounts: Record<string, number> = {};
    for (const event of disputedEvents) {
      const metadata = (event.metadata as Record<string, unknown> | undefined) ?? {};
      const reason = typeof metadata.reason === 'string' && metadata.reason.length > 0 ? metadata.reason : 'unspecified';
      reasonCounts[reason] = (reasonCounts[reason] ?? 0) + 1;

      if (typeof metadata.resolved_at === 'string') {
        const resolvedMs = new Date(metadata.resolved_at).getTime();
        const openedMs = new Date(event.timestamp).getTime();
        if (!isNaN(resolvedMs) && !isNaN(openedMs) && resolvedMs >= openedMs) {
          resolutionTimes.push(resolvedMs - openedMs);
        }
      }
    }

    const avgResolutionTimeMs =
      resolutionTimes.length > 0 ? resolutionTimes.reduce((sum, t) => sum + t, 0) / resolutionTimes.length : null;

    const commonReasons = Object.entries(reasonCounts)
      .sort(([, a], [, b]) => b - a)
      .slice(0, 5)
      .map(([reason, count]) => ({ reason, count }));

    res.json({
      issuer: issuer ?? null,
      range: `${window.days}d`,
      start_date: window.startDate,
      end_date: window.endDate,
      total_disputes: disputedEvents.length,
      dispute_rate: disputeRate,
      avg_resolution_time_ms: avgResolutionTimeMs,
      common_reasons: commonReasons,
    });
  });

  return router;
}

// Default export using the real Soroban client
import { simulateCall, u64Val, u32Val, addressVal } from '../soroban.js';
export default createIssuerAnalyticsRouter({
  simulateCall,
  u64Val: u64Val as unknown as SorobanClient['u64Val'],
  u32Val: u32Val as unknown as SorobanClient['u32Val'],
  addressVal: addressVal as unknown as SorobanClient['addressVal'],
});
