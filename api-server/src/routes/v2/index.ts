/**
 * API v2 Router Registry (Issue #1310, #1427)
 *
 * v2 is GA as of 2026-09-01.
 *
 * v2 breaking changes vs v1:
 *
 *   - No response envelope wrapper (`ok`, `version`, `data`) — raw resource
 *     objects are returned directly.
 *   - Field renames: `metadata` → `metadata_hash`, `address` → `stellar_address`.
 *   - Pagination cursor field renamed from `next_cursor` to `cursor`.
 *   - Error shape aligned with RFC 9457 Problem Details.
 *   - New v2-only endpoints: /api/v2/proof-requests, /api/v2/revocation-registry,
 *     /api/v2/bbs-credentials.
 */

import { Router, Request, Response, NextFunction } from 'express';

// ── Shared route imports (same handlers as v1 — overrides applied below) ─────
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

// ── v2-only route handlers ────────────────────────────────────────────────────
import proofRequestsRouter from './proofRequests.js';
import revocationRegistryRouter from './revocationRegistry.js';
import bbsCredentialsRouter from './bbsCredentials.js';

// ── RFC 9457 error handling ───────────────────────────────────────────────────
import { problemJson } from '../../middleware/problemDetails.js';

// ─────────────────────────────────────────────────────────────────────────────

const sorobanClient = {
  simulateCall: Soroban.simulateCall,
  u64Val: Soroban.u64Val as Parameters<typeof createDashboardRouter>[0]['u64Val'],
  u32Val: Soroban.u32Val,
  addressVal: Soroban.addressVal,
};

// ---------------------------------------------------------------------------
// v2 Response Serializers
//
// These middleware functions transform v1 response bodies into the v2 shape:
//   - Strip the { ok, version, data } envelope if present.
//   - Rename `next_cursor` → `cursor` in paginated list responses.
//   - Rename `metadata` → `metadata_hash` and `address` → `stellar_address`
//     in credential objects.
//
// They work by monkey-patching res.json() on the way through so that any
// handler that calls res.json(body) transparently gets the transforms applied.
// ---------------------------------------------------------------------------

type AnyObj = Record<string, unknown>;

/** Strip the v1 { ok, version, data } envelope if present; return the payload as-is otherwise. */
function unwrapEnvelope(body: unknown): unknown {
  if (body !== null && typeof body === 'object' && !Array.isArray(body)) {
    const obj = body as AnyObj;
    // Canonical v1 envelope has `ok` (boolean) + `data`
    if ('ok' in obj && 'data' in obj) {
      return obj['data'];
    }
  }
  return body;
}

/** Rename `next_cursor` → `cursor` in list/page response objects. */
function renameCursor(obj: AnyObj): AnyObj {
  if ('next_cursor' in obj && !('cursor' in obj)) {
    const { next_cursor, ...rest } = obj;
    return { ...rest, cursor: next_cursor };
  }
  return obj;
}

/** Apply v2 field renames to a single credential-like object. */
function renameCredentialFields(obj: AnyObj): AnyObj {
  const result = { ...obj };
  // metadata → metadata_hash
  if ('metadata' in result && !('metadata_hash' in result)) {
    result['metadata_hash'] = result['metadata'];
    delete result['metadata'];
  }
  // address → stellar_address
  if ('address' in result && !('stellar_address' in result)) {
    result['stellar_address'] = result['address'];
    delete result['address'];
  }
  return result;
}

function applyV2CredentialRenames(body: unknown): unknown {
  if (Array.isArray(body)) {
    return body.map((item) =>
      item !== null && typeof item === 'object'
        ? applyV2CredentialRenames(item)
        : item,
    );
  }
  if (body !== null && typeof body === 'object') {
    const obj = body as AnyObj;
    let result = renameCredentialFields(obj);
    result = renameCursor(result);

    // Recurse into nested `items` or `data` arrays (list responses)
    if (Array.isArray(result['items'])) {
      result = { ...result, items: applyV2CredentialRenames(result['items']) };
    }
    if (Array.isArray(result['data'])) {
      result = { ...result, data: applyV2CredentialRenames(result['data']) };
    }
    if (Array.isArray(result['results'])) {
      result = { ...result, results: applyV2CredentialRenames(result['results']) };
    }
    return result;
  }
  return body;
}

/**
 * Express middleware that applies all v2 response transforms by intercepting
 * res.json().
 */
function v2ResponseSerializer(req: Request, res: Response, next: NextFunction): void {
  const originalJson = res.json.bind(res);

  res.json = function (body: unknown): Response {
    let transformed = unwrapEnvelope(body);
    transformed = applyV2CredentialRenames(transformed);
    return originalJson(transformed);
  };

  next();
}

/**
 * Creates the v2 router.
 *
 * Accepts an optional soroban client override for testing.
 */
export function createV2Router(soroban = sorobanClient): Router {
  const router = Router();

  // Apply v2 response transforms globally for this router
  router.use(v2ResponseSerializer);

  // ── Shared handlers (v1 + v2, transforms applied by middleware above) ───────

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

  // ── v2-only endpoints ────────────────────────────────────────────────────────

  router.use('/proof-requests', proofRequestsRouter);
  router.use('/revocation-registry', revocationRegistryRouter);
  router.use('/bbs-credentials', bbsCredentialsRouter);

  return router;
}

// Export v2 serializer helpers for testing
export { v2ResponseSerializer, unwrapEnvelope, renameCursor, applyV2CredentialRenames };

export default createV2Router();
