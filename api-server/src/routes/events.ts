import { Router, Request, Response } from 'express';
import { credentialEventService, type CredentialEventPayload } from '../services/credentialEvents.js';
import { requireAuth, isAdmin } from '../middleware/auth.js';

const MAX_LIMIT = 1000;

/**
 * Non-admin callers only see events where they are the issuer or the holder.
 * Admins see everything. Event payloads are not otherwise altered.
 */
function visibleEvents(req: Request, events: CredentialEventPayload[]): CredentialEventPayload[] {
  if (isAdmin(req)) return events;
  const sub = req.auth?.sub;
  if (!sub) return [];
  return events.filter((e) => e.issuer === sub || e.holder === sub);
}

export function createEventsRouter() {
  const router = Router();

  // Get recent credential events (authenticated; filtered to caller unless admin)
  router.get('/recent', requireAuth, (req: Request, res: Response) => {
    try {
      const limit = Math.min(parseInt(req.query.limit as string) || 50, MAX_LIMIT);
      const type = req.query.type as string | undefined;
      const credential_id = req.query.credential_id ? parseInt(req.query.credential_id as string, 10) : undefined;

      // Over-fetch for non-admins so filtering does not leave the page short.
      const fetchLimit = isAdmin(req) ? limit : MAX_LIMIT;
      const events = visibleEvents(req, credentialEventService.getRecentEvents(fetchLimit, { type, credential_id })).slice(0, limit);
      res.json({
        events,
        count: events.length,
        timestamp: new Date().toISOString(),
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: msg });
    }
  });

  // Get events for a time range (authenticated; filtered to caller unless admin)
  router.get('/range', requireAuth, (req: Request, res: Response) => {
    try {
      const startTime = req.query.start_time ? new Date(req.query.start_time as string) : new Date(Date.now() - 3600000);
      const endTime = req.query.end_time ? new Date(req.query.end_time as string) : new Date();

      if (isNaN(startTime.getTime()) || isNaN(endTime.getTime())) {
        res.status(400).json({ error: 'Invalid time format' });
        return;
      }

      const events = visibleEvents(req, credentialEventService.getEventHistory(startTime, endTime));
      res.json({
        events,
        count: events.length,
        range: { start: startTime.toISOString(), end: endTime.toISOString() },
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: msg });
    }
  });

  // Public: protocol metadata only (no event data), so it stays unauthenticated.
  // Get WebSocket connection information
  router.get('/ws-info', (req: Request, res: Response) => {
    res.json({
      endpoint: 'ws://<host>:<port>/ws',
      description: 'WebSocket endpoint for real-time credential events (#1605)',
      subscription_types: [
        'credential_issued',
        'credential_revoked',
        'credential_attested',
        'credential_suspended',
        'credential_expired',
        'credential_tier_promoted',
        'reward_earned',
        'reward_claimed',
        'reward_settled',
        'reward_expired',
      ],
      message_formats: {
        client_to_server: {
          subscribe: { type: 'subscribe', filters: [{ credential_id: 'number?', issuer: 'string?', event_type: 'string?' }] },
          unsubscribe: { type: 'unsubscribe', filters: [{ credential_id: 'number?', issuer: 'string?' }] },
          ping: { type: 'ping' },
        },
        server_to_client: {
          connected: { type: 'connected', data: { ts: 'ISO timestamp', connection_count: 'number' } },
          subscription_confirmed: { type: 'subscription_confirmed', data: { filters: 'array', subscriber_count: 'number' } },
          pong: { type: 'pong', data: { ts: 'ISO timestamp' } },
          credential_event: { type: 'credential_*', data: { credential_id: 'number?', issuer: 'string?', timestamp: 'ISO timestamp' } },
          error: { type: 'error', data: { message: 'string' } },
        },
      },
      connection_features: {
        heartbeat_interval_ms: 30000,
        heartbeat_timeout_ms: 60000,
        automatic_reconnection: 'client-side (see useRealtimeUpdates hook)',
        connection_stability: 'enabled',
        event_filtering: 'supported',
        cross_instance_delivery: 'enabled',
      },
      example_filter: {
        subscribe_to_credential: {
          type: 'subscribe',
          filters: [{ credential_id: 123 }],
        },
        subscribe_by_issuer: {
          type: 'subscribe',
          filters: [{ issuer: 'GAAAA...' }],
        },
      },
    });
  });

  return router;
}

export default createEventsRouter();
