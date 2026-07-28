/**
 * Issue #1311 — Graceful Shutdown with Request Draining
 *
 * Manages server shutdown with in-flight request draining and timeout protection.
 * This ensures that when a SIGTERM or SIGINT is received, the server:
 *
 *   1. Stops accepting new connections
 *   2. Marks itself as "draining" (health/ready returns 503)
 *   3. Waits for in-flight requests to complete (up to a timeout)
 *   4. Closes all connections forcibly if timeout is exceeded
 *   5. Cleans up resources (DB pool, WebSockets, timers, …)
 *   6. Exits with code 0 or 1 depending on whether timeout was exceeded
 *
 * Configuration:
 *   GRACEFUL_SHUTDOWN_TIMEOUT_MS — max time to wait for requests (default: 30000 ms)
 *   GRACEFUL_SHUTDOWN_HEALTH_DELAY_MS — delay before returning 503 to health checks (default: 1000 ms)
 *
 * Usage:
 * ```ts
 * const { httpServer } = createServer();
 * const shutdown = setupGracefulShutdown(httpServer);
 * process.once('SIGTERM', () => { shutdown('SIGTERM'); });
 * process.once('SIGINT', () => { shutdown('SIGINT'); });
 * ```
 */

import type { Server } from 'http';
import { createLogger } from './logger.js';

const log = createLogger('shutdown');

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const DRAIN_TIMEOUT_MS = parseInt(
  process.env.GRACEFUL_SHUTDOWN_TIMEOUT_MS ?? '30000',
  10
);
const HEALTH_DELAY_MS = parseInt(
  process.env.GRACEFUL_SHUTDOWN_HEALTH_DELAY_MS ?? '1000',
  10
);

// ---------------------------------------------------------------------------
// Draining state (shared across the app via module scope)
// ---------------------------------------------------------------------------

let _isDraining = false;

/** Returns true if the server is currently draining. */
export function isDraining(): boolean {
  return _isDraining;
}

/** Manually set the draining flag (used by the shutdown handler). */
export function setDraining(draining: boolean): void {
  _isDraining = draining;
}

// ---------------------------------------------------------------------------
// Main graceful shutdown orchestrator
// ---------------------------------------------------------------------------

export interface GracefulShutdownOptions {
  /**
   * Handler called before closing the server.
   * Use this to clean up custom resources (external connections, timers, …).
   * @returns void or Promise<void>
   */
  onBeforeClose?: () => void | Promise<void>;

  /**
   * Handler called after the server is fully closed.
   * Use this for final logging or exit code selection.
   * @param timedOut true if we hit the drain timeout and force-closed connections
   * @returns exit code (0 for success, 1 for timeout)
   */
  onAfterClose?: (timedOut: boolean) => number;
}

/**
 * Sets up graceful shutdown handlers on the given HTTP server.
 * Returns an async function that can be called to initiate shutdown.
 *
 * @param server The HTTP server to drain and close
 * @param options Lifecycle hooks and configuration
 * @returns An async shutdown function to call on SIGTERM/SIGINT
 *
 * @example
 * ```ts
 * const shutdown = setupGracefulShutdown(httpServer, {
 *   onBeforeClose: async () => {
 *     await db.close();
 *   },
 * });
 * process.once('SIGTERM', () => { shutdown('SIGTERM'); });
 * ```
 */
export function setupGracefulShutdown(
  server: Server,
  options: GracefulShutdownOptions = {}
): (signal: string) => Promise<void> {
  // Track all active sockets so we can forcibly close them if timeout exceeds.
  const activeSockets = new Set<any>();

  server.on('connection', (socket) => {
    activeSockets.add(socket);
    socket.once('close', () => {
      activeSockets.delete(socket);
    });
  });

  return async (signal: string): Promise<void> => {
    log.info('Shutdown signal received', { signal });

    // Mark as draining. Health checks will start returning 503 after the delay.
    _isDraining = true;

    // Give the load balancer a moment to drain this instance from rotation.
    await new Promise((resolve) => {
      setTimeout(resolve, HEALTH_DELAY_MS);
    });

    log.info('Stopping server (no new connections)', {
      activeConnections: activeSockets.size,
    });

    // Stop accepting new connections.
    server.close(async () => {
      log.info('Server closed (existing connections draining)');

      // Call any custom cleanup hooks.
      if (options.onBeforeClose) {
        try {
          await options.onBeforeClose();
        } catch (err) {
          log.error('Error in onBeforeClose hook', {
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

      // Close DB pool and other module resources.
      try {
        const { closePool } = await import('./db.js');
        await closePool();
      } catch {
        // DB module may not have been initialised if DATABASE_URL wasn't set.
      }

      // Call any custom post-close hooks.
      const exitCode = options.onAfterClose?.(false) ?? 0;
      log.info('Graceful shutdown complete', { exitCode });
      process.exit(exitCode);
    });

    // Set a hard timeout: if requests don't drain, force close everything.
    const timeoutHandle = setTimeout(() => {
      log.warn('Drain timeout exceeded, force-closing connections', {
        timeoutMs: DRAIN_TIMEOUT_MS,
        remainingConnections: activeSockets.size,
      });

      // Force close all remaining sockets.
      for (const socket of activeSockets) {
        socket.destroy();
      }

      // Call post-close hook with timedOut=true.
      const exitCode = options.onAfterClose?.(true) ?? 1;
      log.warn('Graceful shutdown exceeded timeout', { exitCode });
      process.exit(exitCode);
    }, DRAIN_TIMEOUT_MS);

    // Cancel the timeout if server closes before it fires.
    server.once('close', () => {
      clearTimeout(timeoutHandle);
    });
  };
}

export default { setupGracefulShutdown, isDraining, setDraining };
