/**
 * WebSocket API for Real-Time Credential Status Updates
 *
 * Message Format (Client -> Server):
 *   { "type": "subscribe",   "filters": [{ "credential_id"?: number, "issuer"?: string, "holder"?: string, "event_type"?: string }] }
 *   { "type": "unsubscribe", "filters"?: [{ "credential_id"?: number, "issuer"?: string, "holder"?: string, "event_type"?: string }] }
 *   { "type": "ping" }
 *
 * Message Format (Server -> Client):
 *   { "type": "connected",             "data": { "ts": "<ISO timestamp>", "connection_count": number } }
 *   { "type": "subscription_confirmed","data": { "filters": [...], "subscriber_count": number } }
 *   { "type": "unsubscription_confirmed","data": { "filters": [...] } }
 *   { "type": "pong",                  "data": { "ts": "<ISO timestamp>" } }
 *   { "type": "error",                 "data": { "message": "..." } }
 *   { "type": "credential_issued",     "data": { "credential_id": number, "issuer"?: string, "holder"?: string, "timestamp": "..." } }
 *   { "type": "credential_revoked",    "data": { "credential_id": number, "issuer"?: string, "holder"?: string, "timestamp": "..." } }
 *   { "type": "credential_attested",   "data": { "credential_id": number, "attestor"?: string, "timestamp": "..." } }
 *   { "type": "credential_suspended",  "data": { "credential_id": number, "timestamp": "..." } }
 *   { "type": "credential_expiring",   "data": { "credential_id": number, "timestamp": "..." } }
 *
 * Connection lifecycle handled by the useRealtimeUpdates hook (frontend):
 *   - Automatic reconnection with polling fallback (see frontend/src/hooks/useRealtimeUpdates.ts)
 *   - Server-side ping/pong every 30s; clients unresponsive for >60s are terminated
 *
 * Endpoint: ws://<host>:<port>/ws
 * Metrics:  GET /ws/metrics (JSON, this instance only), GET /metrics/ws (Prometheus, aggregable — see ws/metrics.ts)
 *
 * Multi-instance delivery: broadcastEvent/broadcastToAll deliver to this
 * instance's connected clients synchronously (unchanged behavior/return
 * value), then publish the event on the pub/sub backbone (ws/pubsub.ts) so
 * every other instance's subscribers receive it too. See
 * docs/websocket-scaling.md for the full architecture and the bounded
 * per-connection send queue's backpressure/drop policy (ws/connectionQueue.ts).
 */
import { Server as HttpServer } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import { IncomingMessage } from 'http';
import {
  addSubscriber,
  removeSubscriber,
  removeConnection,
  getMatchingSubscribers,
  getSubscriberCount,
  addDashboardSubscriber,
  removeDashboardSubscriber,
  getDashboardSubscribers,
  type SubscriptionFilter,
  type WsBroadcastEvent,
} from './subscriptions.js';
import { liveDashboard } from '../services/liveDashboard.js';
import { getPubSubBackend, type PubSubBackend } from './pubsub.js';
import { initDashboardSync } from './dashboardSync.js';
import { instanceId } from './instanceId.js';
import { sendQueued, closeConnectionQueue } from './connectionQueue.js';
import {
  incrementConnections,
  decrementConnections,
  setSubscribers,
  recordMessageSent,
  recordMessageReceived,
  recordError,
  recordCrossInstanceMessageReceived,
  recordCrossInstanceMessagePublished,
  getWsMetrics as _getWsMetrics,
  type WsMetrics,
} from './metrics.js';

interface WsClientMessage {
  type: 'subscribe' | 'unsubscribe' | 'ping' | 'subscribe_dashboard' | 'unsubscribe_dashboard';
  filters?: SubscriptionFilter[];
}

const PING_INTERVAL_MS = 30_000;
const DASHBOARD_BROADCAST_INTERVAL_MS = parseInt(process.env.WS_DASHBOARD_BROADCAST_INTERVAL_MS ?? '5000', 10);
const EVENTS_CHANNEL = 'ws:events';

interface EventEnvelope {
  publishedBy: string;
  publishedAt: number;
  mode: 'filtered' | 'all';
  event: WsBroadcastEvent;
}

function createMessage(type: string, data: Record<string, unknown>) {
  return JSON.stringify({ type, data });
}

let wss: WebSocketServer | null = null;
let pingTimer: ReturnType<typeof setInterval> | null = null;
let dashboardTimer: ReturnType<typeof setInterval> | null = null;
let pubsub: PubSubBackend | null = null;

/** Delivers to this instance's matching subscribers only. Returns recipient count. */
function deliverLocally(event: WsBroadcastEvent): number {
  const message = createMessage(event.type, {
    credential_id: event.credential_id,
    issuer: event.issuer,
    holder: event.holder,
    attestor: event.attestor,
    proof_request_id: event.proof_request_id,
    timestamp: event.timestamp,
  });

  const recipients = getMatchingSubscribers(event);
  for (const ws of recipients) {
    sendQueued(ws, message);
  }
  return recipients.length;
}

/** Delivers to every locally connected client, regardless of filters. Returns recipient count. */
function deliverToAllLocally(event: WsBroadcastEvent): number {
  if (!wss) return 0;

  const message = createMessage(event.type, {
    credential_id: event.credential_id,
    issuer: event.issuer,
    holder: event.holder,
    attestor: event.attestor,
    proof_request_id: event.proof_request_id,
    timestamp: event.timestamp,
  });

  let count = 0;
  wss.clients.forEach((ws) => {
    if (ws.readyState === WebSocket.OPEN) {
      sendQueued(ws, message);
      count++;
    }
  });
  return count;
}

