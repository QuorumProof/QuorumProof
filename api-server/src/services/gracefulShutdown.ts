/**
 * Graceful Shutdown Service — Issue #1311
 *
 * Prevents in-flight HTTP requests from being abruptly killed when the
 * process receives SIGTERM (container/orchestrator stop) or SIGINT (Ctrl-C).
 *
 * Sequence on signal receipt:
 *   1. Flip isDraining → true. The /health endpoint returns 503 immediately
 *      so load-balancers stop routing new traffic here.
 *   2. Stop accepting new TCP connections by calling httpServer.close().
 *   3. Wait for all in-flight requests to finish (i.e. inFlightCount → 0)
 *      or until DRAIN_TIMEOUT_MS elapses, whichever comes first.
 *   4. Optionally run any registered cleanup callbacks (DB pools, WS server,
 *      cron timers, …).
 *   5. Exit with code 0 on clean drain, code 1 on timeout.
 *
 * Usage in index.ts:
 *   const gs = createGracefulShutdown(httpServer, { drainTimeoutMs: 30_000 });
 *   gs.registerSignalHandlers();
 *
 *   // Track in-flight requests
 *   app.use(gs.requestCountMiddleware());
 *
 *   // Expose draining state to /health
 *   app.get('/health', (req, res) => {
 *     if (gs.isDraining()) { res.status(503).json({ status: 'draining' }); return; }
 *     res.json({ status: 'ok' });
 *   });
 */

import { Server as HttpServer } from 'http';

export const DEFAULT_DRAIN_TIMEOUT_MS = 30_000;

export type CleanupFn = () => Promise<void> | void;

export interface GracefulShutdownOptions {
  /** Maximum time (ms) to wait for in-flight requests to complete. Default: 30 000 */
  drainTimeoutMs?: number;
  /** Called once the server stops accepting new connections, before waiting for drain. */
  onShutdownStart?: () => void;
  /** Called when all requests have finished or the timeout expires. */
  onShutdownComplete?: (timedOut: boolean) => void;
}

export interface GracefulShutdown {
  /** True once a shutdown signal has been received — gates the /health 503. */
  isDraining: () => boolean;
  /** Current number of requests being processed. */
  inFlightCount: () => number;
  /**
   * Express middleware that increments the in-flight counter when a request
   * arrives and decrements it when the response finishes.
   */
  requestCountMiddleware: () => (
    req: import('express').Request,
    res: import('express').Response,
    next: import('express').NextFunction,
  ) => void;
  /**
   * Register additional async cleanup tasks (e.g. close a DB pool,
   * shut down the WS server) that run after the HTTP server stops
   * accepting connections and before the process exits.
   */
  addCleanupTask: (fn: CleanupFn) => void;
  /**
   * Attach SIGTERM and SIGINT handlers to the process. Idempotent —
   * calling more than once has no effect.
   */
  registerSignalHandlers: () => void;
  /**
   * Trigger shutdown programmatically (also used by the signal handlers
   * and directly in tests). Resolves when shutdown is complete.
   */
  shutdown: () => Promise<void>;
}

export function createGracefulShutdown(
  server: HttpServer,
  options: GracefulShutdownOptions = {},
): GracefulShutdown {
  const drainTimeoutMs = options.drainTimeoutMs ?? DEFAULT_DRAIN_TIMEOUT_MS;

  let draining = false;
  let inFlight = 0;
  let resolveShutdown: (() => void) | null = null;
  let signalsRegistered = false;
  let shutdownInProgress = false;

  const cleanupTasks: CleanupFn[] = [];

  // Resolves when inFlight drops to zero; can also be resolved early on
  // timeout by the shutdown() function.
  let drainResolve: (() => void) | null = null;
  const drainDone = (): void => {
    if (drainResolve) {
      drainResolve();
      drainResolve = null;
    }
  };

  function requestCountMiddleware() {
    return (
      _req: import('express').Request,
      res: import('express').Response,
      next: import('express').NextFunction,
    ): void => {
      inFlight++;
      res.on('finish', () => {
        inFlight--;
        if (draining && inFlight === 0) {
          drainDone();
        }
      });
      res.on('close', () => {
        // 'close' fires if the connection is destroyed before 'finish'
        // (e.g. client disconnect mid-stream). Decrement only once.
        if ((res as any).__countedClose) return;
        (res as any).__countedClose = true;
        // 'finish' already fired for normal responses; guard against
        // double-decrement by checking whether we're still above zero.
        inFlight = Math.max(0, inFlight - 1);
        if (draining && inFlight === 0) {
          drainDone();
        }
      });
      next();
    };
  }

  async function shutdown(): Promise<void> {
    if (shutdownInProgress) return;
    shutdownInProgress = true;
    draining = true;

    console.log(JSON.stringify({
      ts: new Date().toISOString(),
      level: 'info',
      service: 'quorumproof-api',
      event: 'graceful_shutdown_start',
      inFlightRequests: inFlight,
      drainTimeoutMs,
    }));

    options.onShutdownStart?.();

    // Stop accepting new connections. Existing keep-alive connections are
    // not forcibly closed here — they'll be reused for the remaining
    // in-flight requests and will naturally close when idle.
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });

    let timedOut = false;

    if (inFlight > 0) {
      // Wait for drain or timeout
      await Promise.race([
        new Promise<void>((resolve) => { drainResolve = resolve; }),
        new Promise<void>((resolve) =>
          setTimeout(() => {
            timedOut = true;
            resolve();
          }, drainTimeoutMs),
        ),
      ]);
    }

    if (timedOut) {
      console.warn(JSON.stringify({
        ts: new Date().toISOString(),
        level: 'warn',
        service: 'quorumproof-api',
        event: 'graceful_shutdown_timeout',
        remainingInFlight: inFlight,
        drainTimeoutMs,
      }));
    } else {
      console.log(JSON.stringify({
        ts: new Date().toISOString(),
        level: 'info',
        service: 'quorumproof-api',
        event: 'graceful_shutdown_drained',
        drainTimeoutMs,
      }));
    }

    // Run registered cleanup tasks sequentially so each one sees a
    // consistent state, and so a failing task doesn't skip the rest.
    for (const task of cleanupTasks) {
      try {
        await task();
      } catch (err) {
        console.error(JSON.stringify({
          ts: new Date().toISOString(),
          level: 'error',
          service: 'quorumproof-api',
          event: 'graceful_shutdown_cleanup_error',
          error: String(err),
        }));
      }
    }

    options.onShutdownComplete?.(timedOut);

    console.log(JSON.stringify({
      ts: new Date().toISOString(),
      level: 'info',
      service: 'quorumproof-api',
      event: 'graceful_shutdown_complete',
      timedOut,
    }));

    if (resolveShutdown) {
      resolveShutdown();
    }

    process.exit(timedOut ? 1 : 0);
  }

  function registerSignalHandlers(): void {
    if (signalsRegistered) return;
    signalsRegistered = true;

    const handler = () => {
      shutdown().catch((err) => {
        console.error('Graceful shutdown error:', err);
        process.exit(1);
      });
    };

    process.once('SIGTERM', handler);
    process.once('SIGINT', handler);
  }

  return {
    isDraining: () => draining,
    inFlightCount: () => inFlight,
    requestCountMiddleware,
    addCleanupTask: (fn: CleanupFn) => { cleanupTasks.push(fn); },
    registerSignalHandlers,
    shutdown,
  };
}
