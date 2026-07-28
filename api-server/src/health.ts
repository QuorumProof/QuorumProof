/**
 * Issue #1308 — Health Check Endpoints
 *
 * Provides three health check endpoints for load balancers and orchestrators:
 *
 *   GET /health/live
 *     Liveness probe. Returns 200 if the API process is running. Load balancers
 *     use this to detect dead pods; should be fast and require minimal resources.
 *
 *   GET /health/ready
 *     Readiness probe. Returns 200 if the API is ready to accept traffic. This
 *     includes checks on external dependencies (database, Soroban RPC). If any
 *     dependency fails, returns 503 so the load balancer stops sending traffic
 *     until recovery.
 *
 *   GET /health (legacy)
 *     Combined status. Returns details on the current state including connection
 *     counts and component health.
 *
 * All endpoints are unauthenticated and bypass rate limiting so they can run
 * continuously during degraded states without interference.
 *
 * Configuration:
 *   HEALTH_CHECK_TIMEOUT_MS — timeout for dependency checks (default: 5000 ms)
 *   HEALTH_CHECK_DB_ENABLED — enable database connectivity check (default: true)
 *   HEALTH_CHECK_RPC_ENABLED — enable Soroban RPC check (default: true)
 */

import type { Request, Response } from 'express';
import { createLogger } from './logger.js';

const log = createLogger('health');

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const TIMEOUT_MS = parseInt(process.env.HEALTH_CHECK_TIMEOUT_MS ?? '5000', 10);
const DB_ENABLED = process.env.HEALTH_CHECK_DB_ENABLED !== 'false';
const RPC_ENABLED = process.env.HEALTH_CHECK_RPC_ENABLED !== 'false';

// ---------------------------------------------------------------------------
// Dependency health checks
// ---------------------------------------------------------------------------

/**
 * Check if the database pool (if configured) is healthy.
 * Runs a trivial query and measures latency.
 */
export async function checkDatabase(): Promise<{
  ok: boolean;
  latencyMs: number;
  error?: string;
}> {
  if (!DB_ENABLED) {
    return { ok: true, latencyMs: 0 }; // Skipped
  }

  const start = Date.now();

  try {
    const { getPool } = await import('./db.js');
    const pool = getPool();

    if (!pool) {
      // DATABASE_URL was not set; DB is optional.
      return { ok: true, latencyMs: 0 };
    }

    // Time out aggressively if the pool can't respond.
    const timeoutPromise = new Promise<never>((_resolve, reject) => {
      setTimeout(() => reject(new Error('pool timeout')), TIMEOUT_MS);
    });

    await Promise.race([
      pool.query('SELECT 1'),
      timeoutPromise,
    ]);

    const latencyMs = Date.now() - start;
    return { ok: true, latencyMs };
  } catch (err) {
    const latencyMs = Date.now() - start;
    const error = err instanceof Error ? err.message : String(err);
    log.warn('Database check failed', { latencyMs, error });
    return { ok: false, latencyMs, error };
  }
}

/**
 * Check if Soroban RPC (if configured) is healthy by querying the circuit
 * breaker status.
 */
export async function checkSorobanRpc(): Promise<{
  ok: boolean;
  latencyMs: number;
  circuitBreakerState?: string;
  error?: string;
}> {
  if (!RPC_ENABLED) {
    return { ok: true, latencyMs: 0 }; // Skipped
  }

  const start = Date.now();

  try {
    const { getDefaultRpcCircuitBreaker } = await import(
      './services/rpcCircuitBreaker.js'
    );

    const breaker = getDefaultRpcCircuitBreaker();
    const metrics = breaker.getMetrics();

    // If the circuit breaker is open, the RPC is degraded.
    const isOpen = metrics.state === 'open';
    const latencyMs = Date.now() - start;

    return {
      ok: !isOpen,
      latencyMs,
      circuitBreakerState: metrics.state,
    };
  } catch (err) {
    const latencyMs = Date.now() - start;
    const error = err instanceof Error ? err.message : String(err);
    log.warn('RPC check failed', { latencyMs, error });
    return { ok: false, latencyMs, error };
  }
}

// ---------------------------------------------------------------------------
// HTTP handlers
// ---------------------------------------------------------------------------

/**
 * GET /health/live — Liveness probe.
 * Returns 200 immediately. If this endpoint returns an error, the container
 * is likely stuck or crashed and should be restarted.
 */
export function handleLive(_req: Request, res: Response): void {
  res.json({
    status: 'live',
    ts: new Date().toISOString(),
  });
}

/**
 * GET /health/ready — Readiness probe.
 * Checks all configured dependencies. Returns 200 only if all are healthy;
 * otherwise 503 Service Unavailable.
 *
 * During graceful shutdown (draining phase), always returns 503 so load
 * balancers stop sending traffic.
 */
export async function handleReady(_req: Request, res: Response): Promise<void> {
  // Import here to avoid circular deps at startup.
  const { isDraining } = await import('./shutdown.js');

  if (isDraining()) {
    res.status(503).json({
      status: 'not_ready',
      reason: 'draining',
      ts: new Date().toISOString(),
    });
    return;
  }

  const start = Date.now();
  const checks: Record<string, unknown> = {};
  let allHealthy = true;

  // Run all checks in parallel.
  const [dbResult, rpcResult] = await Promise.all([
    checkDatabase(),
    checkSorobanRpc(),
  ]);

  if (DB_ENABLED) {
    checks.database = dbResult;
    if (!dbResult.ok) allHealthy = false;
  }

  if (RPC_ENABLED) {
    checks.soroban_rpc = rpcResult;
    if (!rpcResult.ok) allHealthy = false;
  }

  const latencyMs = Date.now() - start;

  if (allHealthy) {
    res.json({
      status: 'ready',
      ts: new Date().toISOString(),
      latencyMs,
      checks,
    });
  } else {
    res.status(503).json({
      status: 'not_ready',
      ts: new Date().toISOString(),
      latencyMs,
      checks,
    });
  }
}

/**
 * GET /health — Combined status (legacy, for backward compatibility).
 * Includes dependency checks and live connection metrics.
 */
export async function handleHealth(
  _req: Request,
  res: Response
): Promise<void> {
  const start = Date.now();

  const [dbResult, rpcResult] = await Promise.all([
    checkDatabase(),
    checkSorobanRpc(),
  ]);

  let allHealthy = true;
  if (DB_ENABLED && !dbResult.ok) allHealthy = false;
  if (RPC_ENABLED && !rpcResult.ok) allHealthy = false;

  const latencyMs = Date.now() - start;

  // Attempt to get live metrics if available (WebSocket connections).
  let wsConnections = 0;
  let wsSubscribers = 0;
  try {
    const { getConnectionCount } = await import(
      './ws/server.js'
    );
    const { getSubscriberCount } = await import(
      './ws/subscriptions.js'
    );
    wsConnections = getConnectionCount();
    wsSubscribers = getSubscriberCount();
  } catch {
    // WS module may not be available in all configurations; that's OK.
  }

  const status = allHealthy ? 'ok' : 'degraded';
  const statusCode = allHealthy ? 200 : 503;

  res.status(statusCode).json({
    status,
    ts: new Date().toISOString(),
    latencyMs,
    dependencies: {
      database: DB_ENABLED ? dbResult : { status: 'disabled' },
      soroban_rpc: RPC_ENABLED ? rpcResult : { status: 'disabled' },
    },
    connections: {
      ws: wsConnections,
      ws_subscribers: wsSubscribers,
    },
  });
}

export default { handleLive, handleReady, handleHealth };
