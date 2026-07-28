/**
 * API v2 Router Registry (Issue #1310)
 *
 * Forward-looking stub for the v2 API surface.
 *
 * v2 is currently in development and exposes the same handlers as v1.
 * As breaking changes are introduced they will be implemented here as
 * version-specific overrides rather than touching the shared handlers.
 *
 * v2 design goals / planned breaking changes vs v1:
 *
 *   - No response envelope wrapper (`ok`, `version`, `data`) — raw resource
 *     objects are returned directly, which is friendlier for typed SDKs.
 *   - Field renames: `metadata` → `metadata_hash`, `address` → `stellar_address`.
 *   - Pagination cursor format migrated to opaque base64-encoded tokens
 *     (same behaviour, but the field name changes from `next_cursor` to `cursor`).
 *   - Error shape aligned with RFC 9457 Problem Details.
 *   - New endpoints: /api/v2/proof-requests, /api/v2/revocation-registry.
 *
 * Lifecycle:
 *   Development now → GA / Stable 2026-09-01
 *
 * NOTE: Until v2 deviates from v1 handlers all traffic to /api/v2/* will
 * resolve identically to /api/v1/* minus the compat envelope.  This ensures
 * v2 clients can start integrating early against the stable route structure.
 */

import { Router } from 'express';

// ── Shared route imports (same as v1 — override here when v2 diverges) ────────
import slicesRouter from '../slices.js';
import credentialsRouter from '../credentials.js';
import credentialExportRouter from '../credentialExport.js';
import verifyRouter from '../verify.js';
import notificationsRouter from '../notifications.js';
import analyticsRouter from '../analytics.js';
import issuerAnalyticsRouter from '../issuerAnalytics.js';
import attestorRouter from '../attestor.js';
import issuerRouter from '../issuer.js';
import recoveryRouter from '../recovery.js';
import shareLinksRouter from '../shareLinks.js';
import consentRouter from '../consent.js';
import webhooksRouter from '../webhooks.js';
import gdprRouter from '../gdpr.js';
import apiKeysRouter from '../apiKeys.js';
import oauth2Router from '../oauth2.js';
import { createDashboardRouter } from '../dashboard.js';
import * as Soroban from '../../soroban.js';

// ─────────────────────────────────────────────────────────────────────────────

const sorobanClient = {
  simulateCall: Soroban.simulateCall,
  u64Val: Soroban.u64Val as Parameters<typeof createDashboardRouter>[0]['u64Val'],
  u32Val: Soroban.u32Val,
  addressVal: Soroban.addressVal,
};

/**
 * Creates the v2 router.
 *
 * Accepts an optional soroban client override for testing.
 */
export function createV2Router(soroban = sorobanClient): Router {
  const router = Router();

  // ── Shared with v1 — replace with v2-specific handlers as they land ─────────

  router.use('/slices', slicesRouter);
  router.use('/credentials', credentialsRouter);
  router.use('/credentials', credentialExportRouter);
  router.use('/credentials', shareLinksRouter);
  router.use('/credentials', consentRouter);
  router.use('/verify', verifyRouter);
  router.use('/notifications', notificationsRouter);
  router.use('/analytics', analyticsRouter);
  router.use('/analytics', issuerAnalyticsRouter);
  router.use('/attestor', attestorRouter);
  router.use('/issuer', issuerRouter);
  router.use('/recovery', recoveryRouter);
  router.use('/webhooks', webhooksRouter);
  router.use('/gdpr', gdprRouter);
  router.use('/api-keys', apiKeysRouter);
  router.use('/oauth2', oauth2Router);
  router.use('/me', createDashboardRouter(soroban));

  // ── v2-only stubs (expand as features graduate from design to implementation)

  // Planned: /proof-requests  — managed ZK proof-request lifecycle
  // Planned: /revocation-registry — batch revocation with time-locks
  // Planned: /bbs-credentials  — BBS+ selective-disclosure credentials

  return router;
}

export default createV2Router();
