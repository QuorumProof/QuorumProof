/**
 * API v1 Router Registry (Issue #1310)
 *
 * Mounts all current route handlers under /api/v1.
 *
 * This registry is the canonical v1 surface.  Route handlers themselves are
 * not duplicated — the same factory-created or pre-built routers that power
 * the backward-compatible /api/* paths are reused here.  The v1Compat
 * middleware (applied by index.ts before mounting this router) wraps every
 * response in the v1 envelope.
 *
 * Lifecycle:
 *   Stable now → Maintenance 2026-09-01 → Sunset 2027-03-01
 */

import { Router } from 'express';

// ── Route imports ──────────────────────────────────────────────────────────────
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
  u64Val: Soroban.u64Val as ReturnType<typeof createDashboardRouter> extends never ? never : Parameters<typeof createDashboardRouter>[0]['u64Val'],
  u32Val: Soroban.u32Val,
  addressVal: Soroban.addressVal,
};

/**
 * Creates the v1 router.
 *
 * Accepts an optional soroban client override for testing.
 */
export function createV1Router(soroban = sorobanClient): Router {
  const router = Router();

  // Core credential lifecycle
  router.use('/slices', slicesRouter);
  router.use('/credentials', credentialsRouter);
  router.use('/credentials', credentialExportRouter);   // JSON/PDF/QR export
  router.use('/credentials', shareLinksRouter);          // Share link management
  router.use('/credentials', consentRouter);             // Consent management

  // Verification
  router.use('/verify', verifyRouter);

  // Notifications & analytics
  router.use('/notifications', notificationsRouter);
  router.use('/analytics', analyticsRouter);
  router.use('/analytics', issuerAnalyticsRouter);       // Issuer-scoped analytics

  // Attestors & issuers
  router.use('/attestor', attestorRouter);
  router.use('/issuer', issuerRouter);

  // Account recovery
  router.use('/recovery', recoveryRouter);

  // Compliance & data-privacy
  router.use('/webhooks', webhooksRouter);
  router.use('/gdpr', gdprRouter);

  // Auth subsystem
  router.use('/api-keys', apiKeysRouter);
  router.use('/oauth2', oauth2Router);

  // Credential holder dashboard
  router.use('/me', createDashboardRouter(soroban));

  return router;
}

export default createV1Router();
