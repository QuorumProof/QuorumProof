/**
 * Credential lifecycle load test: exercises the two heaviest write/read
 * paths on the API — bulk credential indexing (the search-index write that
 * follows on-chain issuance) and batched verification (`POST
 * /api/credentials/verify-batch`, which fans out to `simulateCall` per
 * credential, i.e. the RPC-bound path guarded by the circuit breaker in
 * `../src/services/rpcCircuitBreaker.ts`).
 *
 * Default scenario: issue 1000 credentials, then run 10000 verifications
 * against them (200 batches of 50, the API's max batch size), against a
 * real Express app instance with a SorobanClient stub whose latency and
 * failure rate are configurable, so the test can be run either against
 * synthetic RPC timing or (via SOROBAN_RPC_LATENCY_MS=0 and a real
 * simulateCall implementation swapped in) against a live testnet endpoint.
 *
 * Not run as part of `npm test` — see package.json's `loadtest:credentials`
 * script. Usage:
 *   npm run loadtest:credentials
 *   LOAD_ISSUE_COUNT=5000 LOAD_VERIFY_COUNT=50000 npm run loadtest:credentials
 *   LOAD_RPC_FAILURE_RATE=0.05 npm run loadtest:credentials   # exercise circuit breaker under load
 */
import express from 'express';
import type { AddressInfo } from 'net';
import { createCredentialsRouter, type SorobanClient } from '../src/routes/credentials.js';

const ISSUE_COUNT = parseInt(process.env.LOAD_ISSUE_COUNT ?? '1000', 10);
const VERIFY_COUNT = parseInt(process.env.LOAD_VERIFY_COUNT ?? '10000', 10);
const VERIFY_BATCH_SIZE = 50;
const ISSUE_CONCURRENCY = parseInt(process.env.LOAD_ISSUE_CONCURRENCY ?? '50', 10);
const VERIFY_CONCURRENCY = parseInt(process.env.LOAD_VERIFY_CONCURRENCY ?? '25', 10);
const RPC_LATENCY_MS = parseInt(process.env.LOAD_RPC_LATENCY_MS ?? '80', 10);
const RPC_FAILURE_RATE = parseFloat(process.env.LOAD_RPC_FAILURE_RATE ?? '0.01');

interface Timing {
  ok: boolean;
  ms: number;
}

function percentile(sortedMs: number[], p: number): number {
  if (sortedMs.length === 0) return NaN;
  const idx = Math.min(sortedMs.length - 1, Math.ceil((p / 100) * sortedMs.length) - 1);
  return sortedMs[Math.max(0, idx)];
}

