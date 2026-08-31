/**
 * Tests for Distributed Tracing Middleware — Issue #1438 / #1307
 *
 * Covers:
 *  - Span creation and propagation across HTTP requests
 *  - W3C traceparent and X-Trace-ID header extraction
 *  - Parent span ID propagation
 *  - Response header injection (X-Trace-ID, X-Span-ID)
 *  - Span lifecycle (completion on finish, error on error event)
 *  - Trace context propagation across asynchronous boundaries (e.g. Soroban RPC simulation)
 */

import { describe, it, expect, beforeEach } from 'vitest';
import express, { Request, Response, NextFunction } from 'express';
import request from 'supertest';
import { distributedTracingMiddleware } from '../src/middleware/distributedTracingMiddleware.js';
import { distributedTracer } from '../src/services/distributedTracing.js';

describe('distributedTracingMiddleware', () => {
  let app: express.Express;

  beforeEach(() => {
    app = express();
    app.use(distributedTracingMiddleware);

    // Test endpoints
    app.get('/api/test/basic', (req: Request, res: Response) => {
      res.status(200).json({
        ok: true,
        traceId: req.traceId,
        spanId: req.spanId,
      });
    });

    app.get('/api/test/client-error', (_req: Request, res: Response) => {
      res.status(400).json({ error: 'Bad Request' });
    });

    app.get('/api/test/server-error', (_req: Request, res: Response) => {
      res.status(500).json({ error: 'Internal Server Error' });
    });

    app.get('/api/test/async-soroban', async (req: Request, res: Response, next: NextFunction) => {
      try {
        const traceId = req.traceId!;
        const parentSpanId = req.spanId!;

        // Simulate async boundary — e.g. Soroban RPC call
        const childSpan = distributedTracer.startSpan('soroban:simulateCall', {
          traceId,
          contract: 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC',
          operation: 'get_credential',
        }, parentSpanId);

        distributedTracer.addEvent(traceId, childSpan.spanId, 'rpc_request_sent', {
          rpc_url: 'https://soroban-testnet.stellar.org',
        });

        // Async boundary delay
        await new Promise((resolve) => setTimeout(resolve, 20));

        distributedTracer.addEvent(traceId, childSpan.spanId, 'rpc_response_received', {
          status: 'success',
          minResourceFee: '1000',
        });

        distributedTracer.endSpan(traceId, childSpan.spanId, 'completed');

        res.status(200).json({
          success: true,
          traceId,
          parentSpanId,
          childSpanId: childSpan.spanId,
        });
      } catch (err) {
        next(err);
      }
    });
  });

  describe('Span creation and propagation', () => {
    it('creates a new trace and span when no trace headers are provided', async () => {
      const res = await request(app).get('/api/test/basic');

      expect(res.status).toBe(200);
      const traceIdHeader = res.headers['x-trace-id'];
      const spanIdHeader = res.headers['x-span-id'];

      expect(traceIdHeader).toBeDefined();
      expect(spanIdHeader).toBeDefined();
      expect(res.body.traceId).toBe(traceIdHeader);
      expect(res.body.spanId).toBe(spanIdHeader);

      const span = distributedTracer.getSpan(traceIdHeader, spanIdHeader);
      expect(span).not.toBeNull();
      expect(span?.name).toBe('GET /api/test/basic');
      expect(span?.attributes.method).toBe('GET');
      expect(span?.attributes.path).toBe('/api/test/basic');
      expect(span?.status).toBe('completed');
      expect(span?.endTime).toBeDefined();
      expect(span?.duration).toBeGreaterThanOrEqual(0);
    });

    it('extracts traceId from W3C traceparent header', async () => {
      const w3cTraceId = '4bf92f3577b34da6a3ce929d0e0e4736';
      const traceparent = `00-${w3cTraceId}-00f067aa0ba902b7-01`;

      const res = await request(app)
        .get('/api/test/basic')
        .set('traceparent', traceparent);

      expect(res.status).toBe(200);
      expect(res.headers['x-trace-id']).toBe(w3cTraceId);
      expect(res.body.traceId).toBe(w3cTraceId);

      const trace = distributedTracer.getTrace(w3cTraceId);
      expect(trace.length).toBeGreaterThanOrEqual(1);
      expect(trace[0].traceId).toBe(w3cTraceId);
    });

    it('extracts traceId from x-trace-id header when traceparent is absent', async () => {
      const customTraceId = 'custom-trace-id-abc123';

      const res = await request(app)
        .get('/api/test/basic')
        .set('x-trace-id', customTraceId);

      expect(res.status).toBe(200);
      expect(res.headers['x-trace-id']).toBe(customTraceId);
      expect(res.body.traceId).toBe(customTraceId);

      const trace = distributedTracer.getTrace(customTraceId);
      expect(trace.length).toBeGreaterThanOrEqual(1);
      expect(trace[0].traceId).toBe(customTraceId);
    });

    it('propagates x-parent-span-id to the created span', async () => {
      const parentSpanId = 'upstream-parent-span-999';
      const customTraceId = 'trace-with-parent-span-123';

      const res = await request(app)
        .get('/api/test/basic')
        .set('x-trace-id', customTraceId)
        .set('x-parent-span-id', parentSpanId);

      expect(res.status).toBe(200);
      const spanIdHeader = res.headers['x-span-id'];

      const span = distributedTracer.getSpan(customTraceId, spanIdHeader);
      expect(span).not.toBeNull();
      expect(span?.parentSpanId).toBe(parentSpanId);
    });

    it('completes span on 4xx client error', async () => {
      const customTraceId = 'trace-4xx-test';

      const res = await request(app)
        .get('/api/test/client-error')
        .set('x-trace-id', customTraceId);

      expect(res.status).toBe(400);
      const spanId = res.headers['x-span-id'];
      const span = distributedTracer.getSpan(customTraceId, spanId);

      expect(span).not.toBeNull();
      expect(span?.status).toBe('completed');
      expect(span?.endTime).toBeDefined();
    });

    it('completes span on 5xx server error', async () => {
      const customTraceId = 'trace-5xx-test';

      const res = await request(app)
        .get('/api/test/server-error')
        .set('x-trace-id', customTraceId);

      expect(res.status).toBe(500);
      const spanId = res.headers['x-span-id'];
      const span = distributedTracer.getSpan(customTraceId, spanId);

      expect(span).not.toBeNull();
      expect(span?.status).toBe('completed');
      expect(span?.endTime).toBeDefined();
    });

    it('records error status when response emits error event', async () => {
      const customTraceId = 'trace-error-event-test';
      let capturedSpanId: string | undefined;

      const errorApp = express();
      errorApp.use(distributedTracingMiddleware);
      errorApp.get('/api/test/stream-error', (req: Request, res: Response) => {
        capturedSpanId = req.spanId;
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.write('chunk 1');
        // Emit error on response
        res.emit('error', new Error('Connection reset by peer'));
        res.end();
      });

      await request(errorApp)
        .get('/api/test/stream-error')
        .set('x-trace-id', customTraceId);

      expect(capturedSpanId).toBeDefined();
      const span = distributedTracer.getSpan(customTraceId, capturedSpanId!);
      expect(span).not.toBeNull();
      expect(span?.status).toBe('error');
      expect(span?.error).toBe('Connection reset by peer');
    });
  });

  describe('Async boundary context propagation', () => {
    it('propagates trace context across asynchronous Soroban RPC simulation boundary', async () => {
      const customTraceId = 'trace-async-soroban-propagation';

      const res = await request(app)
        .get('/api/test/async-soroban')
        .set('x-trace-id', customTraceId);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.traceId).toBe(customTraceId);

      const rootSpanId = res.body.parentSpanId;
      const childSpanId = res.body.childSpanId;

      // Verify both spans exist in the same trace
      const trace = distributedTracer.getTrace(customTraceId);
      expect(trace.length).toBe(2);

      const rootSpan = trace.find((s) => s.spanId === rootSpanId);
      const childSpan = trace.find((s) => s.spanId === childSpanId);

      expect(rootSpan).toBeDefined();
      expect(childSpan).toBeDefined();

      // Check parent-child linkage
      expect(childSpan?.parentSpanId).toBe(rootSpan?.spanId);
      expect(childSpan?.name).toBe('soroban:simulateCall');
      expect(childSpan?.attributes.contract).toBe('CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC');
      expect(childSpan?.attributes.operation).toBe('get_credential');

      // Check events recorded across the async boundary
      expect(childSpan?.events).toHaveLength(2);
      expect(childSpan?.events[0].name).toBe('rpc_request_sent');
      expect(childSpan?.events[1].name).toBe('rpc_response_received');

      // Both spans completed successfully
      expect(rootSpan?.status).toBe('completed');
      expect(childSpan?.status).toBe('completed');
      expect(childSpan?.duration).toBeGreaterThanOrEqual(15);
    });
  });
});
