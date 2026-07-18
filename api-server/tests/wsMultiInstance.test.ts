/**
 * Multi-process integration test: proves that credential events published on
 * one API server instance reach a client connected to a *different*
 * instance, via the real Redis-backed pub/sub backbone (ws/pubsub.ts) — not
 * an in-process shortcut. Also proves filter semantics and dashboard stats
 * stay consistent across instances.
 *
 * Requires a real `redis-server` binary on PATH; the whole suite is skipped
 * (not failed) when it isn't available, since CI environments vary.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import WebSocket from 'ws';
import {
  redisServerAvailable,
  startEphemeralRedis,
  startHarnessInstance,
  type RedisHandle,
  type InstanceHandle,
} from './helpers/wsCluster.js';

const HAS_REDIS = redisServerAvailable();
const LATENCY_TRIALS = 50;
const P99_BOUND_MS = 200;

function connectAndWait(baseUrl: string, timeoutMs = 5000): Promise<{ ws: WebSocket; firstMessage: any }> {
  return new Promise((resolve, reject) => {
    const wsUrl = baseUrl.replace('http', 'ws') + '/ws';
    const timer = setTimeout(() => reject(new Error('Timeout connecting')), timeoutMs);
    const ws = new WebSocket(wsUrl);
    ws.once('open', () => {
      ws.once('message', (raw) => {
        clearTimeout(timer);
        resolve({ ws, firstMessage: JSON.parse(raw.toString()) });
      });
    });
    ws.once('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

function nextMessage(ws: WebSocket, timeoutMs = 3000): Promise<any> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Timeout waiting for message')), timeoutMs);
    ws.once('message', (raw) => {
      clearTimeout(timer);
      resolve(JSON.parse(raw.toString()));
    });
  });
}

function send(ws: WebSocket, msg: object): Promise<void> {
  return new Promise((resolve, reject) => {
    ws.send(JSON.stringify(msg), (err) => (err ? reject(err) : resolve()));
  });
}

async function trigger(baseUrl: string, path: string, body: object): Promise<void> {
  const res = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`trigger failed: ${res.status}`);
}

function percentile(sorted: number[], p: number): number {
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)];
}

describe.skipIf(!HAS_REDIS)('Cross-instance WebSocket delivery (real multi-process, real Redis)', () => {
  let redis: RedisHandle;
  let instanceA: InstanceHandle;
  let instanceB: InstanceHandle;

  beforeAll(async () => {
    redis = await startEphemeralRedis();
    [instanceA, instanceB] = await Promise.all([
      startHarnessInstance(redis.url, { WS_DASHBOARD_BROADCAST_INTERVAL_MS: '150' }),
      startHarnessInstance(redis.url, { WS_DASHBOARD_BROADCAST_INTERVAL_MS: '150' }),
    ]);
  }, 30_000);

  afterAll(async () => {
    await Promise.all([instanceA?.stop(), instanceB?.stop()].filter(Boolean));
    await redis?.stop();
  });

  it(
    'delivers an event published on instance A to a client connected only to instance B, within p99 < 200ms',
    async () => {
      const { ws } = await connectAndWait(instanceB.baseUrl);
      await send(ws, { type: 'subscribe', filters: [] });
      await nextMessage(ws); // subscription_confirmed

      const latencies: number[] = [];
      for (let i = 0; i < LATENCY_TRIALS; i++) {
        const start = Date.now();
        const pending = nextMessage(ws, 2000);
        await trigger(instanceA.baseUrl, '/trigger', {
          type: 'credential_issued',
          credential_id: 100_000 + i,
          timestamp: new Date().toISOString(),
        });
        const msg = await pending;
        latencies.push(Date.now() - start);
        expect(msg.type).toBe('credential_issued');
        expect(msg.data.credential_id).toBe(100_000 + i);
      }

      latencies.sort((a, b) => a - b);
      const p99 = percentile(latencies, 99);
      const p50 = percentile(latencies, 50);
      // eslint-disable-next-line no-console
      console.log(`cross-instance delivery latency: p50=${p50}ms p99=${p99}ms over ${LATENCY_TRIALS} trials`);
      expect(p99).toBeLessThan(P99_BOUND_MS);

      ws.close();
    },
    30_000
  );

  it('preserves filter semantics (credential_id) across instances', async () => {
    const { ws } = await connectAndWait(instanceB.baseUrl);
    await send(ws, { type: 'subscribe', filters: [{ credential_id: 777 }] });
    await nextMessage(ws); // subscription_confirmed

    // Non-matching events from the other instance must not arrive.
    await trigger(instanceA.baseUrl, '/trigger', {
      type: 'credential_issued',
      credential_id: 776,
      timestamp: new Date().toISOString(),
    });
    await trigger(instanceA.baseUrl, '/trigger', {
      type: 'credential_issued',
      credential_id: 778,
      timestamp: new Date().toISOString(),
    });
    await expect(nextMessage(ws, 400)).rejects.toThrow('Timeout');

    // Matching event does arrive.
    await trigger(instanceA.baseUrl, '/trigger', {
      type: 'credential_issued',
      credential_id: 777,
      timestamp: new Date().toISOString(),
    });
    const msg = await nextMessage(ws, 2000);
    expect(msg.data.credential_id).toBe(777);

    ws.close();
  }, 15_000);

  it('preserves issuer/holder/event_type filter semantics across instances', async () => {
    const { ws } = await connectAndWait(instanceB.baseUrl);
    await send(ws, { type: 'subscribe', filters: [{ issuer: 'G_ISSUER_X', event_type: 'credential_attested' }] });
    await nextMessage(ws);

    await trigger(instanceA.baseUrl, '/trigger', {
      type: 'credential_issued',
      issuer: 'G_ISSUER_X',
      credential_id: 1,
      timestamp: new Date().toISOString(),
    });
    await expect(nextMessage(ws, 400)).rejects.toThrow('Timeout');

    await trigger(instanceA.baseUrl, '/trigger', {
      type: 'credential_attested',
      issuer: 'G_ISSUER_X',
      credential_id: 2,
      timestamp: new Date().toISOString(),
    });
    const msg = await nextMessage(ws, 2000);
    expect(msg.type).toBe('credential_attested');
    expect(msg.data.issuer).toBe('G_ISSUER_X');

    ws.close();
  }, 15_000);

  it('keeps the live dashboard eventually consistent across instances', async () => {
    const { ws, firstMessage: connected } = await connectAndWait(instanceB.baseUrl);
    void connected;
    await send(ws, { type: 'subscribe_dashboard' });
    await nextMessage(ws); // dashboard_subscribed
    const initial = await nextMessage(ws); // dashboard_stats
    const before = initial.data.issuances_per_minute[initial.data.issuances_per_minute.length - 1];

    await trigger(instanceA.baseUrl, '/trigger-dashboard', { kind: 'issuance' });
    await trigger(instanceA.baseUrl, '/trigger-dashboard', { kind: 'issuance' });
    await trigger(instanceA.baseUrl, '/trigger-dashboard', { kind: 'issuance' });

    // Wait for B's periodic broadcast (interval set to 150ms for this test) to reflect A's deltas.
    let after = before;
    for (let i = 0; i < 20; i++) {
      const stats = await nextMessage(ws, 1000);
      after = stats.data.issuances_per_minute[stats.data.issuances_per_minute.length - 1];
      if (after >= before + 3) break;
    }
    expect(after).toBeGreaterThanOrEqual(before + 3);

    ws.close();
  }, 15_000);

  it('broadcastToAll also reaches every instance', async () => {
    const { ws } = await connectAndWait(instanceB.baseUrl);
    // No subscribe call — broadcastToAll ignores filters entirely and targets every open connection.
    const pending = nextMessage(ws, 2000);
    await trigger(instanceA.baseUrl, '/trigger-all', {
      type: 'credential_revoked',
      credential_id: 999,
      timestamp: new Date().toISOString(),
    });
    const msg = await pending;
    expect(msg.type).toBe('credential_revoked');
    expect(msg.data.credential_id).toBe(999);
    ws.close();
  }, 15_000);
});

if (!HAS_REDIS) {
  // eslint-disable-next-line no-console
  console.warn('[wsMultiInstance.test.ts] redis-server binary not found on PATH — skipping cross-instance suite.');
}
