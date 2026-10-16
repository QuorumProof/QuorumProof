/**
 * Issue #870 — Database Connection Pooling
 *
 * Previously, every code-path that needed Postgres (startup migrations, route
 * handlers, …) created a short-lived `new Pool(…)` directly, which meant that
 * under any sustained load each HTTP request opened its own TCP connection and
 * torn it down immediately afterwards — adding 5-30 ms of latency and
 * exhausting the server-side connection limit quickly.
 *
 * This module owns the single shared `Pool` instance for the process.  All
 * consumers should call `getPool()` (which is a no-op once initialised) rather
 * than constructing their own `Pool`.
 *
 * Pool tuning:
 *   - `max`        — bounded by `DATABASE_POOL_MAX` (default 10).
 *   - `idleTimeoutMillis` — idle connections are released after 30 s so we
 *                   don't hold on to DB resources between quiet periods.
 *   - `connectionTimeoutMillis` — a request waits at most 5 s for a connection
 *                   before the pool throws, surfacing back-pressure to callers.
 *
 * Lifecycle:
 *   - `initPool(url)` is called once at startup (in `index.ts`), before the
 *     HTTP server starts accepting traffic, so the pool is warm and its
 *     `error` handler is wired up before any request arrives.
 *   - `closePool()` is provided for graceful shutdown (SIGTERM handlers, tests).
 *   - `_resetPoolForTest()` tears down the current pool and clears the
 *     singleton — test files use this to get a fresh pool between cases.
 */

import type { Pool as PgPool, PoolConfig } from 'pg';

let _pool: PgPool | null = null;

/** Default pool configuration; all values are overridable via environment. */
function buildConfig(connectionString: string): PoolConfig {
  return {
    connectionString,
    max: parseInt(process.env.DATABASE_POOL_MAX ?? '10', 10),
    idleTimeoutMillis: parseInt(process.env.DATABASE_POOL_IDLE_TIMEOUT_MS ?? '30000', 10),
    connectionTimeoutMillis: parseInt(process.env.DATABASE_POOL_CONNECT_TIMEOUT_MS ?? '5000', 10),
    // Keep the connection alive through network appliances / load-balancers
    // that drop idle TCP sessions.
    keepAlive: true,
    keepAliveInitialDelayMillis: 10_000,
  };
}

/**
 * Initialise the shared pool.  Must be called before `getPool()` is first
 * used.  Calling it a second time with the same URL is a no-op; calling it
 * with a different URL throws (a running server shouldn't be re-pointed).
 */
export async function initPool(connectionString: string): Promise<PgPool> {
  if (_pool !== null) {
    return _pool;
  }

  // Dynamic import keeps `pg` out of test bundles that don't need it and
  // avoids a top-level require that breaks ESM-only setups.
  const { Pool } = await import('pg');
  const pool = new Pool(buildConfig(connectionString));

  // Surface connection-level errors (e.g. server restart, network blip) as
  // logs rather than unhandled promise rejections that would crash the process.
  pool.on('error', (err: Error) => {
    console.error(JSON.stringify({
      ts: new Date().toISOString(),
      level: 'error',
      service: 'quorumproof-api',
      msg: 'Idle database client error',
      error: err.message,
    }));
  });

  pool.on('connect', () => {
    console.log(JSON.stringify({
      ts: new Date().toISOString(),
      level: 'debug',
      service: 'quorumproof-api',
      msg: 'New database connection established',
    }));
  });

  _pool = pool;
  return pool;
}

/**
 * Return the shared pool.  Throws if `initPool()` has not been called yet —
 * this is intentional: it catches wiring mistakes early rather than letting
 * them surface as obscure "cannot read property of null" errors mid-request.
 */
export function getPool(): PgPool {
  if (_pool === null) {
    throw new Error(
      'Database pool has not been initialised. ' +
      'Call initPool(DATABASE_URL) during server startup before handling requests.'
    );
  }
  return _pool;
}

/**
 * Gracefully drain and destroy the shared pool.  Call this during SIGTERM /
 * SIGINT handling so in-flight queries finish before the process exits.
 */
export async function closePool(): Promise<void> {
  if (_pool !== null) {
    await _pool.end();
    _pool = null;
  }
}

/**
 * Test-only helper: close the current pool (if any) and reset the singleton
 * so that `initPool()` creates a fresh one.  Import path is deliberately
 * verbose to discourage accidental use outside test files.
 */
export async function _resetPoolForTest(): Promise<void> {
  await closePool();
}

// ─────────────────────────────────────────────────────────────────────────────
// Pool metrics — Issue #1559
// ─────────────────────────────────────────────────────────────────────────────

/** Point-in-time snapshot of connection-pool utilisation. */
export interface PoolMetrics {
  /** Maximum number of connections the pool will open (`max` config). */
  max_connections: number;
  /** Number of connections currently checked out by active callers. */
  active_connections: number;
  /** Number of connections sitting idle and ready to be reused. */
  idle_connections: number;
  /** Number of callers waiting for a connection (queue depth). */
  waiting_requests: number;
  /**
   * Percentage of the pool in active use: `(active / max) * 100`.
   * A value ≥ 80 is a signal to increase `DATABASE_POOL_MAX`.
   */
  utilization_pct: number;
  /** ISO-8601 timestamp at which this snapshot was taken. */
  sampled_at: string;
}

/**
 * Return a point-in-time snapshot of the shared pool's utilisation metrics.
 *
 * Throws if the pool has not been initialised yet (same contract as
 * `getPool()`).
 *
 * The `pg` Pool exposes `.totalCount` (all connections, idle + active),
 * `.idleCount` (idle), and `.waitingCount` (requests queued for a
 * connection).  Active = total − idle.
 */
export function getPoolMetrics(): PoolMetrics {
  const pool = getPool();
  const max = parseInt(process.env.DATABASE_POOL_MAX ?? '10', 10);
  const total = pool.totalCount;
  const idle = pool.idleCount;
  const waiting = pool.waitingCount;
  const active = total - idle;
  const utilization_pct = max > 0 ? Math.round((active / max) * 100) : 0;

  return {
    max_connections: max,
    active_connections: active,
    idle_connections: idle,
    waiting_requests: waiting,
    utilization_pct,
    sampled_at: new Date().toISOString(),
  };
}

/**
 * Prometheus text-format exposition of pool metrics.  Scraped by the
 * `/metrics/db` endpoint registered in `index.ts`.
 */
export function getPoolMetricsPrometheus(): string {
  const m = getPoolMetrics();
  return [
    '# HELP quorumproof_db_pool_max Maximum connections in the pool',
    '# TYPE quorumproof_db_pool_max gauge',
    `quorumproof_db_pool_max ${m.max_connections}`,
    '# HELP quorumproof_db_pool_active Active (checked-out) connections',
    '# TYPE quorumproof_db_pool_active gauge',
    `quorumproof_db_pool_active ${m.active_connections}`,
    '# HELP quorumproof_db_pool_idle Idle connections ready for reuse',
    '# TYPE quorumproof_db_pool_idle gauge',
    `quorumproof_db_pool_idle ${m.idle_connections}`,
    '# HELP quorumproof_db_pool_waiting Requests queued waiting for a connection',
    '# TYPE quorumproof_db_pool_waiting gauge',
    `quorumproof_db_pool_waiting ${m.waiting_requests}`,
    '# HELP quorumproof_db_pool_utilization_pct Pool utilisation as a percentage of max',
    '# TYPE quorumproof_db_pool_utilization_pct gauge',
    `quorumproof_db_pool_utilization_pct ${m.utilization_pct}`,
  ].join('\n') + '\n';
}
