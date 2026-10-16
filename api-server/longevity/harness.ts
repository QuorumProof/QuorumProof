/**
 * Issue #1632: longevity test harness for the API server.
 *
 * Drives a steady, mixed request load against the API for a long period while
 * sampling memory and OS resources, then runs leak / exhaustion detection and
 * writes a report.
 *
 * Modes
 *   in-process (default)  Builds the Express app with a mocked Soroban client and
 *                         listens on an ephemeral port in this process, so heap,
 *                         handles and FDs of the server itself are measured.
 *   external              Set LONGEVITY_TARGET_URL (and optionally
 *                         LONGEVITY_TARGET_PID) to load an already-running
 *                         server. RSS / FDs come from /proc/<pid>.
 *
 * Usage
 *   npm run longevity                               # 30 min, defaults
 *   LONGEVITY_DURATION=4h npm run longevity
 *   LONGEVITY_TARGET_URL=http://localhost:3000 LONGEVITY_TARGET_PID=1234 npm run longevity
 *
 * Exit code: 0 pass/warn, 1 fail (or 1 on warn with LONGEVITY_STRICT=1).
 * See docs/longevity-testing.md.
 */
import express from 'express';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { join } from 'node:path';
import { createCredentialsRouter, type SorobanClient as CredentialsClient } from '../src/routes/credentials.js';
import { createSlicesRouter } from '../src/routes/slices.js';
import { analyse, DEFAULT_THRESHOLDS, type Thresholds } from './detectors.js';
import { ResourceMonitor, type Counters } from './monitor.js';
import { verdict, writeReports, type RunInfo } from './report.js';

// ── Configuration ──────────────────────────────────────────────────────────

function parseDuration(v: string | undefined, fallbackSec: number): number {
  if (!v) return fallbackSec;
  const m = v.trim().match(/^(\d+(?:\.\d+)?)\s*(ms|s|m|h)?$/);
  if (!m) throw new Error(`invalid duration: ${v}`);
  const n = Number(m[1]);
  return { ms: n / 1000, s: n, m: n * 60, h: n * 3600 }[(m[2] ?? 's') as 'ms' | 's' | 'm' | 'h'];
}

const env = process.env;
const num = (k: string, d: number) => (env[k] !== undefined ? Number(env[k]) : d);

const durationSec = parseDuration(env.LONGEVITY_DURATION, 30 * 60);
const sampleIntervalMs = parseDuration(env.LONGEVITY_SAMPLE_INTERVAL, 5) * 1000;
const concurrency = num('LONGEVITY_CONCURRENCY', 8);
const targetUrl = env.LONGEVITY_TARGET_URL;
const targetPid = env.LONGEVITY_TARGET_PID ? Number(env.LONGEVITY_TARGET_PID) : undefined;
const reportDir = env.LONGEVITY_REPORT_DIR ?? join(process.cwd(), 'longevity-reports', new Date().toISOString().replace(/[:.]/g, '-'));
const strict = env.LONGEVITY_STRICT === '1';

const thresholds: Thresholds = {
  ...DEFAULT_THRESHOLDS,
  warmupSec: Math.min(parseDuration(env.LONGEVITY_WARMUP, DEFAULT_THRESHOLDS.warmupSec), durationSec / 4),
  heapGrowthMbPerHour: num('LONGEVITY_MAX_HEAP_GROWTH_MB_H', DEFAULT_THRESHOLDS.heapGrowthMbPerHour),
  rssGrowthMbPerHour: num('LONGEVITY_MAX_RSS_GROWTH_MB_H', DEFAULT_THRESHOLDS.rssGrowthMbPerHour),
  maxFdGrowth: num('LONGEVITY_MAX_FD_GROWTH', DEFAULT_THRESHOLDS.maxFdGrowth),
  maxHandleGrowth: num('LONGEVITY_MAX_HANDLE_GROWTH', DEFAULT_THRESHOLDS.maxHandleGrowth),
  eventLoopP99Ms: num('LONGEVITY_MAX_EVENT_LOOP_P99_MS', DEFAULT_THRESHOLDS.eventLoopP99Ms),
  maxErrorRate: num('LONGEVITY_MAX_ERROR_RATE', DEFAULT_THRESHOLDS.maxErrorRate),
};

