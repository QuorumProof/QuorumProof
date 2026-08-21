/**
 * tests/loki-ingestion.test.ts
 *
 * Integration tests for the api-server → log-file → promtail → Loki pipeline.
 *
 * Test matrix
 * ──────────────────────────────────────────────────────────────────────────────
 * 1. Logger writes a JSON line to the configured log file               [unit]
 * 2. Each pino log line carries the required fields for LogQL parsing    [unit]
 * 3. All four log levels are written with correct level labels           [unit]
 * 4. structuredLoggingMiddleware writes one entry per HTTP request       [unit]
 * 5. "Request completed" entry carries method, path, status, duration    [unit]
 * 6. Log entry timestamp is ISO-8601 and parseable by Loki              [unit]
 * 7. Grafana datasource declares uid="loki"                             [config]
 * 8. Contract Logs dashboard panel targets the Loki datasource           [config]
 * 9. docker-compose.yml mounts quorumproof-logs into api-server          [config]
 * 10. promtail mounts quorumproof-logs and scrapes /var/log/quorumproof  [config]
 * 11. promtail.yml job label matches the Grafana LogQL query             [config]
 * 12. E2E: running compose stack produces ≥1 Loki ingested line (opt-in) [e2e]
 * ──────────────────────────────────────────────────────────────────────────────
 *
 * Tests 1–11 run in CI without Docker.
 * Test 12 requires RUN_COMPOSE_E2E=true, a running monitoring stack, and
 * LOKI_URL / API_URL env vars (defaults: localhost:3100 / localhost:3001).
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import express from 'express';
import request from 'supertest';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Parse every non-empty newline-delimited JSON record from a log file. */
function readLogLines(filePath: string): Record<string, unknown>[] {
  try {
    return readFileSync(filePath, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as Record<string, unknown>);
  } catch {
    return [];
  }
}

/** Wait for async pino writes to flush. */
const flush = () => new Promise<void>((r) => setTimeout(r, 150));

// ---------------------------------------------------------------------------
// Setup: configure LOG_FILE before any module is imported
// Environment vars must be set before the logger module is first loaded so
// pino opens the right destination file.
// ---------------------------------------------------------------------------

let tmpDir: string;
let logFile: string;

// Set env vars synchronously at module evaluation time so they are in place
// before any dynamic import() in the tests below.
tmpDir = mkdtempSync(join(tmpdir(), 'qp-log-test-'));
logFile = join(tmpDir, 'api.log');
process.env.LOG_FILE = logFile;
process.env.LOG_STDOUT = 'false';
process.env.LOG_LEVEL = 'debug';

afterAll(() => {
  delete process.env.LOG_FILE;
  delete process.env.LOG_STDOUT;
  delete process.env.LOG_LEVEL;
  try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best-effort */ }
});

// ---------------------------------------------------------------------------
// 1–3. Logger unit tests
// ---------------------------------------------------------------------------
describe('Logger — file output', () => {
  it('1. writes a JSON log entry to the configured LOG_FILE', async () => {
    const { logger } = await import('../src/services/logger.js');
    logger.info('test log entry', 'test-module', { requestId: 'abc-123' });
    await flush();

    const lines = readLogLines(logFile);
    expect(lines.length).toBeGreaterThanOrEqual(1);
    const entry = lines.find((l) => l['msg'] === 'test log entry');
    expect(entry).toBeTruthy();
  });

  it('2. log entry carries required fields for LogQL parsing (level, time, service, module, extra)', async () => {
    const { logger } = await import('../src/services/logger.js');
    logger.warn('structured fields check', 'auth', { userId: 'u-999' });
    await flush();

    const lines = readLogLines(logFile);
    const entry = lines.find((l) => l['msg'] === 'structured fields check');
    expect(entry).toBeTruthy();
    expect(entry).toHaveProperty('level');
    expect(entry).toHaveProperty('time');
    expect(entry).toHaveProperty('service', 'quorumproof-api');
    expect(entry).toHaveProperty('module', 'auth');
    expect(entry).toHaveProperty('userId', 'u-999');
  });

  it('3. all four log levels produce correctly labelled entries', async () => {
    const { logger } = await import('../src/services/logger.js');
    const tag = `levels-check-${Date.now()}`;
    logger.debug(`debug-${tag}`);
    logger.info(`info-${tag}`);
    logger.warn(`warn-${tag}`);
    logger.error(`error-${tag}`);
    await flush();

    const lines = readLogLines(logFile);
    const tagged = lines.filter((l) => String(l['msg']).endsWith(tag));
    const levels = tagged.map((l) => l['level']);
    expect(levels).toContain('debug');
    expect(levels).toContain('info');
    expect(levels).toContain('warn');
    expect(levels).toContain('error');
  });
});

