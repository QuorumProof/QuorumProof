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
 * Metrics:  GET /ws/metrics
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
  type SubscriptionFilter,
  type WsBroadcastEvent,
} from './subscriptions.js';
import {
  incrementConnections,
  decrementConnections,
  setSubscribers,
  recordMessageSent,
  recordMessageReceived,
  recordError,
  getWsMetrics as _getWsMetrics,
  type WsMetrics,
} from './metrics.js';

interface WsClientMessage {
  type: 'subscribe' | 'unsubscribe' | 'ping';
  filters?: SubscriptionFilter[];
}

const PING_INTERVAL_MS = 30_000;

function createMessage(type: string, data: Record<string, unknown>) {
  return JSON.stringify({ type, data });
}

let wss: WebSocketServer | null = null;
let pingTimer: ReturnType<typeof setInterval> | null = null;

export function createWsServer(server: HttpServer, path = '/ws'): WebSocketServer {
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
            ws.send(createMessage('subscription_confirmed', {
              filters,
              subscriber_count: getSubscriberCount(),
            }));
            recordMessageSent(Buffer.byteLength('subscription_confirmed'));
            break;
          }

          case 'unsubscribe': {
            const filters = msg.filters;
            removeSubscriber(ws, filters);
            setSubscribers(getSubscriberCount());
            ws.send(createMessage('unsubscription_confirmed', {
              filters: filters ?? [],
            }));
            recordMessageSent(Buffer.byteLength('unsubscription_confirmed'));
            break;
          }

          case 'ping': {
            ws.send(createMessage('pong', { ts: new Date().toISOString() }));
            recordMessageSent(Buffer.byteLength('pong'));
            break;
          }

          default:
            ws.send(createMessage('error', {
              message: `Unknown message type: ${(msg as any).type ?? 'undefined'}`,
            }));
            recordError();
            break;
        }
      } catch (err) {
        recordError();
        ws.send(createMessage('error', {
          message: 'Invalid message format — expected JSON',
        }));
      }
    });

    ws.on('close', () => {
      decrementConnections();
      removeConnection(ws);
      setSubscribers(getSubscriberCount());
    });

    ws.on('error', () => {
      recordError();
    });

    ws.send(createMessage('connected', {
      ts: new Date().toISOString(),
      connection_count: getWsMetrics().connections,
    }));
    recordMessageSent(Buffer.byteLength('connected'));
  });

  pingTimer = setInterval(() => {
    if (!wss) return;
    wss.clients.forEach((ws) => {
      if ((ws as any).isAlive === false) {
        removeConnection(ws);
        ws.terminate();
        return;
      }
      (ws as any).isAlive = false;
      ws.ping();
    });
  }, PING_INTERVAL_MS);

  wss.on('close', () => {
    if (pingTimer) {
      clearInterval(pingTimer);
      pingTimer = null;
    }
  });

  return wss;
}

export function broadcastEvent(event: WsBroadcastEvent): number {
  if (!wss) return 0;

  const message = createMessage(event.type, {
    credential_id: event.credential_id,
    issuer: event.issuer,
    holder: event.holder,
    attestor: event.attestor,
    proof_request_id: event.proof_request_id,
    timestamp: event.timestamp,
  });

  const recipients = getMatchingSubscribers(event);
  const messageBytes = Buffer.byteLength(message);

  for (const ws of recipients) {
    ws.send(message);
    recordMessageSent(messageBytes);
  }

  return recipients.length;
}

export function broadcastToAll(event: WsBroadcastEvent): number {
  if (!wss) return 0;

  const message = createMessage(event.type, {
    credential_id: event.credential_id,
    issuer: event.issuer,
    holder: event.holder,
    attestor: event.attestor,
    proof_request_id: event.proof_request_id,
    timestamp: event.timestamp,
  });

  const messageBytes = Buffer.byteLength(message);
  let count = 0;

  wss.clients.forEach((ws) => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(message);
      recordMessageSent(messageBytes);
      count++;
    }
  });

  return count;
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
  wss?.close();
  wss = null;
}