// ── In-process server with a deterministic Soroban mock ────────────────────

const CREDENTIAL_COUNT = 250;
const SLICE_COUNT = 60;
const ADDR = (n: number) => `G${String(n).padStart(55, 'A')}`;

function mockSoroban(): CredentialsClient {
  const simulateCall = async (method: string, args: unknown[] = []): Promise<any> => {
    // Yield to the event loop like a real network call would.
    await new Promise((r) => setImmediate(r));
    const id = Number((args[0] as number | bigint | undefined) ?? 1);
    switch (method) {
      case 'get_credential_count':
        return BigInt(CREDENTIAL_COUNT);
      case 'get_slice_count':
        return BigInt(SLICE_COUNT);
      case 'get_credential':
        if (id > CREDENTIAL_COUNT) throw new Error('CredentialNotFound');
        return {
          id: BigInt(id),
          subject: ADDR(id % 17),
          issuer: ADDR(id % 5),
          credential_type: (id % 4) + 1,
          metadata_hash: Buffer.from(`QmHash${id}`),
          revoked: id % 11 === 0,
          suspended: id % 13 === 0,
          expires_at: id % 3 === 0 ? BigInt(2_000_000_000) : undefined,
          version: 1,
        };
      case 'get_slice':
        if (id > SLICE_COUNT) throw new Error('SliceNotFound');
        return {
          id: BigInt(id),
          creator: ADDR(id),
          attestors: [ADDR(1), ADDR(2), ADDR(3)],
          weights: [50, 30, 20],
          threshold: 70,
        };
      case 'verify_slice':
        if (id > SLICE_COUNT) throw new Error('SliceNotFound');
        return { slice_id: BigInt(id), valid: true, total_weight: 100, threshold: 70 };
      case 'is_attested':
        return id % 2 === 0;
      case 'get_credentials_by_subject':
      case 'get_credentials_by_issuer':
        return Array.from({ length: 10 }, (_, i) => BigInt(i + 1));
      default:
        return null;
    }
  };
  return {
    simulateCall: simulateCall as CredentialsClient['simulateCall'],
    u64Val: ((n: number | bigint) => n) as unknown as CredentialsClient['u64Val'],
    u32Val: ((n: number) => n) as unknown as CredentialsClient['u32Val'],
    addressVal: ((a: string) => a) as unknown as CredentialsClient['addressVal'],
  };
}

async function startInProcessServer(): Promise<{ baseUrl: string; server: Server }> {
  const soroban = mockSoroban();
  const app = express();
  app.use(express.json());
  app.use('/api/slices', createSlicesRouter(soroban));
  app.use('/api/credentials', createCredentialsRouter(soroban));
  const server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const { port } = server.address() as AddressInfo;
  return { baseUrl: `http://127.0.0.1:${port}`, server };
}

// ── Load generator ─────────────────────────────────────────────────────────

type Scenario = { weight: number; request: (i: number) => { path: string; init?: RequestInit } };

const scenarios: Scenario[] = [
  { weight: 30, request: (i) => ({ path: `/api/slices/${(i % SLICE_COUNT) + 1}` }) },
  { weight: 15, request: (i) => ({ path: `/api/slices?page=${(i % 3) + 1}&page_size=20` }) },
  { weight: 25, request: (i) => ({ path: `/api/credentials/search?type=${(i % 4) + 1}&page=${(i % 5) + 1}&page_size=20` }) },
  { weight: 10, request: (i) => ({ path: `/api/credentials/search?status=${['active', 'revoked', 'suspended'][i % 3]}&sort_by=type&sort_order=desc` }) },
  { weight: 15, request: (i) => ({ path: `/api/slices/${(i % SLICE_COUNT) + 1}/verification` }) },
  // Deliberate 4xx paths: error handling must not leak either.
  { weight: 5, request: (i) => ({ path: i % 2 ? '/api/slices/0' : `/api/slices/${SLICE_COUNT + 1000}` }) },
];
const totalWeight = scenarios.reduce((a, s) => a + s.weight, 0);

