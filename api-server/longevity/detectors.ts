/**
 * Issue #1632: leak and resource-exhaustion detection over longevity samples.
 *
 * Every detector looks only at samples after the warm-up period (JIT, caches
 * and connection pools settle during warm-up) and fits a least-squares line to
 * the metric. A metric counts as leaking when it grows steadily: the slope is
 * above the budget AND the fit is good (R² high), so ordinary GC saw-tooth
 * noise does not trigger it.
 */
import type { Sample } from './monitor.js';

export type Severity = 'pass' | 'warn' | 'fail';

export type Finding = {
  check: string;
  severity: Severity;
  detail: string;
  metric?: string;
  slopePerHour?: number;
  r2?: number;
};

export type Thresholds = {
  warmupSec: number;
  /** Max tolerated steady heap growth, MB per hour. */
  heapGrowthMbPerHour: number;
  /** Max tolerated steady RSS growth, MB per hour. */
  rssGrowthMbPerHour: number;
  /** Min R² for a trend to count as steady growth rather than noise. */
  minR2: number;
  /** Fraction of V8 heap limit that counts as near exhaustion. */
  heapLimitFraction: number;
  /** Max tolerated growth in open FDs / active handles over the run. */
  maxFdGrowth: number;
  maxHandleGrowth: number;
  eventLoopP99Ms: number;
  maxErrorRate: number;
  /** p99 latency growth between first and last quarter that counts as degradation. */
  latencyDegradationFactor: number;
};

export const DEFAULT_THRESHOLDS: Thresholds = {
  warmupSec: 60,
  heapGrowthMbPerHour: 10,
  rssGrowthMbPerHour: 25,
  minR2: 0.6,
  heapLimitFraction: 0.85,
  maxFdGrowth: 20,
  maxHandleGrowth: 20,
  eventLoopP99Ms: 100,
  maxErrorRate: 0.01,
  latencyDegradationFactor: 2,
};

export function linearFit(xs: number[], ys: number[]): { slope: number; intercept: number; r2: number } {
  const n = xs.length;
  if (n < 3) return { slope: 0, intercept: ys[0] ?? 0, r2: 0 };
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let i = 0; i < n; i++) {
    sxy += (xs[i] - mx) * (ys[i] - my);
    sxx += (xs[i] - mx) ** 2;
    syy += (ys[i] - my) ** 2;
  }
  const slope = sxx === 0 ? 0 : sxy / sxx;
  const r2 = sxx === 0 || syy === 0 ? 0 : (sxy * sxy) / (sxx * syy);
  return { slope, intercept: my - slope * mx, r2 };
}

function trendCheck(
  check: string,
  samples: Sample[],
  pick: (s: Sample) => number,
  budgetPerHour: number,
  minR2: number,
  unit: string,
): Finding {
  const { slope, r2 } = linearFit(
    samples.map((s) => s.t),
    samples.map(pick),
  );
  const perHour = slope * 3600;
  const steady = r2 >= minR2;
  let severity: Severity = 'pass';
  if (steady && perHour > budgetPerHour) severity = 'fail';
  else if (steady && perHour > budgetPerHour / 2) severity = 'warn';
  return {
    check,
    severity,
    metric: check,
    slopePerHour: Math.round(perHour * 100) / 100,
    r2: Math.round(r2 * 1000) / 1000,
    detail:
      `${perHour >= 0 ? '+' : ''}${perHour.toFixed(2)} ${unit}/h (R²=${r2.toFixed(2)}, budget ${budgetPerHour} ${unit}/h)` +
      (severity === 'pass' && !steady && perHour > budgetPerHour ? ' — growth is noisy, not steady' : ''),
  };
}

function growth(samples: Sample[], pick: (s: Sample) => number | null): number | null {
  const vals = samples.map(pick).filter((v): v is number => v !== null);
  if (vals.length < 2) return null;
  // compare medians of first and last 10% to ignore single spikes
  const k = Math.max(1, Math.floor(vals.length / 10));
  const med = (a: number[]) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];
  return med(vals.slice(-k)) - med(vals.slice(0, k));
}

