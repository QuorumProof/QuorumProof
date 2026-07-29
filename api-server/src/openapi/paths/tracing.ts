import type { PathsFragment } from './types.js';

export const tracingPaths: PathsFragment = {
  '/api/tracing/trace/{traceId}': {
    get: {
      tags: ['Tracing'],
      summary: 'Get all spans for a trace',
      parameters: [{ name: 'traceId', in: 'path', required: true, schema: { type: 'string' } }],
      responses: {
        '200': { description: 'Spans.', content: { 'application/json': { schema: { type: 'object', properties: { traceId: { type: 'string' }, spanCount: { type: 'integer' }, spans: { type: 'array', items: { type: 'object', additionalProperties: true } } } } } } },
        '404': { description: 'Trace not found.', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
      },
    },
  },
  '/api/tracing/span/{traceId}/{spanId}': {
    get: {
      tags: ['Tracing'],
      summary: 'Get a specific span',
      parameters: [
        { name: 'traceId', in: 'path', required: true, schema: { type: 'string' } },
        { name: 'spanId', in: 'path', required: true, schema: { type: 'string' } },
      ],
      responses: {
        '200': { description: 'The span.', content: { 'application/json': { schema: { type: 'object', additionalProperties: true } } } },
        '404': { description: 'Span not found.', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
      },
    },
  },
  '/api/tracing/jaeger/{traceId}': {
    get: {
      tags: ['Tracing'],
      summary: 'Export a trace in Jaeger format',
      parameters: [{ name: 'traceId', in: 'path', required: true, schema: { type: 'string' } }],
      responses: {
        '200': { description: 'Jaeger-formatted trace.', content: { 'application/json': { schema: { type: 'object', additionalProperties: true } } } },
        '404': { description: 'Trace not found.', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
      },
    },
  },
  '/api/tracing/metrics': {
    get: {
      tags: ['Tracing'],
      summary: 'Get distributed-tracing metrics',
      responses: { '200': { description: 'Metrics.', content: { 'application/json': { schema: { type: 'object', additionalProperties: true } } } } },
    },
  },
};
