import { Router, Request, Response } from 'express';
import { credentialEventService } from '../services/credentialEvents.js';

export function createEventsRouter() {
  const router = Router();

  // Get recent credential events
  router.get('/recent', (req: Request, res: Response) => {
    try {
      const limit = Math.min(parseInt(req.query.limit as string) || 50, 1000);
      const type = req.query.type as string | undefined;
      const credential_id = req.query.credential_id ? parseInt(req.query.credential_id as string, 10) : undefined;

      const events = credentialEventService.getRecentEvents(limit, { type, credential_id });
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

  // Get events for a time range
  router.get('/range', (req: Request, res: Response) => {
    try {
      const startTime = req.query.start_time ? new Date(req.query.start_time as string) : new Date(Date.now() - 3600000);
      const endTime = req.query.end_time ? new Date(req.query.end_time as string) : new Date();

      if (isNaN(startTime.getTime()) || isNaN(endTime.getTime())) {
        res.status(400).json({ error: 'Invalid time format' });
        return;
      }

      const events = credentialEventService.getEventHistory(startTime, endTime);
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
