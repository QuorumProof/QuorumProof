/**
 * Cross-instance pub/sub backbone for the WebSocket layer.
 *
 * In a single-replica deployment, in-process delivery is sufficient. Once
 * api-server runs as more than one replica (see docs/websocket-scaling.md),
 * an event observed by instance A must still reach a client connected to
 * instance B. This module abstracts "publish an event so every instance's
 * subscribers see it" behind a small interface so the transport (Redis today)
 * can be swapped without touching ws/server.ts.
 *
 * Backend selection: REDIS_URL set -> RedisPubSubBackend (real cross-instance
 * delivery). REDIS_URL unset -> InMemoryPubSubBackend (same-process only;
 * fine for local dev and tests, but does NOT provide cross-instance delivery
 * — do not run multiple replicas without REDIS_URL configured).
 */
import { Redis, type RedisOptions } from 'ioredis';
import { EventEmitter } from 'events';

export interface PubSubBackend {
  /** Fire-and-forget: failures are logged, never thrown, so a broker outage never breaks local delivery. */
  publish(channel: string, payload: string): void;
  subscribe(channel: string, handler: (payload: string) => void): void;
  close(): Promise<void>;
}

class InMemoryPubSubBackend implements PubSubBackend {
  private readonly emitter = new EventEmitter();

  constructor() {
    this.emitter.setMaxListeners(0);
  }

  publish(channel: string, payload: string): void {
    queueMicrotask(() => this.emitter.emit(channel, payload));
  }

  subscribe(channel: string, handler: (payload: string) => void): void {
    this.emitter.on(channel, handler);
  }

  async close(): Promise<void> {
    this.emitter.removeAllListeners();
  }
}

class RedisPubSubBackend implements PubSubBackend {
  private readonly pubClient: Redis;
  private readonly subClient: Redis;
  private readonly handlers = new Map<string, Set<(payload: string) => void>>();

  constructor(url: string) {
    const opts: RedisOptions = { maxRetriesPerRequest: 2 };
    this.pubClient = new Redis(url, opts);
    this.subClient = new Redis(url, opts);
    this.pubClient.on('error', (err) => console.error('[ws:pubsub] publisher error:', err.message));
    this.subClient.on('error', (err) => console.error('[ws:pubsub] subscriber error:', err.message));
    this.subClient.on('message', (channel: string, payload: string) => {
      const set = this.handlers.get(channel);
      if (!set) return;
      for (const handler of set) handler(payload);
    });
  }

  publish(channel: string, payload: string): void {
    this.pubClient.publish(channel, payload).catch((err: Error) => {
      console.error(`[ws:pubsub] publish to ${channel} failed:`, err.message);
    });
  }

  subscribe(channel: string, handler: (payload: string) => void): void {
    let set = this.handlers.get(channel);
    if (!set) {
      set = new Set();
      this.handlers.set(channel, set);
      this.subClient.subscribe(channel).catch((err: Error) => {
        console.error(`[ws:pubsub] subscribe to ${channel} failed:`, err.message);
      });
    }
    set.add(handler);
  }

  async close(): Promise<void> {
    await Promise.allSettled([this.pubClient.quit(), this.subClient.quit()]);
  }
}

let backend: PubSubBackend | null = null;

export function getPubSubBackend(): PubSubBackend {
  if (!backend) {
    const url = process.env.REDIS_URL;
    backend = url ? new RedisPubSubBackend(url) : new InMemoryPubSubBackend();
  }
  return backend;
}

/** Test/ops hook — closes and clears the singleton so the next getPubSubBackend() call re-reads REDIS_URL. */
export async function resetPubSubBackend(): Promise<void> {
  if (backend) await backend.close();
  backend = null;
}
