/**
 * Issue #1632: resource sampling for longevity runs.
 *
 * Collects one `Sample` per interval: memory (heap, RSS, external, array
 * buffers), event-loop delay, active handles/requests, open file descriptors
 * and request counters. In external mode (`targetPid`) RSS and FD counts are
 * read from /proc/<pid> for the process under test instead.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { monitorEventLoopDelay, type IntervalHistogram } from 'node:perf_hooks';
import v8 from 'node:v8';

export type Sample = {
  /** Seconds since the run started. */
  t: number;
  heapUsedMb: number;
  heapTotalMb: number;
  heapLimitMb: number;
  rssMb: number;
  externalMb: number;
  arrayBuffersMb: number;
  eventLoopP50Ms: number;
  eventLoopP99Ms: number;
  eventLoopMaxMs: number;
  activeHandles: number;
  activeRequests: number;
  openFds: number | null;
  requests: number;
  errors: number;
  rps: number;
  latencyP99Ms: number;
};

export type Counters = {
  requests: number;
  errors: number;
  latenciesMs: number[];
};

const MB = 1024 * 1024;

function round(n: number, digits = 2): number {
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx];
}

function countFds(pid: number | 'self'): number | null {
  try {
    return readdirSync(`/proc/${pid}/fd`).length;
  } catch {
    return null; // not Linux, or no permission
  }
}

function procRssMb(pid: number): number | null {
  try {
    const status = readFileSync(`/proc/${pid}/status`, 'utf8');
    const m = status.match(/^VmRSS:\s+(\d+)\s+kB/m);
    return m ? Number(m[1]) / 1024 : null;
  } catch {
    return null;
  }
}

function activeResourceCounts(): { handles: number; requests: number } {
  // getActiveResourcesInfo is public (Node >= 17); the underscore APIs are a fallback.
  const proc = process as unknown as {
    getActiveResourcesInfo?: () => string[];
    _getActiveHandles?: () => unknown[];
    _getActiveRequests?: () => unknown[];
  };
  if (proc.getActiveResourcesInfo) {
    const info = proc.getActiveResourcesInfo();
    const requests = info.filter((r) => r.endsWith('Req') || r === 'FSReqCallback').length;
    return { handles: info.length - requests, requests };
  }
  return {
    handles: proc._getActiveHandles?.().length ?? 0,
    requests: proc._getActiveRequests?.().length ?? 0,
  };
}

export class ResourceMonitor {
  readonly samples: Sample[] = [];
  private readonly loop: IntervalHistogram;
  private readonly start = performance.now();
  private timer?: NodeJS.Timeout;
  private lastRequests = 0;
  private lastT = 0;

  constructor(
    private readonly counters: Counters,
    private readonly opts: { intervalMs: number; targetPid?: number; forceGc: boolean },
  ) {
    this.loop = monitorEventLoopDelay({ resolution: 10 });
  }

  startSampling(onSample?: (s: Sample) => void): void {
    this.loop.enable();
    this.timer = setInterval(() => {
      const s = this.sample();
      this.samples.push(s);
      onSample?.(s);
    }, this.opts.intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.loop.disable();
  }

  sample(): Sample {
    // Collecting garbage first makes heapUsed reflect retained memory rather than
    // allocation churn, which is what leak detection needs.
    const gc = (globalThis as { gc?: () => void }).gc;
    if (this.opts.forceGc && gc) gc();

    const mem = process.memoryUsage();
    const heapStats = v8.getHeapStatistics();
    const res = activeResourceCounts();
    const t = (performance.now() - this.start) / 1000;

    const lat = this.counters.latenciesMs.splice(0).sort((a, b) => a - b);
    const dt = Math.max(0.001, t - this.lastT);
    const rps = (this.counters.requests - this.lastRequests) / dt;
    this.lastRequests = this.counters.requests;
    this.lastT = t;

    const pid = this.opts.targetPid;
    const externalRss = pid ? procRssMb(pid) : null;

    const s: Sample = {
      t: round(t, 1),
      heapUsedMb: round(mem.heapUsed / MB),
      heapTotalMb: round(mem.heapTotal / MB),
      heapLimitMb: round(heapStats.heap_size_limit / MB),
      rssMb: round(externalRss ?? mem.rss / MB),
      externalMb: round(mem.external / MB),
      arrayBuffersMb: round(mem.arrayBuffers / MB),
      eventLoopP50Ms: round(this.loop.percentile(50) / 1e6),
      eventLoopP99Ms: round(this.loop.percentile(99) / 1e6),
      eventLoopMaxMs: round(this.loop.max / 1e6),
      activeHandles: res.handles,
      activeRequests: res.requests,
      openFds: countFds(pid ?? 'self'),
      requests: this.counters.requests,
      errors: this.counters.errors,
      rps: round(rps, 1),
      latencyP99Ms: round(percentile(lat, 99)),
    };
    this.loop.reset();
    return s;
  }
}
