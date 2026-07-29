/**
 * Benchmark: Compression Middleware Overhead
 * Issue #1313 — Gzip Compression
 *
 * Measures the latency and throughput impact of gzip compression at each
 * configured compression level (0–9) across three representative payload
 * sizes: small (< 1 KB), medium (10 KB), and large (100 KB).
 *
 * Run with: npx tsx scripts/benchmark-compression.ts
 *
 * Outputs a table like:
 *
 *   Payload      Level   Uncompressed   Compressed   Ratio   Throughput
 *   -------      -----   ------------   ----------   -----   ----------
 *   small         6      0.01 ms        N/A (skip)   -       -
 *   medium (10KB) 6      0.05 ms        0.82 ms      68.4%   12.5 MB/s
 *   large (100KB) 6      0.20 ms        6.10 ms      72.1%   15.9 MB/s
 *
 * Interpretation:
 *   - "Ratio" is (1 - compressedSize/originalSize) * 100 — higher is better.
 *   - "Throughput" is the decompressed MB per second the compressor achieves.
 *   - Small payloads below the 1 KB threshold are skipped by the middleware
 *     (shown as N/A).
 */

import zlib from 'zlib';
import { performance } from 'perf_hooks';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const ITERATIONS = 1000;   // Warmup + measurement iterations per scenario
const WARMUP = 100;        // Initial iterations discarded from timing
const THRESHOLD_BYTES = 1024; // Must match middleware default

// Compression levels to benchmark
const LEVELS = [1, 3, 6, 9] as const;

// ---------------------------------------------------------------------------
// Payload generation
// ---------------------------------------------------------------------------

type PayloadSpec = { name: string; bytes: number; content: Buffer };

function makeJsonPayload(targetBytes: number): Buffer {
  const obj: Record<string, unknown> = {
    credentials: [] as unknown[],
    metadata: {
      total: 0,
      page: 1,
      pageSize: 50,
      generatedAt: new Date().toISOString(),
    },
  };

  // Fill with realistic-looking JSON data (text compresses well)
  const credentials: unknown[] = [];
  const record = {
    id: 'cred_12345',
    subject: 'GABC123DEF456',
    issuer: 'GIBR_ENGINEERING_COUNCIL',
    credential_type: 2,
    metadata: {
      name: 'Professional Engineering License',
      jurisdiction: 'BR',
      expiry: '2028-01-01',
    },
    attestors: ['GATT1', 'GATT2', 'GATT3'],
    attested_at: new Date().toISOString(),
    revoked: false,
    suspended: false,
  };

  while (JSON.stringify(obj).length < targetBytes) {
    credentials.push({ ...record, id: `cred_${credentials.length}` });
    obj.credentials = credentials;
    obj.metadata = { ...obj.metadata as Record<string, unknown>, total: credentials.length };
  }

  return Buffer.from(JSON.stringify(obj));
}

const PAYLOADS: PayloadSpec[] = [
  { name: 'small  (< 1 KB)', bytes: 512,     content: makeJsonPayload(512)     },
  { name: 'medium (10 KB)',   bytes: 10240,   content: makeJsonPayload(10240)   },
  { name: 'large  (100 KB)',  bytes: 102400,  content: makeJsonPayload(102400)  },
];

// ---------------------------------------------------------------------------
// Benchmark runner
// ---------------------------------------------------------------------------

interface BenchResult {
  payloadName: string;
  payloadSize: number;
  level: number;
  skipped: boolean;            // true if below threshold
  avgCompressMs: number;
  p95CompressMs: number;
  compressedSize: number;
  ratio: number;               // 0–1, higher is more compression
  throughputMBps: number;
}

