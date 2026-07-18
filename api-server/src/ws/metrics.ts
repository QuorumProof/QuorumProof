import { instanceId } from './instanceId.js';

export interface WsMetrics {
  instanceId: string;
  connections: number;
  peakConnections: number;
  subscribers: number;
  messagesSent: number;
  messagesReceived: number;
  errors: number;
  bytesSent: number;
  bytesReceived: number;
  /** Messages dropped by a per-connection send queue hitting its bound (see connectionQueue.ts). */
  messagesDropped: number;
  /** Events this instance received from another instance via the pub/sub backbone. */
  crossInstanceMessagesReceived: number;
  /** Events this instance published for other instances to pick up. */
  crossInstanceMessagesPublished: number;
}

const metrics: Omit<WsMetrics, 'instanceId'> = {
  connections: 0,
  peakConnections: 0,
  subscribers: 0,
  messagesSent: 0,
  messagesReceived: 0,
  errors: 0,
  bytesSent: 0,
  bytesReceived: 0,
  messagesDropped: 0,
  crossInstanceMessagesReceived: 0,
  crossInstanceMessagesPublished: 0,
};

export function incrementConnections(): void {
  metrics.connections++;
  if (metrics.connections > metrics.peakConnections) {
    metrics.peakConnections = metrics.connections;
  }
}

export function decrementConnections(): void {
  metrics.connections = Math.max(0, metrics.connections - 1);
}

export function setSubscribers(count: number): void {
  metrics.subscribers = count;
}

export function recordMessageSent(bytes: number): void {
  metrics.messagesSent++;
  metrics.bytesSent += bytes;
}

export function recordMessageReceived(bytes: number): void {
  metrics.messagesReceived++;
  metrics.bytesReceived += bytes;
}

export function recordError(): void {
  metrics.errors++;
}

export function recordMessageDropped(): void {
  metrics.messagesDropped++;
}

export function recordCrossInstanceMessageReceived(): void {
  metrics.crossInstanceMessagesReceived++;
}

export function recordCrossInstanceMessagePublished(): void {
  metrics.crossInstanceMessagesPublished++;
}

export function getWsMetrics(): WsMetrics {
  return { instanceId, ...metrics };
}

export function resetWsMetrics(): void {
  metrics.connections = 0;
  metrics.peakConnections = 0;
  metrics.subscribers = 0;
  metrics.messagesSent = 0;
  metrics.messagesReceived = 0;
  metrics.errors = 0;
  metrics.bytesSent = 0;
  metrics.bytesReceived = 0;
  metrics.messagesDropped = 0;
  metrics.crossInstanceMessagesReceived = 0;
  metrics.crossInstanceMessagesPublished = 0;
}

/**
 * Prometheus text exposition (v0.0.4) of this instance's WS metrics, tagged
 * with an `instance` label so a Prometheus server scraping every replica can
 * aggregate with e.g. `sum(quorumproof_ws_connections)` or
 * `sum(rate(quorumproof_ws_messages_sent_total[5m]))`.
 */
export function getWsMetricsPrometheus(): string {
  const m = getWsMetrics();
  const label = `{instance="${m.instanceId}"}`;
  const lines: string[] = [];

  const gauge = (name: string, help: string, value: number) => {
    lines.push(`# HELP ${name} ${help}`);
    lines.push(`# TYPE ${name} gauge`);
    lines.push(`${name}${label} ${value}`);
  };
  const counter = (name: string, help: string, value: number) => {
    lines.push(`# HELP ${name} ${help}`);
    lines.push(`# TYPE ${name} counter`);
    lines.push(`${name}${label} ${value}`);
  };

  gauge('quorumproof_ws_connections', 'Current open WebSocket connections on this instance', m.connections);
  gauge('quorumproof_ws_peak_connections', 'Peak open WebSocket connections observed on this instance', m.peakConnections);
  gauge('quorumproof_ws_subscribers', 'Current active subscribers on this instance', m.subscribers);
  counter('quorumproof_ws_messages_sent_total', 'Messages sent to clients by this instance', m.messagesSent);
  counter('quorumproof_ws_messages_received_total', 'Messages received from clients by this instance', m.messagesReceived);
  counter('quorumproof_ws_errors_total', 'WebSocket errors observed on this instance', m.errors);
  counter('quorumproof_ws_bytes_sent_total', 'Bytes sent to clients by this instance', m.bytesSent);
  counter('quorumproof_ws_bytes_received_total', 'Bytes received from clients by this instance', m.bytesReceived);
  counter('quorumproof_ws_messages_dropped_total', 'Messages dropped due to a full per-connection send queue', m.messagesDropped);
  counter('quorumproof_ws_cross_instance_messages_received_total', 'Events received from other instances via the pub/sub backbone', m.crossInstanceMessagesReceived);
  counter('quorumproof_ws_cross_instance_messages_published_total', 'Events published for other instances via the pub/sub backbone', m.crossInstanceMessagesPublished);

  return lines.join('\n') + '\n';
}