function publishCrossInstance(mode: 'filtered' | 'all', event: WsBroadcastEvent): void {
  if (!pubsub) return;
  const envelope: EventEnvelope = { publishedBy: instanceId, publishedAt: Date.now(), mode, event };
  pubsub.publish(EVENTS_CHANNEL, JSON.stringify(envelope));
  recordCrossInstanceMessagePublished();
}

function initPubSub(): void {
  if (pubsub) return;
  pubsub = getPubSubBackend();
  initDashboardSync(pubsub);

  pubsub.subscribe(EVENTS_CHANNEL, (raw) => {
    let envelope: EventEnvelope;
    try {
      envelope = JSON.parse(raw);
    } catch {
      return;
    }
    if (envelope.publishedBy === instanceId) return; // already delivered locally by broadcastEvent/broadcastToAll
    recordCrossInstanceMessageReceived();
    if (envelope.mode === 'all') {
      deliverToAllLocally(envelope.event);
    } else {
      deliverLocally(envelope.event);
    }
  });
}

export function createWsServer(server: HttpServer, path = '/ws'): WebSocketServer {
  initPubSub();
  wss = new WebSocketServer({ server, path });

  wss.on('connection', (ws: WebSocket, _req: IncomingMessage) => {
    incrementConnections();
    recordMessageReceived(0);
    setSubscribers(getSubscriberCount());

    (ws as any).isAlive = true;

    ws.on('pong', () => {
      (ws as any).isAlive = true;
    });

    ws.on('message', (raw: Buffer) => {
      recordMessageReceived(raw.length);
      try {
        const msg: WsClientMessage = JSON.parse(raw.toString());

        switch (msg.type) {
          case 'subscribe': {
            const filters = msg.filters ?? [];
            addSubscriber(ws, filters);
            setSubscribers(getSubscriberCount());
            sendQueued(ws, createMessage('subscription_confirmed', {
              filters,
              subscriber_count: getSubscriberCount(),
            }));
            break;
          }

          case 'unsubscribe': {
            const filters = msg.filters;
            removeSubscriber(ws, filters);
            setSubscribers(getSubscriberCount());
            sendQueued(ws, createMessage('unsubscription_confirmed', {
              filters: filters ?? [],
            }));
            break;
          }

          case 'ping': {
            sendQueued(ws, createMessage('pong', { ts: new Date().toISOString() }));
            break;
          }

          case 'subscribe_dashboard': {
            addDashboardSubscriber(ws);
            const initialStats = liveDashboard.getStats() as unknown as Record<string, unknown>;
            sendQueued(ws, createMessage('dashboard_subscribed', { ts: new Date().toISOString() }));
            sendQueued(ws, createMessage('dashboard_stats', initialStats));
            break;
          }

          case 'unsubscribe_dashboard': {
            removeDashboardSubscriber(ws);
            sendQueued(ws, createMessage('dashboard_unsubscribed', {}));
            break;
          }

          default:
            sendQueued(ws, createMessage('error', {
              message: `Unknown message type: ${(msg as any).type ?? 'undefined'}`,
            }));
            recordError();
            break;
        }
      } catch (err) {
        recordError();
        sendQueued(ws, createMessage('error', {
          message: 'Invalid message format — expected JSON',
        }));
      }
    });

    ws.on('close', () => {
      decrementConnections();
      removeConnection(ws);
      closeConnectionQueue(ws);
      setSubscribers(getSubscriberCount());
    });

    ws.on('error', () => {
      recordError();
    });

    sendQueued(ws, createMessage('connected', {
      ts: new Date().toISOString(),
      connection_count: getWsMetrics().connections,
    }));
  });

  pingTimer = setInterval(() => {
    if (!wss) return;
    wss.clients.forEach((ws) => {
      if ((ws as any).isAlive === false) {
        removeConnection(ws);
        closeConnectionQueue(ws);
        ws.terminate();
        return;
      }
      (ws as any).isAlive = false;
      ws.ping();
    });
  }, PING_INTERVAL_MS);

  dashboardTimer = setInterval(() => {
    const subscribers = getDashboardSubscribers();
    if (subscribers.length === 0) return;
    const stats = liveDashboard.getStats() as unknown as Record<string, unknown>;
    const message = createMessage('dashboard_stats', stats);
    for (const client of subscribers) {
      sendQueued(client, message);
    }
  }, DASHBOARD_BROADCAST_INTERVAL_MS);

  wss.on('close', () => {
    if (pingTimer) {
      clearInterval(pingTimer);
      pingTimer = null;
    }
    if (dashboardTimer) {
      clearInterval(dashboardTimer);
      dashboardTimer = null;
    }
  });

  return wss;
}

/** Delivers to matching subscribers (filtered by credential_id/issuer/holder/event_type), on this instance and every other instance sharing the pub/sub backbone. Returns this instance's local recipient count. */
export function broadcastEvent(event: WsBroadcastEvent): number {
  const localCount = deliverLocally(event);
  publishCrossInstance('filtered', event);
  return localCount;
}

/** Delivers to every connected client regardless of filters, on this instance and every other instance sharing the pub/sub backbone. Returns this instance's local recipient count. */
export function broadcastToAll(event: WsBroadcastEvent): number {
  const localCount = deliverToAllLocally(event);
  publishCrossInstance('all', event);
  return localCount;
}

export function getConnectionCount(): number {
  return wss?.clients.size ?? 0;
}

export function getWsMetrics(): WsMetrics {
  return _getWsMetrics();
}

export function closeWsServer(): void {
  if (pingTimer) {
    clearInterval(pingTimer);
    pingTimer = null;
  }
  if (dashboardTimer) {
    clearInterval(dashboardTimer);
    dashboardTimer = null;
  }
  wss?.close();
  wss = null;
}