async function benchmarkLevel(payload: PayloadSpec, level: number): Promise<BenchResult> {
  if (payload.bytes < THRESHOLD_BYTES) {
    return {
      payloadName: payload.name,
      payloadSize: payload.bytes,
      level,
      skipped: true,
      avgCompressMs: 0,
      p95CompressMs: 0,
      compressedSize: 0,
      ratio: 0,
      throughputMBps: 0,
    };
  }

  const samples: number[] = [];
  let compressedSize = 0;

  for (let i = 0; i < ITERATIONS + WARMUP; i++) {
    const start = performance.now();
    const compressed = await new Promise<Buffer>((resolve, reject) => {
      zlib.gzip(payload.content, { level }, (err, result) => {
        if (err) reject(err);
        else resolve(result);
      });
    });
    const elapsed = performance.now() - start;

    if (i >= WARMUP) {
      samples.push(elapsed);
      if (i === WARMUP) compressedSize = compressed.length;
    }
  }

  samples.sort((a, b) => a - b);
  const avgCompressMs = samples.reduce((s, v) => s + v, 0) / samples.length;
  const p95CompressMs = samples[Math.floor(samples.length * 0.95)];
  const ratio = 1 - compressedSize / payload.bytes;
  const throughputMBps = (payload.bytes / 1_048_576) / (avgCompressMs / 1000);

  return {
    payloadName: payload.name,
    payloadSize: payload.bytes,
    level,
    skipped: false,
    avgCompressMs,
    p95CompressMs,
    compressedSize,
    ratio,
    throughputMBps,
  };
}

// ---------------------------------------------------------------------------
// Report formatting
// ---------------------------------------------------------------------------

function fmt(n: number, decimals = 2): string {
  return n.toFixed(decimals).padStart(8);
}

function printResults(results: BenchResult[]): void {
  console.log('\n=== Compression Benchmark Results ===\n');
  console.log(
    'Payload               Level  Orig(B)   Comp(B)   Ratio    Avg(ms)  P95(ms)  Throughput'
  );
  console.log('-'.repeat(95));

  for (const r of results) {
    if (r.skipped) {
      console.log(
        `${r.payloadName.padEnd(22)} ${String(r.level).padStart(3)}    ` +
        `${String(r.payloadSize).padStart(7)}   ${'(below threshold)'.padEnd(30)}`
      );
    } else {
      console.log(
        `${r.payloadName.padEnd(22)} ${String(r.level).padStart(3)}    ` +
        `${String(r.payloadSize).padStart(7)}   ` +
        `${String(r.compressedSize).padStart(7)}   ` +
        `${fmt(r.ratio * 100, 1)}%  ` +
        `${fmt(r.avgCompressMs, 3)} ms  ` +
        `${fmt(r.p95CompressMs, 3)} ms  ` +
        `${fmt(r.throughputMBps, 1)} MB/s`
      );
    }
  }

  console.log();
}

function summarise(results: BenchResult[]): void {
  const active = results.filter((r) => !r.skipped);
  if (active.length === 0) return;

  const level6 = active.filter((r) => r.level === 6);
  const avgRatio = level6.reduce((s, r) => s + r.ratio, 0) / level6.length;
  const avgThroughput = level6.reduce((s, r) => s + r.throughputMBps, 0) / level6.length;

  console.log('=== Summary (level=6 default) ===');
  console.log(`  Average compression ratio : ${(avgRatio * 100).toFixed(1)}%`);
  console.log(`  Average throughput        : ${avgThroughput.toFixed(1)} MB/s`);
  console.log(`  Threshold                 : ${THRESHOLD_BYTES} bytes`);
  console.log(`  Iterations (per scenario) : ${ITERATIONS} (${WARMUP} warmup discarded)`);
  console.log();
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

(async () => {
  console.log('Warming up…');

  const results: BenchResult[] = [];

  for (const payload of PAYLOADS) {
    for (const level of LEVELS) {
      process.stdout.write(`  ${payload.name} @ level ${level}…`);
      const result = await benchmarkLevel(payload, level);
      results.push(result);
      process.stdout.write(result.skipped ? ' skipped (below threshold)\n' : ' done\n');
    }
  }

  printResults(results);
  summarise(results);
})();