function pickScenario(i: number): Scenario {
  let r = (i * 2654435761) % totalWeight; // deterministic spread
  for (const s of scenarios) {
    if (r < s.weight) return s;
    r -= s.weight;
  }
  return scenarios[0];
}

async function worker(baseUrl: string, counters: Counters, deadline: () => number, offset: number): Promise<void> {
  let i = offset;
  while (performance.now() < deadline()) {
    const { path, init } = pickScenario(i).request(i);
    i += concurrency;
    const t0 = performance.now();
    try {
      const res = await fetch(baseUrl + path, { ...init, signal: AbortSignal.timeout(10_000) });
      await res.arrayBuffer(); // drain body so the socket is reused
      // 4xx are expected for the negative scenarios; only 5xx/network errors count.
      if (res.status >= 500) counters.errors++;
    } catch {
      counters.errors++;
    } finally {
      counters.requests++;
      counters.latenciesMs.push(performance.now() - t0);
    }
  }
}

// ── Main ───────────────────────────────────────────────────────────────────

async function main(): Promise<number> {
  const gcExposed = typeof (globalThis as { gc?: unknown }).gc === 'function';
  let server: Server | undefined;
  let baseUrl = targetUrl;
  if (!baseUrl) ({ baseUrl, server } = await startInProcessServer());

  const info: RunInfo = {
    startedAt: new Date().toISOString(),
    durationSec,
    mode: targetUrl ? 'external' : 'in-process',
    target: baseUrl,
    concurrency,
    nodeVersion: process.version,
    gcExposed,
  };

  const counters: Counters = { requests: 0, errors: 0, latenciesMs: [] };
  const monitor = new ResourceMonitor(counters, { intervalMs: sampleIntervalMs, targetPid, forceGc: gcExposed && !targetUrl });

  console.log(`[longevity] ${info.mode} run against ${baseUrl} for ${durationSec}s, concurrency ${concurrency}`);
  console.log(`[longevity] reports -> ${reportDir}`);

  let stopRequested = false;
  const onSignal = () => {
    if (stopRequested) process.exit(130);
    stopRequested = true;
    console.log('\n[longevity] stopping early, writing report for the samples collected so far...');
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);

  const logEvery = Math.max(1, Math.round(60_000 / sampleIntervalMs));
  monitor.startSampling((s) => {
    if (monitor.samples.length % logEvery === 0) {
      console.log(
        `[longevity] t=${s.t}s heap=${s.heapUsedMb}MB rss=${s.rssMb}MB fds=${s.openFds ?? '-'} handles=${s.activeHandles} ` +
          `loopP99=${s.eventLoopP99Ms}ms rps=${s.rps} req=${s.requests} err=${s.errors}`,
      );
    }
  });

  const deadline = performance.now() + durationSec * 1000;
  const effectiveDeadline = () => (stopRequested ? 0 : deadline);
  await Promise.all(Array.from({ length: concurrency }, (_, w) => worker(baseUrl!, counters, effectiveDeadline, w)));

  monitor.samples.push(monitor.sample());
  monitor.stop();
  if (server) await new Promise<void>((r) => server!.close(() => r()));

  info.durationSec = monitor.samples[monitor.samples.length - 1]?.t ?? durationSec;
  const findings = analyse(monitor.samples, thresholds, { external: !!targetUrl });
  const md = writeReports(reportDir, info, monitor.samples, findings, thresholds);
  console.log('\n' + md);

  const v = verdict(findings);
  return v === 'fail' || (strict && v === 'warn') ? 1 : 0;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error('[longevity] harness error:', err);
    process.exit(2);
  },
);
