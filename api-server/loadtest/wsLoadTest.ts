/**
 * WebSocket load test: opens a large number of real client connections
 * distributed across N real API server instances (separate processes) that
 * share a real Redis pub/sub backend, then broadcasts events from one
 * instance and measures delivery completeness and latency across every
 * connection, regardless of which instance it landed on.
 *
 * Not run as part of `npm test` — it's a standalone script (see
 * package.json's `loadtest:ws` script) because a 10k-connection run takes
 * real time and resources that don't belong in the default CI test loop.
 * Run it explicitly, and on a machine with a raised file-descriptor limit
 * (`ulimit -n`) if targeting connection counts in the tens of thousands.
 *
 * Usage:
 *   npm run loadtest:ws
 *   WS_LOAD_CONNECTIONS=2000 WS_LOAD_INSTANCES=2 npm run loadtest:ws
 *   WS_LOAD_REDIS_URL=redis://localhost:6379 npm run loadtest:ws   # reuse a running Redis instead of spawning one
 */
import { WebSocket } from 'ws';
import {
  startEphemeralRedis,
  startHarnessInstance,
  type RedisHandle,
  type InstanceHandle,
} from '../tests/helpers/wsCluster.js';

const CONNECTIONS = parseInt(process.env.WS_LOAD_CONNECTIONS ?? '10000', 10);
const INSTANCES = parseInt(process.env.WS_LOAD_INSTANCES ?? '3', 10);
const EVENT_ROUNDS = parseInt(process.env.WS_LOAD_EVENTS ?? '20', 10);
const LATENCY_SAMPLE_SIZE = Math.min(CONNECTIONS, parseInt(process.env.WS_LOAD_LATENCY_SAMPLE ?? '300', 10));
const CONNECT_CONCURRENCY = parseInt(process.env.WS_LOAD_CONNECT_CONCURRENCY ?? '250', 10);
const ROUND_SETTLE_MS = parseInt(process.env.WS_LOAD_ROUND_SETTLE_MS ?? '2000', 10);

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return NaN;
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)];
}

async function connectAndSubscribe(baseUrl: string): Promise<WebSocket> {
  const ws = new WebSocket(baseUrl.replace('http', 'ws') + '/ws');
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('connect timeout')), 20_000);
    ws.once('open', () => {
      clearTimeout(timer);
      resolve();
    });
    ws.once('error', reject);
  });
  ws.send(JSON.stringify({ type: 'subscribe', filters: [] }));
  return ws;
}

async function runWithConcurrency<T>(items: T[], concurrency: number, fn: (item: T, idx: number) => Promise<void>): Promise<void> {
  let cursor = 0;
  async function worker(): Promise<void> {
    while (cursor < items.length) {
      const idx = cursor++;
      await fn(items[idx], idx);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => worker()));
}

async function main(): Promise<void> {
  console.log(
    `WS load test: ${CONNECTIONS} connections across ${INSTANCES} instance(s), ${EVENT_ROUNDS} broadcast round(s), latency sampled from ${LATENCY_SAMPLE_SIZE} connection(s)`
  );

  const externalRedisUrl = process.env.WS_LOAD_REDIS_URL;
  let redis: RedisHandle | null = null;
  const redisUrl = externalRedisUrl ?? (redis = await startEphemeralRedis()).url;
  console.log(`Redis: ${externalRedisUrl ? 'external ' + externalRedisUrl : redisUrl + ' (ephemeral)'}`);

  const instances: InstanceHandle[] = [];
  for (let i = 0; i < INSTANCES; i++) {
    instances.push(await startHarnessInstance(redisUrl));
  }
  console.log(`Instances ready: ${instances.map((i) => i.port).join(', ')}`);

  const sockets: WebSocket[] = new Array(CONNECTIONS);
  const receivedPerRound = new Array(EVENT_ROUNDS).fill(0);
  const latencySamplesPerRound: number[][] = Array.from({ length: EVENT_ROUNDS }, () => []);
  const roundSentAt = new Array(EVENT_ROUNDS).fill(0);
  let droppedConnections = 0;

  const connectStart = Date.now();
  await runWithConcurrency(
    Array.from({ length: CONNECTIONS }, (_, i) => i),
    CONNECT_CONCURRENCY,
    async (i) => {
      const inst = instances[i % instances.length];
      try {
        const ws = await connectAndSubscribe(inst.baseUrl);
        const sampled = i < LATENCY_SAMPLE_SIZE;
        ws.on('message', (raw) => {
          let msg: any;
          try {
            msg = JSON.parse(raw.toString());
          } catch {
            return;
          }
          if (msg.type !== 'credential_issued' || typeof msg.data?.credential_id !== 'number') return;
          const round = msg.data.credential_id;
          if (round < 0 || round >= EVENT_ROUNDS) return;
          receivedPerRound[round]++;
          if (sampled && roundSentAt[round]) {
            latencySamplesPerRound[round].push(Date.now() - roundSentAt[round]);
          }
        });
        ws.on('error', () => {
          /* counted via final open-socket scan below */
        });
        sockets[i] = ws;
      } catch (err) {
        droppedConnections++;
      }
    }
  );
  const connectedCount = sockets.filter((s) => s && s.readyState === WebSocket.OPEN).length;
  console.log(
    `Connected ${connectedCount}/${CONNECTIONS} (${droppedConnections} failed to connect) in ${Date.now() - connectStart}ms`
  );

  // Let subscription_confirmed acks flush before we start measuring broadcast delivery.
  await new Promise((r) => setTimeout(r, 500));

  for (let round = 0; round < EVENT_ROUNDS; round++) {
    roundSentAt[round] = Date.now();
    const res = await fetch(`${instances[0].baseUrl}/trigger-all`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'credential_issued', credential_id: round, timestamp: new Date().toISOString() }),
    });
    if (!res.ok) throw new Error(`trigger-all failed on round ${round}: ${res.status}`);
    await new Promise((r) => setTimeout(r, ROUND_SETTLE_MS));
    console.log(`  round ${round}: ${receivedPerRound[round]}/${connectedCount} delivered so far`);
  }

  const allLatencies = latencySamplesPerRound.flat().sort((a, b) => a - b);
  const totalExpected = connectedCount * EVENT_ROUNDS;
  const totalReceived = receivedPerRound.reduce((a, b) => a + b, 0);

  console.log('\n=== WS Load Test Report ===');
  console.log(`Connections requested:  ${CONNECTIONS}`);
  console.log(`Connections established: ${connectedCount}`);
  console.log(`Instances:              ${INSTANCES}`);
  console.log(`Broadcast rounds:       ${EVENT_ROUNDS}`);
  console.log(`Delivery completeness:  ${totalReceived}/${totalExpected} (${((totalReceived / totalExpected) * 100).toFixed(2)}%)`);
  if (allLatencies.length > 0) {
    console.log(
      `Latency (sampled, ms):  p50=${percentile(allLatencies, 50)} p95=${percentile(allLatencies, 95)} p99=${percentile(allLatencies, 99)} max=${allLatencies[allLatencies.length - 1]}`
    );
  }
  console.log(`Peak RSS:               ${(process.memoryUsage().rss / 1024 / 1024).toFixed(1)} MB (this driver process only)`);

  for (const ws of sockets) {
    if (ws && ws.readyState === WebSocket.OPEN) ws.close();
  }
  await Promise.all(instances.map((i) => i.stop()));
  if (redis) await redis.stop();

  if (totalReceived !== totalExpected) {
    console.error('\nFAIL: delivery was not 100% complete.');
    process.exitCode = 1;
  } else {
    console.log('\nOK: every connection received every broadcast round.');
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
