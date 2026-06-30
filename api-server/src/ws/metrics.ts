export interface WsMetrics {
  connections: number;
  peakConnections: number;
  subscribers: number;
  messagesSent: number;
  messagesReceived: number;
  errors: number;
  bytesSent: number;
  bytesReceived: number;
}

const metrics: WsMetrics = {
  connections: 0,
  peakConnections: 0,
  subscribers: 0,
  messagesSent: 0,
  messagesReceived: 0,
  errors: 0,
  bytesSent: 0,
  bytesReceived: 0,
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

export function getWsMetrics(): WsMetrics {
  return { ...metrics };
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
}
