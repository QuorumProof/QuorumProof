/**
 * Tests for graceful shutdown service — Issue #1311
 *
 * Coverage:
 *   1. Shutdown signal handling  (SIGTERM / SIGINT / programmatic)
 *   2. Request draining period   (waits for in-flight requests)
 *   3. Health check failure      (/health → 503 during draining)
 *   4. Timeout protection        (exits on timeout when requests linger)
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createServer } from 'http';
import express from 'express';
import request from 'supertest';
import {
  createGracefulShutdown,
  DEFAULT_DRAIN_TIMEOUT_MS,
  type GracefulShutdown,
} from '../src/services/gracefulShutdown.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeServer(opts: { drainTimeoutMs?: number } = {}) {
  const app = express();
  const httpServer = createServer(app);

  const gs = createGracefulShutdown(httpServer, {
    drainTimeoutMs: opts.drainTimeoutMs ?? DEFAULT_DRAIN_TIMEOUT_MS,
  });

  app.use(gs.requestCountMiddleware());

  // A slow route that holds open for `delay` ms — used to simulate in-flight requests.
  app.get('/slow', (req, res) => {
    const delay = parseInt((req.query.delay as string) ?? '50', 10);
    setTimeout(() => res.json({ done: true }), delay);
  });

  app.get('/fast', (_req, res) => res.json({ ok: true }));

  app.get('/health', (_req, res) => {
    if (gs.isDraining()) {
      res.status(503).json({ status: 'draining', inFlightRequests: gs.inFlightCount() });
      return;
    }
    res.json({ status: 'ok' });
  });

  return { app, httpServer, gs };
}

// ---------------------------------------------------------------------------
// 1. Shutdown signal handling
// ---------------------------------------------------------------------------

describe('Shutdown signal handling', () => {
  let processExitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    // Prevent the test process from actually exiting.
    processExitSpy = vi.spyOn(process, 'exit').mockImplementation((_code?: number) => {
      return undefined as never;
    });
  });

  afterEach(() => {
    processExitSpy.mockRestore();
    // Clean up any leftover process.once listeners added during tests.
    process.removeAllListeners('SIGTERM');
    process.removeAllListeners('SIGINT');
  });

  it('starts in a non-draining state', () => {
    const { gs, httpServer } = makeServer();
    expect(gs.isDraining()).toBe(false);
    httpServer.close();
  });

  it('flips isDraining to true when shutdown() is called programmatically', async () => {
    const { gs, httpServer } = makeServer({ drainTimeoutMs: 50 });
    httpServer.listen(0); // bind to an ephemeral port

    const p = gs.shutdown();
    expect(gs.isDraining()).toBe(true);
    await p;

    httpServer.close();
  });

  it('registerSignalHandlers() is idempotent — calling twice does not double-register', () => {
    const { gs, httpServer } = makeServer();
    gs.registerSignalHandlers();
    gs.registerSignalHandlers(); // second call must be a no-op

    const listenerCount = process.listenerCount('SIGTERM');
    // Should have at most one listener per gs instance (could be 0 if this
    // environment strips them, or 1 if not, but never 2+).
    expect(listenerCount).toBeLessThanOrEqual(1);

    httpServer.close();
  });

  it('process.exit(0) is called after a clean drain', async () => {
    const { gs, httpServer } = makeServer({ drainTimeoutMs: 200 });
    httpServer.listen(0);

    await gs.shutdown();

    expect(processExitSpy).toHaveBeenCalledWith(0);
    httpServer.close();
  });

  it('onShutdownStart callback is invoked on shutdown', async () => {
    const app = express();
    const httpServer = createServer(app);
    const onStart = vi.fn();
    const gs = createGracefulShutdown(httpServer, { drainTimeoutMs: 50, onShutdownStart: onStart });
    app.use(gs.requestCountMiddleware());
    httpServer.listen(0);

    await gs.shutdown();

    expect(onStart).toHaveBeenCalledOnce();
    httpServer.close();
  });

  it('onShutdownComplete callback receives timedOut=false on clean drain', async () => {
    const app = express();
    const httpServer = createServer(app);
    const onComplete = vi.fn();
    const gs = createGracefulShutdown(httpServer, {
      drainTimeoutMs: 200,
      onShutdownComplete: onComplete,
    });
    app.use(gs.requestCountMiddleware());
    httpServer.listen(0);

    await gs.shutdown();

    expect(onComplete).toHaveBeenCalledWith(false);
    httpServer.close();
  });
});

// ---------------------------------------------------------------------------
// 2. Request draining period
// ---------------------------------------------------------------------------

describe('Request draining', () => {
  let processExitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    processExitSpy = vi.spyOn(process, 'exit').mockImplementation((_code?: number) => {
      return undefined as never;
    });
  });

  afterEach(() => {
    processExitSpy.mockRestore();
    process.removeAllListeners('SIGTERM');
    process.removeAllListeners('SIGINT');
  });

  it('inFlightCount() is 0 when no requests are active', () => {
    const { gs, httpServer } = makeServer();
    expect(gs.inFlightCount()).toBe(0);
    httpServer.close();
  });

  it('inFlightCount() increments while a request is in progress and decrements after', async () => {
    const { app, httpServer, gs } = makeServer();
    httpServer.listen(0);
    const addr = httpServer.address() as { port: number };

    // Fire a slow request without awaiting it so we can observe inFlight mid-request.
    const slowReqPromise = request(`http://localhost:${addr.port}`)
      .get('/slow?delay=80')
      .then((r) => r);

    // Give the request a moment to reach the handler and increment the counter.
    await new Promise((r) => setTimeout(r, 20));
    expect(gs.inFlightCount()).toBe(1);

    // Wait for it to complete.
    await slowReqPromise;
    expect(gs.inFlightCount()).toBe(0);

    httpServer.close();
  });

  it('shutdown() waits for in-flight requests to finish before exiting', async () => {
    // This test verifies the drain contract directly without depending on
    // HTTP timing: we simulate an in-flight request by manually using the
    // requestCountMiddleware to increment the counter, then decrement it
    // after a delay — exactly what a real request does. The shutdown should
    // wait for that decrement before exiting.
    const app2 = express();
    const httpServer2 = createServer(app2);
    const gs2 = createGracefulShutdown(httpServer2, { drainTimeoutMs: 5000 });
    app2.use(gs2.requestCountMiddleware());

    // Simulate a request arriving: build a fake res object that fires
    // 'finish' after a delay (simulating a slow response).
    let finishCallback: (() => void) | null = null;
    const fakeRes = {
      on(event: string, cb: () => void) {
        if (event === 'finish') finishCallback = cb;
        // ignore 'close'
      },
    } as any;

    const mw = gs2.requestCountMiddleware();
    mw({} as any, fakeRes, () => {});

    expect(gs2.inFlightCount()).toBe(1); // request is in flight

    httpServer2.listen(0);
    const shutdownPromise = gs2.shutdown();

    // Shutdown has started but the counter is still 1, so it must be waiting.
    expect(gs2.isDraining()).toBe(true);
    expect(gs2.inFlightCount()).toBe(1);

    // Simulate the response finishing after 50 ms.
    setTimeout(() => {
      if (finishCallback) finishCallback();
    }, 50);

    await shutdownPromise;

    expect(processExitSpy).toHaveBeenCalledWith(0);
    expect(gs2.inFlightCount()).toBe(0);
    httpServer2.close();
  }, 10_000);

  it('cleanup tasks run after the server stops accepting connections', async () => {
    const { gs, httpServer } = makeServer({ drainTimeoutMs: 200 });
    const order: string[] = [];

    gs.addCleanupTask(async () => { order.push('cleanup1'); });
    gs.addCleanupTask(() => { order.push('cleanup2'); });

    httpServer.listen(0);
    await gs.shutdown();

    expect(order).toEqual(['cleanup1', 'cleanup2']);
    httpServer.close();
  });

  it('a failing cleanup task does not prevent subsequent tasks from running', async () => {
    const { gs, httpServer } = makeServer({ drainTimeoutMs: 200 });
    const ran: string[] = [];

    gs.addCleanupTask(async () => { throw new Error('task failed'); });
    gs.addCleanupTask(() => { ran.push('task2'); });

    httpServer.listen(0);
    await gs.shutdown(); // must not reject

    expect(ran).toContain('task2');
    httpServer.close();
  });
});

// ---------------------------------------------------------------------------
// 3. Health check failure during draining
// ---------------------------------------------------------------------------

describe('Health check failure during draining', () => {
  let processExitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    processExitSpy = vi.spyOn(process, 'exit').mockImplementation((_code?: number) => {
      return undefined as never;
    });
  });

  afterEach(() => {
    processExitSpy.mockRestore();
    process.removeAllListeners('SIGTERM');
    process.removeAllListeners('SIGINT');
  });

  it('GET /health returns 200 before shutdown', async () => {
    const { app } = makeServer();
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
  });

  it('GET /health returns 503 immediately after shutdown() is triggered', async () => {
    const { app, httpServer, gs } = makeServer({ drainTimeoutMs: 5000 });
    // We don't need a real listening server to test the express handler —
    // supertest(app) handles the HTTP layer internally. Calling shutdown()
    // will flip isDraining synchronously before waiting on server.close(),
    // so a supertest request that arrives after the flag is flipped will
    // see 503 even without a real port.
    httpServer.listen(0);

    // Trigger shutdown; do not await — we want to check health mid-drain.
    const shutdownPromise = gs.shutdown();
    // isDraining flips synchronously at the top of shutdown().
    expect(gs.isDraining()).toBe(true);

    // Check the handler directly through supertest (avoids the closed-port race).
    const res = await request(app).get('/health');
    expect(res.status).toBe(503);
    expect(res.body.status).toBe('draining');

    await shutdownPromise;
    httpServer.close();
  });

  it('GET /health 503 body includes inFlightRequests', async () => {
    const { app, httpServer, gs } = makeServer({ drainTimeoutMs: 5000 });
    httpServer.listen(0);
    const addr = httpServer.address() as { port: number };

    // Start a slow request so inFlightRequests will be ≥ 1 when we check.
    const slowPromise = request(`http://localhost:${addr.port}`)
      .get('/slow?delay=200')
      .then((r) => r);

    await new Promise((r) => setTimeout(r, 30)); // wait for it to land

    const shutdownPromise = gs.shutdown();
    // isDraining is now true; check the handler directly via supertest.
    const res = await request(app).get('/health');
    expect(res.status).toBe(503);
    expect(typeof res.body.inFlightRequests).toBe('number');

    await slowPromise;
    await shutdownPromise;
    httpServer.close();
  });

  it('isDraining() reflects the draining state observable by /health', async () => {
    const { gs, httpServer } = makeServer({ drainTimeoutMs: 50 });
    expect(gs.isDraining()).toBe(false);

    httpServer.listen(0);
    const shutdownPromise = gs.shutdown();

    expect(gs.isDraining()).toBe(true);
    await shutdownPromise;
    httpServer.close();
  });
});

// ---------------------------------------------------------------------------
// 4. Timeout protection
// ---------------------------------------------------------------------------

describe('Timeout protection', () => {
  let processExitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    processExitSpy = vi.spyOn(process, 'exit').mockImplementation((_code?: number) => {
      return undefined as never;
    });
  });

  afterEach(() => {
    processExitSpy.mockRestore();
    process.removeAllListeners('SIGTERM');
    process.removeAllListeners('SIGINT');
  });

  it('exits with code 1 when drain timeout is exceeded', async () => {
    // A 30 ms drain timeout with a request that takes 300 ms — timeout fires first.
    const app = express();
    const httpServer = createServer(app);
    const gs = createGracefulShutdown(httpServer, { drainTimeoutMs: 30 });
    app.use(gs.requestCountMiddleware());

    // Manually bump inFlight without providing a real request so it never
    // decrements — simulates a request that hangs indefinitely.
    const middleware = gs.requestCountMiddleware();
    const fakeReq = {} as any;
    const fakeRes = {
      on: (_event: string, _cb: () => void) => {}, // ignore finish/close
    } as any;
    middleware(fakeReq, fakeRes, () => {});

    expect(gs.inFlightCount()).toBe(1);

    httpServer.listen(0);
    await gs.shutdown();

    expect(processExitSpy).toHaveBeenCalledWith(1);
    httpServer.close();
  });

  it('onShutdownComplete receives timedOut=true on timeout', async () => {
    const app = express();
    const httpServer = createServer(app);
    const onComplete = vi.fn();
    const gs = createGracefulShutdown(httpServer, {
      drainTimeoutMs: 30,
      onShutdownComplete: onComplete,
    });
    app.use(gs.requestCountMiddleware());

    // Simulate a stuck request.
    const middleware = gs.requestCountMiddleware();
    middleware({} as any, { on: () => {} } as any, () => {});

    httpServer.listen(0);
    await gs.shutdown();

    expect(onComplete).toHaveBeenCalledWith(true);
    httpServer.close();
  });

  it('DEFAULT_DRAIN_TIMEOUT_MS is 30 000', () => {
    expect(DEFAULT_DRAIN_TIMEOUT_MS).toBe(30_000);
  });

  it('exits promptly when there are no in-flight requests (no timeout needed)', async () => {
    const { gs, httpServer } = makeServer({ drainTimeoutMs: 10_000 });
    httpServer.listen(0);

    const start = Date.now();
    await gs.shutdown();
    const elapsed = Date.now() - start;

    // Should exit well before the 10 s timeout (< 500 ms in practice).
    expect(elapsed).toBeLessThan(500);
    expect(processExitSpy).toHaveBeenCalledWith(0);
    httpServer.close();
  });

  it('does not call shutdown twice when called concurrently', async () => {
    const { gs, httpServer } = makeServer({ drainTimeoutMs: 50 });
    httpServer.listen(0);

    const [, ] = await Promise.all([gs.shutdown(), gs.shutdown()]);

    // process.exit should only have been called once.
    expect(processExitSpy).toHaveBeenCalledTimes(1);
    httpServer.close();
  });
});
