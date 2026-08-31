/**
 * Tests for Issue #1443: Fix structuredLoggingMiddleware Request Context Leak on Client Abort
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import express, { Request, Response } from 'express';
import request from 'supertest';
import http from 'http';
import { EventEmitter } from 'events';

// Mock logger before any module loads it to avoid unhandled ENOENT on /var/log/quorumproof
vi.mock('../src/services/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    setLogLevel: vi.fn(),
    setModuleLogLevel: vi.fn(),
    getLogLevel: vi.fn(() => 'info'),
    getModuleLogLevel: vi.fn(),
  },
  StructuredLogger: vi.fn(),
}));

import {
  structuredLoggingMiddleware,
  getRequestContext,
  _getRequestContextsCount,
  _clearRequestContextsForTest,
  _setRequestContextTTLForTest,
  _pruneExpiredRequestContexts,
} from '../src/middleware/structuredLogging.js';
import { logger } from '../src/services/logger.js';

describe('structuredLoggingMiddleware (#1443)', () => {
  beforeEach(() => {
    _clearRequestContextsForTest();
    _setRequestContextTTLForTest(5 * 60 * 1000);
    vi.clearAllMocks();
  });

  it('adds request context upon incoming request and removes it upon response finish', async () => {
    const app = express();
    app.use(structuredLoggingMiddleware);
    app.get('/test', (req: Request, res: Response) => {
      // Find the request ID currently in cache
      expect(_getRequestContextsCount()).toBe(1);
      res.status(200).json({ ok: true });
    });

    const res = await request(app).get('/test');
    expect(res.status).toBe(200);
    // After finish, the context map should be empty
    expect(_getRequestContextsCount()).toBe(0);
  });

  it('removes request context upon response error', () => {
    const req = {
      method: 'POST',
      path: '/api/error-test',
      ip: '127.0.0.1',
      get: () => 'test-agent',
    } as unknown as Request;

    const resEmitter = new EventEmitter() as any;
    resEmitter.statusCode = 500;
    resEmitter.writableEnded = false;

    let nextCalled = false;
    structuredLoggingMiddleware(req, resEmitter, () => {
      nextCalled = true;
    });

    expect(nextCalled).toBe(true);
    expect(_getRequestContextsCount()).toBe(1);

    // Simulate error event
    resEmitter.emit('error', new Error('Something failed'));
    expect(_getRequestContextsCount()).toBe(0);
  });

  it('removes request context upon client abort (res close without finish)', () => {
    const req = {
      method: 'GET',
      path: '/api/slow-verify',
      ip: '127.0.0.1',
      get: () => 'test-client',
    } as unknown as Request;

    const resEmitter = new EventEmitter() as any;
    resEmitter.statusCode = 200;
    resEmitter.writableEnded = false; // Simulates client disconnecting before response finishes

    let nextCalled = false;
    structuredLoggingMiddleware(req, resEmitter, () => {
      nextCalled = true;
    });

    expect(nextCalled).toBe(true);
    expect(_getRequestContextsCount()).toBe(1);

    // Simulate client abort (premature close event)
    resEmitter.emit('close');

    // Context must be deleted to prevent memory leak
    expect(_getRequestContextsCount()).toBe(0);
    expect(logger.warn).toHaveBeenCalledWith(
      'Client aborted request',
      'http',
      expect.objectContaining({
        method: 'GET',
        path: '/api/slow-verify',
      }),
    );
  });

  it('simulates client abort over HTTP socket disconnect', async () => {
    const app = express();
    app.use(structuredLoggingMiddleware);
    app.get('/slow-endpoint', (req: Request, res: Response) => {
      // Keep request open until client closes connection
      // do not call res.end()
    });

    const server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const port = (server.address() as any).port;

    try {
      // Connect and send HTTP request headers, then immediately destroy the socket
      await new Promise<void>((resolve) => {
        const clientReq = http.request({
          hostname: '127.0.0.1',
          port,
          path: '/slow-endpoint',
          method: 'GET',
        });

        clientReq.on('error', () => {
          // Expected when socket is aborted
        });

        // Send request and abort
        clientReq.write('');
        setTimeout(() => {
          clientReq.destroy();
          // Give server a moment to receive socket close
          setTimeout(() => {
            expect(_getRequestContextsCount()).toBe(0);
            resolve();
          }, 50);
        }, 50);
      });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('prunes expired entries with defense-in-depth short TTL cache', () => {
    _setRequestContextTTLForTest(100); // 100ms TTL

    const req = {
      method: 'GET',
      path: '/api/ttl-test',
      ip: '127.0.0.1',
      get: () => 'test',
    } as unknown as Request;

    const resEmitter = new EventEmitter() as any;
    resEmitter.statusCode = 200;
    resEmitter.writableEnded = false;

    structuredLoggingMiddleware(req, resEmitter, () => {});
    expect(_getRequestContextsCount()).toBe(1);

    // Artificially wait for TTL to expire
    const start = Date.now();
    while (Date.now() - start < 120) {
      // busy wait 120ms
    }

    // Checking size or calling prune removes the expired context
    expect(_pruneExpiredRequestContexts()).toBe(1);
    expect(_getRequestContextsCount()).toBe(0);
  });
});
