import type { PathsFragment } from './types.js';

const dateRangeParams = [
  { name: 'start_date', in: 'query' as const, schema: { type: 'string' as const, format: 'date' } },
  { name: 'end_date', in: 'query' as const, schema: { type: 'string' as const, format: 'date' } },
];

export const analyticsPaths: PathsFragment = {
  '/api/analytics/events': {
    post: {
      tags: ['Analytics'],
      summary: 'Record a credential lifecycle event',
      requestBody: {
        required: true,
        content: { 'application/json': { schema: { $ref: '#/components/schemas/AnalyticsEventRequest' } } },
      },
      responses: {
        '201': { description: 'Recorded.', content: { 'application/json': { schema: { type: 'object', properties: { success: { type: 'boolean' }, event_id: { type: 'string' } } } } } },
        '400': { description: 'Invalid body.', content: { 'application/json': { schema: { $ref: '#/components/schemas/ValidationErrorResponse' } } } },
      },
    },
    get: {
      tags: ['Analytics'],
      summary: 'Query the raw analytics event log',
      parameters: [...dateRangeParams, { name: 'type', in: 'query', schema: { type: 'string', enum: ['issued', 'attested', 'revoked', 'suspended', 'verified'] } }],
      responses: {
        '200': { description: 'Matching events.', content: { 'application/json': { schema: { type: 'object', additionalProperties: true } } } },
        '400': { description: 'Invalid query parameters.', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
      },
    },
  },
  '/api/analytics/metrics': {
    get: {
      tags: ['Analytics'],
      summary: 'Get daily issued/attested/revoked metrics for a date range',
      parameters: dateRangeParams,
      responses: {
        '200': { description: 'Daily metrics and totals.', content: { 'application/json': { schema: { type: 'object', additionalProperties: true } } } },
        '400': { description: 'Invalid date range.', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
      },
    },
  },
  '/api/analytics/anomalies': {
    get: {
      tags: ['Analytics'],
      summary: 'Detect anomalous issuance days in a date range',
      parameters: [...dateRangeParams, { name: 'threshold', in: 'query', schema: { type: 'number' } }],
      responses: {
        '200': { description: 'Anomalous dates.', content: { 'application/json': { schema: { type: 'object', additionalProperties: true } } } },
        '400': { description: 'Invalid query parameters.', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
      },
    },
  },
  '/api/analytics/issuer/{address}': {
    get: {
      tags: ['Analytics'],
      summary: 'Get issuer-scoped metrics',
      parameters: [
        { name: 'address', in: 'path', required: true, schema: { type: 'string' } },
        { name: 'period_days', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 365, default: 30 } },
      ],
      responses: {
        '200': { description: 'Issuer metrics.', content: { 'application/json': { schema: { type: 'object', additionalProperties: true } } } },
        '400': { description: 'Invalid period_days.', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
      },
    },
  },
  '/api/analytics/summary': {
    get: {
      tags: ['Analytics'],
      summary: 'Get a platform-wide analytics summary',
      responses: { '200': { description: 'Summary.', content: { 'application/json': { schema: { type: 'object', additionalProperties: true } } } } },
    },
  },
  '/api/analytics/health': {
    get: {
      tags: ['Analytics'],
      summary: 'Analytics subsystem health check',
      responses: { '200': { description: 'OK.', content: { 'application/json': { schema: { type: 'object', properties: { status: { type: 'string' }, service: { type: 'string' }, timestamp: { type: 'string', format: 'date-time' } } } } } } },
    },
  },
};