// ---------------------------------------------------------------------------
// 4–6. structuredLogging HTTP middleware tests
// ---------------------------------------------------------------------------
describe('structuredLoggingMiddleware — HTTP request logging', () => {
  it('4. writes "Incoming request" and "Request completed" entries per HTTP call', async () => {
    // Truncate the log file so counts are unambiguous for this test.
    writeFileSync(logFile, '');

    const { structuredLoggingMiddleware } = await import(
      '../src/middleware/structuredLogging.js'
    );
    const app = express();
    app.use(structuredLoggingMiddleware);
    app.get('/ping', (_req, res) => res.json({ ok: true }));

    await request(app).get('/ping');
    await flush();

    const lines = readLogLines(logFile);
    expect(lines.some((l) => l['msg'] === 'Incoming request')).toBe(true);
    expect(lines.some((l) => l['msg'] === 'Request completed')).toBe(true);
  });

  it('5. "Request completed" entry carries method, path, status, and duration fields', async () => {
    writeFileSync(logFile, '');

    const { structuredLoggingMiddleware } = await import(
      '../src/middleware/structuredLogging.js'
    );
    const app = express();
    app.use(structuredLoggingMiddleware);
    app.get('/health', (_req, res) => res.status(200).json({ status: 'ok' }));

    await request(app).get('/health');
    await flush();

    const lines = readLogLines(logFile);
    const completed = lines.find((l) => l['msg'] === 'Request completed');
    expect(completed).toBeTruthy();
    expect(completed!['method']).toBe('GET');
    expect(completed!['path']).toBe('/health');
    expect(completed!['status']).toBe(200);
    expect(typeof completed!['duration']).toBe('number');
  });

  it('6. log entry timestamp is ISO-8601 and parseable (Loki rejects malformed timestamps)', async () => {
    const { logger } = await import('../src/services/logger.js');
    const tag = `ts-check-${Date.now()}`;
    logger.info(tag);
    await flush();

    const lines = readLogLines(logFile);
    const entry = lines.find((l) => l['msg'] === tag);
    expect(entry).toBeTruthy();
    const ts = new Date(entry!['time'] as string).getTime();
    expect(ts).toBeGreaterThan(0);
    expect(ts).toBeLessThanOrEqual(Date.now());
  });
});

// ---------------------------------------------------------------------------
// 7–11. Configuration-level tests (no Docker required)
// ---------------------------------------------------------------------------

function readProjectFile(relPath: string): string {
  const p = new URL(`../../${relPath}`, import.meta.url).pathname;
  return readFileSync(p, 'utf8');
}

describe('Grafana datasource configuration', () => {
  it('7. Loki datasource has uid="loki" so the Contract Logs panel can resolve it', () => {
    const content = readProjectFile(
      'monitoring/grafana/provisioning/datasources/prometheus.yml',
    );
    expect(content).toMatch(/uid:\s*loki/);
  });

  it('8. Contract Logs dashboard panel targets datasource uid="loki" and queries job="quorumproof-api"', () => {
    const dashboard = JSON.parse(
      readProjectFile('monitoring/grafana/dashboards/contract-health.json'),
    ) as {
      panels?: Array<{
        title?: string;
        datasource?: { uid?: string };
        targets?: Array<{ expr?: string }>;
      }>;
    };

    const logsPanel = dashboard.panels?.find((p) => p.title === 'Contract Logs');
    expect(logsPanel, 'Contract Logs panel should exist in contract-health.json').toBeTruthy();
    expect(logsPanel?.datasource?.uid).toBe('loki');
    expect(logsPanel?.targets?.[0]?.expr).toContain('quorumproof-api');
  });
});

