/**
 * Spawns tests/helpers/criticalEventFixtureHarness.ts as its own process
 * (same shape as startHarnessInstance in wsCluster.ts) and exposes a
 * `emit(category, count)` control call over HTTP.
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';
import { getFreePort } from './wsCluster.js';
import type { CriticalEventCategory } from '../../src/services/criticalEventListener.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const harnessPath = path.join(__dirname, 'criticalEventFixtureHarness.ts');
const tsxBin = path.join(__dirname, '..', '..', 'node_modules', '.bin', 'tsx');

function waitForStdout(
  proc: ChildProcessWithoutNullStreams,
  predicate: (line: string) => boolean,
  timeoutMs: number,
  label: string
): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timeout waiting for ${label}`)), timeoutMs);
    let buf = '';
    const onData = (chunk: Buffer) => {
      buf += chunk.toString();
      for (const line of buf.split('\n')) {
        if (predicate(line)) {
          clearTimeout(timer);
          proc.stdout.off('data', onData);
          resolve();
          return;
        }
      }
    };
    proc.stdout.on('data', onData);
  });
}

export interface CriticalEventFixtureHandle {
  baseUrl: string;
  emit: (category: CriticalEventCategory, count: number) => Promise<void>;
  stop: () => Promise<void>;
}

export interface StartCriticalEventFixtureOptions {
  /** Set to force every alert-dispatch attempt to fail (used to drive CriticalEventAlertingDegraded). */
  slackWebhookUrl?: string;
}

export async function startCriticalEventFixture(opts: StartCriticalEventFixtureOptions = {}): Promise<CriticalEventFixtureHandle> {
  const port = await getFreePort();
  const proc = spawn(tsxBin, [harnessPath], {
    env: {
      ...process.env,
      PORT: String(port),
      // Unset unless the caller wants forced failures — an inherited real
      // webhook/routing key from the dev environment would make this
      // non-deterministic.
      SLACK_ALERT_WEBHOOK_URL: opts.slackWebhookUrl ?? '',
      PAGERDUTY_ROUTING_KEY: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  }) as ChildProcessWithoutNullStreams;

  proc.stderr.on('data', (chunk) => {
    process.stderr.write(`[critical-event-fixture:${port}] ${chunk}`);
  });

  await waitForStdout(proc, (line) => line.includes('HARNESS_READY'), 15_000, `critical-event fixture on port ${port}`);

  const baseUrl = `http://127.0.0.1:${port}`;
  return {
    baseUrl,
    emit: async (category, count) => {
      const res = await fetch(`${baseUrl}/fixture/emit`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ category, count }),
      });
      if (!res.ok) throw new Error(`fixture emit failed: HTTP ${res.status}`);
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
