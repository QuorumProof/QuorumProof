import { Request, Response, NextFunction } from 'express';
import { logger } from '../services/logger.js';

export interface RequestContext {
  requestId: string;
  method: string;
  path: string;
  startTime: number;
}

const DEFAULT_REQUEST_CONTEXT_TTL_MS = 5 * 60 * 1000; // 5 minutes defense-in-depth TTL

class RequestContextCache {
  private contexts = new Map<string, RequestContext>();
  private ttlMs: number;

  constructor(ttlMs = DEFAULT_REQUEST_CONTEXT_TTL_MS) {
    this.ttlMs = ttlMs;
  }

  set(requestId: string, context: RequestContext): void {
    this.pruneExpired();
    this.contexts.set(requestId, context);
  }

  get(requestId: string): RequestContext | undefined {
    const context = this.contexts.get(requestId);
    if (!context) return undefined;
    if (Date.now() - context.startTime > this.ttlMs) {
      this.contexts.delete(requestId);
      return undefined;
    }
    return context;
  }

  delete(requestId: string): boolean {
    return this.contexts.delete(requestId);
  }

  get size(): number {
    this.pruneExpired();
    return this.contexts.size;
  }

  clear(): void {
    this.contexts.clear();
  }

  setTtlForTest(ttlMs: number): void {
    this.ttlMs = ttlMs;
  }

  pruneExpired(): number {
    const now = Date.now();
    let pruned = 0;
    for (const [id, ctx] of this.contexts.entries()) {
      if (now - ctx.startTime > this.ttlMs) {
        this.contexts.delete(id);
        pruned++;
      }
    }
    return pruned;
  }
}

const requestContexts = new RequestContextCache();

export function structuredLoggingMiddleware(req: Request, res: Response, next: NextFunction): void {
  const requestId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const startTime = Date.now();

  const context: RequestContext = {
    requestId,
    method: req.method,
    path: req.path,
    startTime,
  };

  requestContexts.set(requestId, context);

  logger.info(
    `Incoming request`,
    'http',
    {
      requestId,
      method: req.method,
      path: req.path,
      ip: req.ip,
      userAgent: req.get('user-agent'),
    },
  );

  res.on('finish', () => {
    const duration = Date.now() - startTime;

    logger.info(
      `Request completed`,
      'http',
      {
        requestId,
        method: req.method,
        path: req.path,
        status: res.statusCode,
        duration,
      },
    );

    requestContexts.delete(requestId);
  });

  res.on('error', (error: Error) => {
    const duration = Date.now() - startTime;

    logger.error(
      `Request error`,
      'http',
      {
        requestId,
        method: req.method,
        path: req.path,
        status: res.statusCode,
        duration,
        error: error.message,
        stack: error.stack,
      },
    );

    requestContexts.delete(requestId);
  });

  // #1443: Clean up context entry on premature client disconnects / aborts
  res.on('close', () => {
    if (!res.writableEnded) {
      const duration = Date.now() - startTime;

      logger.warn(
        `Client aborted request`,
        'http',
        {
          requestId,
          method: req.method,
          path: req.path,
          status: res.statusCode,
          duration,
        },
      );
    }

    requestContexts.delete(requestId);
  });

  next();
}

export function getRequestContext(requestId: string): RequestContext | undefined {
  return requestContexts.get(requestId);
}

export function _getRequestContextsCount(): number {
  return requestContexts.size;
}

export function _clearRequestContextsForTest(): void {
  requestContexts.clear();
}

export function _pruneExpiredRequestContexts(): number {
  return requestContexts.pruneExpired();
}

export function _setRequestContextTTLForTest(ttlMs: number): void {
  requestContexts.setTtlForTest(ttlMs);
}
