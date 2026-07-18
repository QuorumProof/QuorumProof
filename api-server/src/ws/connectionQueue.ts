/**
 * Bounded per-connection send queue.
 *
 * Every outbound message (broadcasts, dashboard stats, control replies) is
 * enqueued here rather than written to the socket directly, so one slow
 * client can't block delivery to others and can't grow memory without bound.
 *
 * Backpressure/drop policy (deliberately simple, documented so it doesn't
 * need re-discovering from behavior):
 *   - Each connection gets its own FIFO queue, capped at WS_SEND_QUEUE_MAX_MESSAGES
 *     messages (default 200) and WS_SEND_QUEUE_MAX_BYTES bytes (default 1 MiB),
 *     whichever limit is hit first.
 *   - When a new message would exceed either cap, the OLDEST queued message is
 *     dropped to make room. This is a "latest wins" policy: for a real-time
 *     status feed, a fresh event is more useful to a lagging client than a
 *     stale one, and clients should treat the feed as best-effort, reconciling
 *     via a REST fetch on reconnect (see useRealtimeUpdates.ts) rather than
 *     relying on every message arriving.
 *   - Every drop increments the `messagesDropped` metric (ws/metrics.ts) so
 *     operators can see when clients are falling behind.
 *   - The queue also respects the underlying socket's own buffered bytes
 *     (ws.bufferedAmount): while it's above WS_BACKPRESSURE_HIGH_WATER_MARK
 *     bytes, draining pauses briefly rather than piling more onto the OS
 *     socket buffer.
 */
import { WebSocket } from 'ws';
import { recordMessageSent, recordMessageDropped, recordError } from './metrics.js';

const MAX_QUEUE_MESSAGES = parseInt(process.env.WS_SEND_QUEUE_MAX_MESSAGES ?? '200', 10);
const MAX_QUEUE_BYTES = parseInt(process.env.WS_SEND_QUEUE_MAX_BYTES ?? String(1_000_000), 10);
const BACKPRESSURE_HIGH_WATER_MARK = parseInt(process.env.WS_BACKPRESSURE_HIGH_WATER_MARK ?? String(1_000_000), 10);
const BACKPRESSURE_RETRY_MS = 10;

interface QueuedItem {
  data: string;
  bytes: number;
}

export class ConnectionQueue {
  private readonly queue: QueuedItem[] = [];
  private queuedBytes = 0;
  private draining = false;
  private closed = false;

  constructor(private readonly ws: WebSocket) {}

  enqueue(data: string): void {
    if (this.closed || this.ws.readyState !== WebSocket.OPEN) return;

    const bytes = Buffer.byteLength(data);
    while (
      this.queue.length > 0 &&
      (this.queue.length >= MAX_QUEUE_MESSAGES || this.queuedBytes + bytes > MAX_QUEUE_BYTES)
    ) {
      const dropped = this.queue.shift()!;
      this.queuedBytes -= dropped.bytes;
      recordMessageDropped();
    }

    this.queue.push({ data, bytes });
    this.queuedBytes += bytes;
    this.drain();
  }

  private drain(): void {
    if (this.draining) return;
    this.draining = true;

    const step = (): void => {
      if (this.closed || this.queue.length === 0 || this.ws.readyState !== WebSocket.OPEN) {
        this.draining = false;
        return;
      }

      if (this.ws.bufferedAmount > BACKPRESSURE_HIGH_WATER_MARK) {
        setTimeout(step, BACKPRESSURE_RETRY_MS);
        return;
      }

      const item = this.queue.shift()!;
      this.queuedBytes -= item.bytes;
      this.ws.send(item.data, (err?: Error) => {
        if (err) {
          recordError();
        } else {
          recordMessageSent(item.bytes);
        }
        step();
      });
    };

    step();
  }

  close(): void {
    this.closed = true;
    this.queue.length = 0;
    this.queuedBytes = 0;
  }
}

const queues = new WeakMap<WebSocket, ConnectionQueue>();

export function getConnectionQueue(ws: WebSocket): ConnectionQueue {
  let q = queues.get(ws);
  if (!q) {
    q = new ConnectionQueue(ws);
    queues.set(ws, q);
  }
  return q;
}

export function sendQueued(ws: WebSocket, data: string): void {
  getConnectionQueue(ws).enqueue(data);
}

export function closeConnectionQueue(ws: WebSocket): void {
  queues.get(ws)?.close();
}
