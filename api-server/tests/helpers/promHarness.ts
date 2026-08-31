/**
 * Spawns a real `prometheus` binary against a generated config that scrapes
 * a given target and loads the repo's actual monitoring/prometheus/alerts.yml
 * (not a copy), so the integration tests in
 * criticalEventPrometheusIntegration.test.ts exercise the real rule
 * definitions rather than a hand-maintained fixture that could drift from
 * them.
 *
 * Mirrors the process-spawning/readiness-polling shape of wsCluster.ts, but
 * targets an external binary rather than a tsx harness, and polls Prometheus's
 * own HTTP readiness endpoint instead of a stdout marker (log line formats
 * differ across Prometheus versions; the HTTP API doesn't).
 */
import { spawn, execSync, type ChildProcessWithoutNullStreams } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const REAL_ALERTS_YML_PATH = path.resolve(__dirname, '..', '..', '..', 'monitoring', 'prometheus', 'alerts.yml');

function resolveBinary(envVar: string, fallback: string): string | null {
  const fromEnv = process.env[envVar];
  if (fromEnv && fs.existsSync(fromEnv)) return fromEnv;
  try {
    return execSync(`which ${fallback}`, { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim() || null;
  } catch {
    return null;
  }
}

export function prometheusBinary(): string | null {
  return resolveBinary('PROMETHEUS_BIN', 'prometheus');
}

export function promtoolBinary(): string | null {
  return resolveBinary('PROMTOOL_BIN', 'promtool');
}

async function waitForHttpOk(url: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastErr: unknown;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch (err) {
      lastErr = err;
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`Timed out waiting for ${url} to return 200: ${String(lastErr)}`);
}

export interface PrometheusHandle {
  baseUrl: string;
  /** Runs an instant PromQL query and returns the `data.result` array. */
  query: (promql: string) => Promise<Array<{ metric: Record<string, string>; value: [number, string] }>>;
  stop: () => Promise<void>;
}

export interface StartPrometheusOptions {
  /** host:port the scrape job should target. */
  scrapeTarget: string;
  metricsPath: string;
  scrapeIntervalSeconds: number;
  port: number;
}

export async function startPrometheusAgainstFixture(opts: StartPrometheusOptions): Promise<PrometheusHandle> {
  const bin = prometheusBinary();
  if (!bin) throw new Error('prometheus binary not found (set PROMETHEUS_BIN or install it on PATH)');

  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'prom-integration-'));
  const configPath = path.join(workDir, 'prometheus.yml');
  const tsdbPath = path.join(workDir, 'data');
  fs.mkdirSync(tsdbPath, { recursive: true });

  const config = `
global:
  scrape_interval: ${opts.scrapeIntervalSeconds}s
  evaluation_interval: ${opts.scrapeIntervalSeconds}s
rule_files:
  - "${REAL_ALERTS_YML_PATH}"
scrape_configs:
  - job_name: "api-server-critical-events-fixture"
    metrics_path: ${opts.metricsPath}
    static_configs:
      - targets: ["${opts.scrapeTarget}"]
    scrape_interval: ${opts.scrapeIntervalSeconds}s
`;
  fs.writeFileSync(configPath, config);

  const baseUrl = `http://127.0.0.1:${opts.port}`;
  const proc = spawn(
    bin,
    [
      `--config.file=${configPath}`,
      `--storage.tsdb.path=${tsdbPath}`,
      `--web.listen-address=127.0.0.1:${opts.port}`,
      '--log.level=warn',
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] }
  ) as ChildProcessWithoutNullStreams;

  let stderr = '';
  proc.stderr.on('data', (chunk) => {
    stderr += chunk.toString();
  });

  try {
    await waitForHttpOk(`${baseUrl}/-/ready`, 15_000);
  } catch (err) {
    proc.kill('SIGKILL');
    throw new Error(`prometheus failed to become ready: ${String(err)}\n--- stderr ---\n${stderr}`);
  }

  return {
    baseUrl,
    query: async (promql: string) => {
      const res = await fetch(`${baseUrl}/api/v1/query?query=${encodeURIComponent(promql)}`);
      const body = (await res.json()) as { status: string; data?: { result: Array<{ metric: Record<string, string>; value: [number, string] }> } };
      if (body.status !== 'success') throw new Error(`query failed: ${JSON.stringify(body)}`);
      return body.data?.result ?? [];
    },
    stop: () =>
      new Promise((resolve) => {
        proc.once('exit', () => resolve());
        proc.kill('SIGTERM');
        setTimeout(() => {
          if (!proc.killed) proc.kill('SIGKILL');
          resolve();
        }, 3000);
      }),
  };
}

/** Polls `query` every 300ms until `predicate` matches one of the results, or throws after timeoutMs. */
export async function pollUntil<T>(
  query: () => Promise<T[]>,
  predicate: (results: T[]) => boolean,
  timeoutMs: number,
  label: string
): Promise<T[]> {
  const deadline = Date.now() + timeoutMs;
  let last: T[] = [];
  while (Date.now() < deadline) {
    last = await query();
    if (predicate(last)) return last;
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`Timed out waiting for ${label}. Last result: ${JSON.stringify(last)}`);
}
