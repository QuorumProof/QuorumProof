/**
 * Issue #1301: Auth Audit Event Routes
 *
 * GET /api/audit/auth-events — admin-only, filterable by user, date range, event type
 * GET /api/audit/auth-events/alerts — suspicious pattern detection
 */

import { Router, Request, Response } from 'express';
import { rbac } from '../middleware/rbac.js';
import {
  queryAuthEvents,
  detectSuspiciousActivity,
  type AuthEventType,
  type AuthAuditFilter,
} from '../services/authAudit.js';

const router = Router();

const VALID_EVENT_TYPES = new Set<string>([
  'login_success', 'login_failure', 'logout',
  'magic_link_requested', 'magic_link_verified', 'magic_link_failed',
  'webauthn_registered', 'webauthn_verified', 'webauthn_failed',
  'mfa_success', 'mfa_failure', 'key_rotation',
  'token_refreshed', 'session_expired', 'account_locked',
]);

const VALID_STATUSES = new Set<string>(['success', 'failure', 'info']);

/**
 * GET /api/audit/auth-events
 * Returns paginated authentication audit events (admin only).
 * Query params:
 *   - user_id: filter by user
 *   - event_type: filter by event type
 *   - status: success | failure | info
 *   - start_date: ISO 8601 date string (inclusive)
 *   - end_date: ISO 8601 date string (inclusive)
 *   - ip_address: filter by IP address
 *   - limit: max results (default: 50, max: 200)
 *   - offset: pagination offset (default: 0)
 */
router.get(
  '/',
  rbac.requirePermission('admin:all'),
  (req: Request, res: Response): void => {
    const {
      user_id, event_type, status, start_date, end_date, ip_address,
    } = req.query as Record<string, string | undefined>;

    const limit = Math.min(200, Math.max(1, parseInt(String(req.query.limit ?? '50'), 10) || 50));
    const offset = Math.max(0, parseInt(String(req.query.offset ?? '0'), 10) || 0);

    // Validate event_type.
    if (event_type && !VALID_EVENT_TYPES.has(event_type)) {
      res.status(400).json({
        error: `Invalid event_type: "${event_type}". Valid values: ${[...VALID_EVENT_TYPES].join(', ')}`,
      });
      return;
    }

    // Validate status.
    if (status && !VALID_STATUSES.has(status)) {
      res.status(400).json({
        error: `Invalid status: "${status}". Valid values: success, failure, info`,
      });
      return;
    }

    // Validate dates.
    if (start_date && isNaN(Date.parse(start_date))) {
      res.status(400).json({ error: 'Invalid start_date format. Use ISO 8601.' });
      return;
    }
    if (end_date && isNaN(Date.parse(end_date))) {
      res.status(400).json({ error: 'Invalid end_date format. Use ISO 8601.' });
      return;
    }
    if (start_date && end_date && new Date(start_date) > new Date(end_date)) {
      res.status(400).json({ error: 'start_date must be before end_date' });
      return;
    }

    const filter: AuthAuditFilter = {
      user_id,
      event_type: event_type as AuthEventType | undefined,
      status: status as 'success' | 'failure' | 'info' | undefined,
      start_date,
      end_date,
      ip_address,
      limit,
      offset,
    };

    const result = queryAuthEvents(filter);
    res.json(result);
  }
);

/**
 * GET /api/audit/auth-events/alerts
 * Returns current suspicious activity alerts (admin only).
 * Detects brute-force attempts and credential stuffing patterns.
 */
router.get(
  '/alerts',
  rbac.requirePermission('admin:all'),
  (_req: Request, res: Response): void => {
    const alerts = detectSuspiciousActivity();
    res.json({
      count: alerts.length,
      alerts,
    });
  }
);

export default router;
