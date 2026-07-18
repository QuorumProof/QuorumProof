/**
 * Spawns a real ephemeral Redis + N real Node child-process API server
 * instances, for tests/scripts that need genuine multi-process behavior
 * (as opposed to importing ws/server.ts twice in one process, which would
 * share module-level state and prove nothing about cross-instance delivery).
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import { createServer } from 'net';
import { fileURLToPath } from 'url';
import path from 'path';
import { execSync } from 'child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const harnessPath = path.join(__dirname, 'wsInstanceHarness.ts');
const tsxBin = path.join(__dirname, '..', '..', 'node_modules', '.bin', 'tsx');

export function redisServerAvailable(): boolean {
  try {
    execSync('which redis-server', { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

export async function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.listen(0, () => {
      const address = srv.address();
      if (address && typeof address === 'object') {
        const port = address.port;
        srv.close(() => resolve(port));
      } else {
        srv.close(() => reject(new Error('Could not determine free port')));
      }
    });
    srv.on('error', reject);
  });
}

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
      const lines = buf.split('\n');
      for (const line of lines) {
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

export interface RedisHandle {
  url: string;
  port: number;
  stop: () => Promise<void>;
}

export async function startEphemeralRedis(): Promise<RedisHandle> {
  const port = await getFreePort();
  const proc = spawn('redis-server', ['--port', String(port), '--save', '', '--appendonly', 'no'], {
    stdio: ['ignore', 'pipe', 'pipe'],
  }) as ChildProcessWithoutNullStreams;

  await waitForStdout(proc, (line) => line.includes('Ready to accept connections'), 10_000, 'redis-server startup');

  return {
    url: `redis://127.0.0.1:${port}`,
    port,
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

export interface InstanceHandle {
  port: number;
  baseUrl: string;
  stop: () => Promise<void>;
}

export async function startHarnessInstance(
  redisUrl: string,
  extraEnv: Record<string, string> = {}
): Promise<InstanceHandle> {
  const port = await getFreePort();
  const proc = spawn(tsxBin, [harnessPath], {
    env: {
      ...process.env,
      PORT: String(port),
      REDIS_URL: redisUrl,
      WS_INSTANCE_ID: `test-instance-${port}`,
      ...extraEnv,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  }) as ChildProcessWithoutNullStreams;

  proc.stderr.on('data', (chunk) => {
    // Surfaced for debugging test flakiness; harness instances shouldn't normally emit stderr.
    process.stderr.write(`[harness:${port}] ${chunk}`);
  });

  await waitForStdout(proc, (line) => line.includes(`HARNESS_READY ${port}`), 15_000, `harness instance on port ${port}`);

  return {
    port,
    baseUrl: `http://127.0.0.1:${port}`,
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
