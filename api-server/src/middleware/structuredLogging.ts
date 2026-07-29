import { Request, Response, NextFunction } from 'express';
import { logger } from '../services/logger.js';

interface RequestContext {
  requestId: string;
  method: string;
  path: string;
  startTime: number;
}

const requestContexts = new Map<string, RequestContext>();

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

  next();
}

export function getRequestContext(requestId: string): RequestContext | undefined {
  return requestContexts.get(requestId);
}