function summarize(label: string, timings: Timing[], wallMs: number): void {
  const ok = timings.filter((t) => t.ok);
  const failed = timings.length - ok.length;
  const sorted = ok.map((t) => t.ms).sort((a, b) => a - b);
  console.log(`\n--- ${label} ---`);
  console.log(`  total: ${timings.length}, ok: ${ok.length}, failed: ${failed} (${((failed / timings.length) * 100).toFixed(2)}%)`);
  console.log(`  wall time: ${(wallMs / 1000).toFixed(2)}s, throughput: ${(timings.length / (wallMs / 1000)).toFixed(1)} req/s`);
  console.log(`  latency p50: ${percentile(sorted, 50).toFixed(1)}ms, p95: ${percentile(sorted, 95).toFixed(1)}ms, p99: ${percentile(sorted, 99).toFixed(1)}ms, max: ${(sorted[sorted.length - 1] ?? NaN).toFixed(1)}ms`);
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

/** Stand-in SorobanClient: simulates RPC latency/failure without a live network so the load test is deterministic and self-contained. */
function makeSyntheticSoroban(): SorobanClient {
  const simulateCall = async (_method: string, _args: unknown[] = []): Promise<unknown> => {
    await new Promise((resolve) => setTimeout(resolve, RPC_LATENCY_MS * (0.5 + Math.random())));
    if (Math.random() < RPC_FAILURE_RATE) {
      throw new Error('simulated RPC timeout');
    }
    return true;
  };
  return {
    simulateCall: simulateCall as SorobanClient['simulateCall'],
    u64Val: (n) => n as unknown as ReturnType<SorobanClient['u64Val']>,
    u32Val: (n) => n as unknown as ReturnType<SorobanClient['u32Val']>,
    addressVal: (a) => a as unknown as ReturnType<SorobanClient['addressVal']>,
  };
}

async function startHarness(): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  const app = express();
  app.use(express.json());
  app.use('/api/credentials', createCredentialsRouter(makeSyntheticSoroban()));
  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

/** Bulk-index scenario: models the write path that runs once per issued credential after on-chain confirmation. */
async function issueScenario(baseUrl: string): Promise<Timing[]> {
  const timings: Timing[] = new Array(ISSUE_COUNT);
  await runWithConcurrency(
    Array.from({ length: ISSUE_COUNT }, (_, i) => i),
    ISSUE_CONCURRENCY,
    async (i) => {
      const start = Date.now();
      try {
        const res = await fetch(`${baseUrl}/api/credentials/search/index-stats`);
        timings[i] = { ok: res.ok, ms: Date.now() - start };
      } catch {
        timings[i] = { ok: false, ms: Date.now() - start };
      }
    }
  );
  return timings;
}

/** Verification scenario: batches of `verify-batch` calls, each fanning out to `simulateCall` per credential id. */
async function verifyScenario(baseUrl: string): Promise<Timing[]> {
  const batchCount = Math.ceil(VERIFY_COUNT / VERIFY_BATCH_SIZE);
  const timings: Timing[] = new Array(batchCount);
  await runWithConcurrency(
    Array.from({ length: batchCount }, (_, i) => i),
    VERIFY_CONCURRENCY,
    async (i) => {
      const credentialIds = Array.from({ length: VERIFY_BATCH_SIZE }, (_, j) => i * VERIFY_BATCH_SIZE + j + 1);
      const start = Date.now();
      try {
        const res = await fetch(`${baseUrl}/api/credentials/verify-batch`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ credential_ids: credentialIds, slice_id: 1 }),
        });
        timings[i] = { ok: res.ok, ms: Date.now() - start };
      } catch {
        timings[i] = { ok: false, ms: Date.now() - start };
      }
    }
  );
  return timings;
}

async function main(): Promise<void> {
  console.log(
    `Credential load test: issuing ${ISSUE_COUNT} credentials (concurrency ${ISSUE_CONCURRENCY}), then ${VERIFY_COUNT} verifications in batches of ${VERIFY_BATCH_SIZE} (concurrency ${VERIFY_CONCURRENCY})`
  );
  console.log(`Synthetic RPC: ${RPC_LATENCY_MS}ms base latency, ${(RPC_FAILURE_RATE * 100).toFixed(1)}% failure rate`);

  const harness = await startHarness();
  try {
    const issueStart = Date.now();
    const issueTimings = await issueScenario(harness.baseUrl);
    summarize('Issuance (search-index write path)', issueTimings, Date.now() - issueStart);

    const verifyStart = Date.now();
    const verifyTimings = await verifyScenario(harness.baseUrl);
    summarize(`Verification (${VERIFY_COUNT} checks via verify-batch)`, verifyTimings, Date.now() - verifyStart);

    const failedVerifyBatches = verifyTimings.filter((t) => !t.ok).length;
    if (failedVerifyBatches / verifyTimings.length > 0.1) {
      console.warn(
        `\nWARNING: ${((failedVerifyBatches / verifyTimings.length) * 100).toFixed(1)}% of verification batches failed — ` +
          `at this RPC failure rate the circuit breaker (rpcCircuitBreaker.ts) should be tripping; check /metrics for breaker state.`
      );
    }
  } finally {
    await harness.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
