/**
 * Tests for Tracing Routes — Issue #1438 / #1307
 *
 * Covers:
 *  - GET /api/tracing/trace/:traceId (found, not-found, malformed/error cases)
 *  - GET /api/tracing/span/:traceId/:spanId (found, not-found, error cases)
 *  - GET /api/tracing/jaeger/:traceId (export trace in Jaeger format, found, not-found)
 *  - GET /api/tracing/metrics (trace metrics summary)
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import tracingRouter from '../src/routes/tracing.js';
import { distributedTracer } from '../src/services/distributedTracing.js';

describe('Tracing Routes (/api/tracing)', () => {
  let app: express.Express;

  beforeEach(() => {
    app = express();
    app.use(express.json());
    app.use('/api/tracing', tracingRouter);
  });

  describe('GET /api/tracing/trace/:traceId', () => {
    it('returns trace details with span list for an existing traceId', async () => {
      const traceId = 'trace-found-1001';

      // Seed spans
      const span1 = distributedTracer.startSpan('root_operation', { traceId, step: 1 });
      distributedTracer.addEvent(traceId, span1.spanId, 'event_1', { key: 'val' });
      distributedTracer.endSpan(traceId, span1.spanId, 'completed');

      const span2 = distributedTracer.startSpan('child_operation', { traceId, step: 2 }, span1.spanId);
      distributedTracer.endSpan(traceId, span2.spanId, 'completed');

      const res = await request(app).get(`/api/tracing/trace/${traceId}`);

      expect(res.status).toBe(200);
      expect(res.body.traceId).toBe(traceId);
      expect(res.body.spanCount).toBe(2);
      expect(res.body.spans).toHaveLength(2);
      expect(res.body.spans[0].name).toBe('root_operation');
      expect(res.body.spans[1].name).toBe('child_operation');
      expect(res.body.spans[1].parentSpanId).toBe(span1.spanId);
    });

    it('returns 404 when traceId is not found', async () => {
      const res = await request(app).get('/api/tracing/trace/non-existent-trace-id-999');

      expect(res.status).toBe(404);
      expect(res.body.error).toBe('Trace not found');
    });

    it('returns 404 for malformed traceId queries that have no spans', async () => {
      const malformedIds = ['invalid!@#$', '----', 'undefined', 'null'];

      for (const id of malformedIds) {
        const res = await request(app).get(`/api/tracing/trace/${encodeURIComponent(id)}`);
        expect(res.status).toBe(404);
        expect(res.body.error).toBe('Trace not found');
      }
    });

    it('returns 500 when tracer throws an error', async () => {
      const spy = vi.spyOn(distributedTracer, 'getTrace').mockImplementationOnce(() => {
        throw new Error('Database lookup failure');
      });

      const res = await request(app).get('/api/tracing/trace/trace-error-case');

      expect(res.status).toBe(500);
      expect(res.body.error).toBe('Internal server error');
      spy.mockRestore();
    });
  });

  describe('GET /api/tracing/span/:traceId/:spanId', () => {
    it('returns span details for a valid traceId and spanId', async () => {
      const traceId = 'trace-span-lookup-2001';
      const span = distributedTracer.startSpan('database_query', {
        traceId,
        query: 'SELECT * FROM credentials',
      });
      distributedTracer.addAttribute(traceId, span.spanId, 'rows', 42);
      distributedTracer.endSpan(traceId, span.spanId, 'completed');

      const res = await request(app).get(`/api/tracing/span/${traceId}/${span.spanId}`);

      expect(res.status).toBe(200);
      expect(res.body.traceId).toBe(traceId);
      expect(res.body.spanId).toBe(span.spanId);
      expect(res.body.name).toBe('database_query');
      expect(res.body.attributes.query).toBe('SELECT * FROM credentials');
      expect(res.body.attributes.rows).toBe(42);
      expect(res.body.status).toBe('completed');
    });

    it('returns 404 when span is not found', async () => {
      const res = await request(app).get('/api/tracing/span/trace-2001/non-existent-span');

      expect(res.status).toBe(404);
      expect(res.body.error).toBe('Span not found');
    });

    it('returns 500 when tracer throws an error', async () => {
      const spy = vi.spyOn(distributedTracer, 'getSpan').mockImplementationOnce(() => {
        throw new Error('Internal span lookup failure');
      });

      const res = await request(app).get('/api/tracing/span/trace-err/span-err');

      expect(res.status).toBe(500);
      expect(res.body.error).toBe('Internal server error');
      spy.mockRestore();
    });
  });

  describe('GET /api/tracing/jaeger/:traceId', () => {
    it('exports trace in Jaeger format with microsecond timestamps and tags/logs', async () => {
      const traceId = 'trace-jaeger-3001';
      const rootSpan = distributedTracer.startSpan('http_request', {
        traceId,
        'http.method': 'POST',
        'http.status_code': 201,
      });

      distributedTracer.addEvent(traceId, rootSpan.spanId, 'auth_verified', {
        user: 'alice',
      });

      const childSpan = distributedTracer.startSpan('soroban_rpc', {
        traceId,
        contract: 'QuorumProof',
      }, rootSpan.spanId);

      distributedTracer.endSpan(traceId, childSpan.spanId, 'completed');
      distributedTracer.endSpan(traceId, rootSpan.spanId, 'completed');

      const res = await request(app).get(`/api/tracing/jaeger/${traceId}`);

      expect(res.status).toBe(200);
      expect(res.body.traceID).toBe(traceId);
      expect(res.body.spans).toHaveLength(2);

      const jaegerRoot = res.body.spans.find((s: any) => s.spanID === rootSpan.spanId);
      const jaegerChild = res.body.spans.find((s: any) => s.spanID === childSpan.spanId);

      expect(jaegerRoot).toBeDefined();
      expect(jaegerChild).toBeDefined();

      expect(jaegerRoot.operationName).toBe('http_request');
      expect(jaegerRoot.startTime).toBe(rootSpan.startTime * 1000);
      expect(jaegerRoot.tags).toEqual(
        expect.arrayContaining([
          { key: 'http.method', value: 'POST' },
          { key: 'http.status_code', value: 201 },
        ]),
      );
      expect(jaegerRoot.logs[0].fields).toEqual(
        expect.arrayContaining([
          { key: 'event', value: 'auth_verified' },
          { key: 'user', value: 'alice' },
        ]),
      );

      // Child references parent
      expect(jaegerChild.references).toHaveLength(1);
      expect(jaegerChild.references[0]).toEqual({
        refType: 'CHILD_OF',
        traceID: traceId,
        spanID: rootSpan.spanId,
      });
    });

    it('returns 404 when exporting a non-existent trace to Jaeger', async () => {
      const res = await request(app).get('/api/tracing/jaeger/non-existent-jaeger-trace');

      expect(res.status).toBe(404);
      expect(res.body.error).toBe('Trace not found');
    });

    it('returns 500 when jaeger export throws', async () => {
      const spy = vi.spyOn(distributedTracer, 'exportToJaeger').mockImplementationOnce(() => {
        throw new Error('Jaeger serialization failure');
      });

      const res = await request(app).get('/api/tracing/jaeger/trace-jaeger-error');

      expect(res.status).toBe(500);
      expect(res.body.error).toBe('Internal server error');
      spy.mockRestore();
    });
  });

  describe('GET /api/tracing/metrics', () => {
    it('returns tracing metrics summary', async () => {
      const res = await request(app).get('/api/tracing/metrics');

      expect(res.status).toBe(200);
      expect(res.body.timestamp).toBeDefined();
      expect(typeof res.body.totalSpans).toBe('number');
      expect(typeof res.body.completedSpans).toBe('number');
      expect(typeof res.body.errorSpans).toBe('number');
      expect(typeof res.body.averageDuration).toBe('number');
      expect(typeof res.body.maxDuration).toBe('number');
      expect(typeof res.body.minDuration).toBe('number');
    });

    it('returns 500 when metrics retrieval throws', async () => {
      const spy = vi.spyOn(distributedTracer, 'getMetrics').mockImplementationOnce(() => {
        throw new Error('Metrics error');
      });

      const res = await request(app).get('/api/tracing/metrics');

      expect(res.status).toBe(500);
      expect(res.body.error).toBe('Internal server error');
      spy.mockRestore();
    });
  });
});