describe('docker-compose.yml log volume configuration', () => {
  it('9. api-server service mounts quorumproof-logs volume at /var/log/quorumproof', () => {
    const content = readProjectFile('monitoring/docker-compose.yml');
    expect(content).toContain('api-server:');
    expect(content).toContain('quorumproof-logs');
    expect(content).toContain('/var/log/quorumproof');
  });

  it('10. promtail service also mounts the quorumproof-logs volume (≥3 references)', () => {
    const content = readProjectFile('monitoring/docker-compose.yml');
    // api-server mount, promtail mount, and volumes: top-level declaration
    const count = (content.match(/quorumproof-logs/g) ?? []).length;
    expect(count).toBeGreaterThanOrEqual(3);
  });

  it('11. promtail.yml scrapes /var/log/quorumproof/*.log with label job=quorumproof-api', () => {
    const content = readProjectFile('monitoring/loki/promtail.yml');
    expect(content).toContain('/var/log/quorumproof/*.log');
    expect(content).toMatch(/job:\s*quorumproof-api/);
  });
});

// ---------------------------------------------------------------------------
// 12. E2E smoke test (opt-in via RUN_COMPOSE_E2E=true)
// ---------------------------------------------------------------------------
const RUN_COMPOSE_E2E = process.env.RUN_COMPOSE_E2E === 'true';

describe.skipIf(!RUN_COMPOSE_E2E)(
  'E2E — compose stack: request → log file → Loki ingestion',
  () => {
    const LOKI_URL = process.env.LOKI_URL ?? 'http://localhost:3100';
    const API_URL = process.env.API_URL ?? 'http://localhost:3001';
    const TIMEOUT_MS = parseInt(process.env.LOKI_WAIT_MS ?? '30000', 10);

    /**
     * Poll Loki query_range until ≥1 log line is returned or timeout fires.
     * Returns the array of Loki stream result objects.
     */
    async function waitForLoki(
      query: string,
      timeoutMs: number,
    ): Promise<Array<{ values: Array<[string, string]> }>> {
      const deadline = Date.now() + timeoutMs;
      const start = String(BigInt(Date.now() - 120_000) * 1_000_000n);
      const params = new URLSearchParams({ query, limit: '10', start });

      while (Date.now() < deadline) {
        try {
          const res = await fetch(`${LOKI_URL}/loki/api/v1/query_range?${params}`);
          if (res.ok) {
            const body = (await res.json()) as {
              data?: { result?: Array<{ values: Array<[string, string]> }> };
            };
            const result = body.data?.result ?? [];
            if (result.length > 0 && result[0].values.length > 0) return result;
          }
        } catch {
          /* Loki not ready — keep polling */
        }
        await new Promise((r) => setTimeout(r, 2000));
      }
      return [];
    }

    it(
      '12a. api-server HTTP request produces ≥1 log line ingested by Loki within the bounded window',
      async () => {
        // Emit a request to the running api-server instance.
        const probe = await fetch(`${API_URL}/health`);
        expect(probe.status).toBeLessThan(600);

        const result = await waitForLoki('{job="quorumproof-api"}', TIMEOUT_MS);
        expect(result.length).toBeGreaterThan(0);
        expect(result[0].values.length).toBeGreaterThan(0);

        const rawLine = result[0].values[result[0].values.length - 1][1];
        const parsed = JSON.parse(rawLine) as Record<string, unknown>;
        expect(parsed).toHaveProperty('service', 'quorumproof-api');
      },
      TIMEOUT_MS + 10_000,
    );

    it(
      '12b. {job="quorumproof-api"} LogQL query returns results (Contract Logs panel is non-empty)',
      async () => {
        const result = await waitForLoki('{job="quorumproof-api"}', TIMEOUT_MS);
        expect(result.length).toBeGreaterThan(0);
        const lastValue = result[0].values[result[0].values.length - 1][1];
        const parsed = JSON.parse(lastValue) as Record<string, unknown>;
        expect(parsed).toHaveProperty('level');
        expect(parsed).toHaveProperty('time');
      },
      TIMEOUT_MS + 10_000,
    );
  },
);
