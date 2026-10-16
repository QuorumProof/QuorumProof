/**
 * Issue #1632: longevity report writers (JSON, Markdown, CSV).
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Finding, Thresholds } from './detectors.js';
import type { Sample } from './monitor.js';

export type RunInfo = {
  startedAt: string;
  durationSec: number;
  mode: 'in-process' | 'external';
  target: string;
  concurrency: number;
  nodeVersion: string;
  gcExposed: boolean;
};

const ICON = { pass: '✅', warn: '⚠️', fail: '❌' } as const;

function sparkline(values: number[], width = 60): string {
  if (values.length === 0) return '';
  const bars = '▁▂▃▄▅▆▇█';
  const step = Math.max(1, Math.floor(values.length / width));
  const pts = values.filter((_, i) => i % step === 0);
  const min = Math.min(...pts);
  const max = Math.max(...pts);
  const span = max - min || 1;
  return pts.map((v) => bars[Math.min(bars.length - 1, Math.floor(((v - min) / span) * bars.length))]).join('');
}

export function verdict(findings: Finding[]): 'pass' | 'warn' | 'fail' {
  if (findings.some((f) => f.severity === 'fail')) return 'fail';
  if (findings.some((f) => f.severity === 'warn')) return 'warn';
  return 'pass';
}

export function renderMarkdown(info: RunInfo, samples: Sample[], findings: Finding[], th: Thresholds): string {
  const v = verdict(findings);
  const first = samples[0];
  const last = samples[samples.length - 1];
  const series = (name: string, pick: (s: Sample) => number | null, unit: string) => {
    const vals = samples.map(pick).filter((x): x is number => x !== null);
    if (vals.length === 0) return `| ${name} | n/a | n/a | n/a | |`;
    return `| ${name} | ${vals[0]} ${unit} | ${vals[vals.length - 1]} ${unit} | ${Math.max(...vals)} ${unit} | \`${sparkline(vals, 40)}\` |`;
  };

  return [
    `# Longevity Report — ${ICON[v]} ${v.toUpperCase()}`,
    '',
    '| | |',
    '|---|---|',
    `| Started | ${info.startedAt} |`,
    `| Duration | ${(info.durationSec / 60).toFixed(1)} min (warm-up ${th.warmupSec}s excluded from trends) |`,
    `| Mode | ${info.mode} — \`${info.target}\` |`,
    `| Concurrency | ${info.concurrency} |`,
    `| Requests | ${last?.requests ?? 0} (${last?.errors ?? 0} errors) |`,
    `| Node | ${info.nodeVersion}${info.gcExposed ? ' (GC forced before each sample)' : ' (run with --expose-gc for sharper leak detection)'} |`,
    '',
    '## Checks',
    '',
    '| | Check | Result |',
    '|---|---|---|',
    ...findings.map((f) => `| ${ICON[f.severity]} | ${f.check} | ${f.detail} |`),
    '',
    '## Resource trends',
    '',
    '| Metric | Start | End | Peak | Trend |',
    '|---|---|---|---|---|',
    series('Heap used', (s) => s.heapUsedMb, 'MB'),
    series('RSS', (s) => s.rssMb, 'MB'),
    series('External + ArrayBuffers', (s) => Math.round((s.externalMb + s.arrayBuffersMb) * 100) / 100, 'MB'),
    series('Active handles', (s) => s.activeHandles, ''),
    series('Open FDs', (s) => s.openFds, ''),
    series('Event-loop p99', (s) => s.eventLoopP99Ms, 'ms'),
    series('Request p99', (s) => s.latencyP99Ms, 'ms'),
    series('Throughput', (s) => s.rps, 'req/s'),
    '',
    first && last ? `_${samples.length} samples from t=${first.t}s to t=${last.t}s. Raw data: samples.csv / report.json._` : '',
    '',
  ].join('\n');
}

export function writeReports(dir: string, info: RunInfo, samples: Sample[], findings: Finding[], th: Thresholds): string {
  mkdirSync(dir, { recursive: true });
  const md = renderMarkdown(info, samples, findings, th);
  writeFileSync(join(dir, 'report.md'), md);
  writeFileSync(join(dir, 'report.json'), JSON.stringify({ verdict: verdict(findings), info, thresholds: th, findings, samples }, null, 2));
  if (samples.length > 0) {
    const cols = Object.keys(samples[0]) as (keyof Sample)[];
    const csv = [cols.join(','), ...samples.map((s) => cols.map((c) => s[c] ?? '').join(','))].join('\n');
    writeFileSync(join(dir, 'samples.csv'), csv + '\n');
  }
  return md;
}
