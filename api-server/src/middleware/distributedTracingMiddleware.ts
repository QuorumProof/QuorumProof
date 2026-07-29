import { Request, Response, NextFunction } from 'express';
import { distributedTracer } from '../services/distributedTracing.js';

declare global {
  namespace Express {
    interface Request {
      traceId?: string;
      spanId?: string;
    }
  }
}

export function distributedTracingMiddleware(req: Request, res: Response, next: NextFunction): void {
  // Check for trace context in headers (W3C trace context or X-Trace-ID format)
  const traceId = req.get('traceparent')?.split('-')[1] || req.get('x-trace-id') || distributedTracer.generateTraceId();
  const parentSpanId = req.get('x-parent-span-id');

  // Create a span for this request
  const span = distributedTracer.startSpan(`${req.method} ${req.path}`, {
    traceId,
    method: req.method,
    path: req.path,
    ip: req.ip,
  }, parentSpanId);

  req.traceId = traceId;
  req.spanId = span.spanId;

  // Add trace headers to response
  res.set('X-Trace-ID', traceId);
  res.set('X-Span-ID', span.spanId);

  res.on('finish', () => {
    if (res.statusCode >= 400) {
      distributedTracer.endSpan(traceId, span.spanId, 'completed');
    } else {
      distributedTracer.endSpan(traceId, span.spanId, 'completed');
    }
  });

  res.on('error', (error: Error) => {
    distributedTracer.endSpan(traceId, span.spanId, 'error', error.message);
  });

  next();
}