export function analyse(all: Sample[], th: Thresholds, opts: { external: boolean }): Finding[] {
  const samples = all.filter((s) => s.t >= th.warmupSec);
  if (samples.length < 5) {
    return [
      {
        check: 'sample-count',
        severity: 'warn',
        detail: `only ${samples.length} post-warm-up samples; run longer for meaningful leak detection`,
      },
    ];
  }
  const findings: Finding[] = [];

  // ── Memory leaks ─────────────────────────────────────────────────────────
  if (!opts.external) {
    findings.push(trendCheck('heap-used-growth', samples, (s) => s.heapUsedMb, th.heapGrowthMbPerHour, th.minR2, 'MB'));
    findings.push(
      trendCheck('external-memory-growth', samples, (s) => s.externalMb + s.arrayBuffersMb, th.heapGrowthMbPerHour, th.minR2, 'MB'),
    );
  }
  findings.push(trendCheck('rss-growth', samples, (s) => s.rssMb, th.rssGrowthMbPerHour, th.minR2, 'MB'));

  // ── Resource exhaustion ──────────────────────────────────────────────────
  if (!opts.external) {
    const peak = Math.max(...samples.map((s) => s.heapUsedMb / s.heapLimitMb));
    findings.push({
      check: 'heap-limit-headroom',
      severity: peak >= th.heapLimitFraction ? 'fail' : peak >= th.heapLimitFraction * 0.75 ? 'warn' : 'pass',
      detail: `peak heap usage ${(peak * 100).toFixed(1)}% of V8 limit (fail at ${(th.heapLimitFraction * 100).toFixed(0)}%)`,
    });

    const handleGrowth = growth(samples, (s) => s.activeHandles) ?? 0;
    findings.push({
      check: 'active-handle-growth',
      severity: handleGrowth > th.maxHandleGrowth ? 'fail' : handleGrowth > th.maxHandleGrowth / 2 ? 'warn' : 'pass',
      detail: `active handles grew by ${handleGrowth} (sockets/timers not released; limit ${th.maxHandleGrowth})`,
    });
  }

  const fdGrowth = growth(samples, (s) => s.openFds);
  findings.push(
    fdGrowth === null
      ? { check: 'fd-growth', severity: 'pass', detail: 'open FD count unavailable on this platform (skipped)' }
      : {
          check: 'fd-growth',
          severity: fdGrowth > th.maxFdGrowth ? 'fail' : fdGrowth > th.maxFdGrowth / 2 ? 'warn' : 'pass',
          detail: `open file descriptors grew by ${fdGrowth} (limit ${th.maxFdGrowth})`,
        },
  );

  const worstLoop = Math.max(...samples.map((s) => s.eventLoopP99Ms));
  findings.push({
    check: 'event-loop-lag',
    severity: worstLoop > th.eventLoopP99Ms ? 'fail' : worstLoop > th.eventLoopP99Ms / 2 ? 'warn' : 'pass',
    detail: `worst per-interval event-loop p99 ${worstLoop.toFixed(1)} ms (limit ${th.eventLoopP99Ms} ms)`,
  });

  // ── Functional degradation ───────────────────────────────────────────────
  const last = all[all.length - 1];
  const errorRate = last.requests === 0 ? 0 : last.errors / last.requests;
  findings.push({
    check: 'error-rate',
    severity: errorRate > th.maxErrorRate ? 'fail' : errorRate > th.maxErrorRate / 2 ? 'warn' : 'pass',
    detail: `${last.errors} errors / ${last.requests} requests (${(errorRate * 100).toFixed(3)}%, limit ${(th.maxErrorRate * 100).toFixed(2)}%)`,
  });

  const q = Math.max(1, Math.floor(samples.length / 4));
  const avg = (a: Sample[]) => a.reduce((acc, s) => acc + s.latencyP99Ms, 0) / a.length;
  const early = avg(samples.slice(0, q));
  const late = avg(samples.slice(-q));
  const ratio = early > 0 ? late / early : 1;
  findings.push({
    check: 'latency-degradation',
    severity: ratio > th.latencyDegradationFactor ? 'fail' : ratio > (1 + th.latencyDegradationFactor) / 2 ? 'warn' : 'pass',
    detail: `p99 latency ${early.toFixed(2)} ms (first quarter) → ${late.toFixed(2)} ms (last quarter), ×${ratio.toFixed(2)}`,
  });

  return findings;
}
