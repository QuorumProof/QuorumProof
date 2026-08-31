import type { PathsFragment } from './types.js';

export const reportsPaths: PathsFragment = {
  '/api/reports/compliance': {
    get: {
      tags: ['Reports'],
      summary: 'Monthly compliance report',
      description: 'Returns audit trail completeness and gaps for the specified year/month.',
      parameters: [
        { name: 'year', in: 'query', schema: { type: 'integer', minimum: 2020, maximum: 2100 }, description: 'Year (default: current).' },
        { name: 'month', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 12 }, description: 'Month 1–12 (default: current).' },
      ],
      responses: {
        '200': {
          description: 'Compliance report.',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  period: { type: 'object', properties: { year: { type: 'integer' }, month: { type: 'integer' } } },
                  generatedAt: { type: 'string', format: 'date-time' },
                  summary: { type: 'object', additionalProperties: true },
                  auditTrailCompleteness: { type: 'object', additionalProperties: true },
                  gaps: { type: 'object', additionalProperties: true },
                },
              },
            },
          },
        },
        '400': { description: 'Invalid year or month.', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
        '500': { description: 'Internal error.', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
      },
    },
  },
  '/api/reports/costs': {
    get: {
      tags: ['Reports'],
      summary: 'Contract cost analysis',
      description: 'Identifies expensive contract operations via simulation latency as a cost proxy.',
      responses: {
        '200': {
          description: 'Cost analysis report.',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  generatedAt: { type: 'string', format: 'date-time' },
                  note: { type: 'string' },
                  operations: { type: 'array', items: { type: 'object', additionalProperties: true } },
                  mostExpensive: { type: 'array', items: { type: 'string' } },
                  optimizationSuggestions: { type: 'array', items: { type: 'object', additionalProperties: true } },
                },
              },
            },
          },
        },
      },
    },
  },
  '/api/reports/distribution': {
    get: {
      tags: ['Reports'],
      summary: 'Credential type distribution',
      description: 'Returns count of Degree/License/Employment credentials broken down by issuer.',
      parameters: [
        { name: 'issuer', in: 'query', schema: { type: 'string' }, description: 'Filter by issuer address.' },
        { name: 'since', in: 'query', schema: { type: 'string', format: 'date-time' }, description: 'Optional lower bound date (currently informational only).' },
      ],
      responses: {
        '200': {
          description: 'Distribution report.',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  generatedAt: { type: 'string', format: 'date-time' },
                  total: { type: 'integer' },
                  issuerFilter: { type: 'string', nullable: true },
                  distribution: { type: 'object', additionalProperties: true },
                },
              },
            },
          },
        },
        '500': { description: 'Internal error.', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
      },
    },
  },
  '/api/reports/usage': {
    get: {
      tags: ['Reports'],
      summary: 'Contract usage analytics',
      description: 'Returns function call frequency and error rates from the analytics subsystem.',
      responses: {
        '200': {
          description: 'Usage analytics report.',
          content: {
            'application/json': {
              schema: { type: 'object', additionalProperties: true },
            },
          },
        },
      },
    },
  },
  '/api/reports/audit': {
    get: {
      tags: ['Reports'],
      summary: 'Audit compliance report',
      description: 'Summarises credential issuance, verification, and revocation events from the on-chain audit log.',
      parameters: [
        { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 1000, default: 200 }, description: 'Max entries to scan.' },
      ],
      responses: {
        '200': {
          description: 'Audit compliance report.',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  generatedAt: { type: 'string', format: 'date-time' },
                  scannedEntries: { type: 'integer' },
                  summary: { type: 'object', additionalProperties: true },
                  byCategory: { type: 'object', additionalProperties: true },
                },
              },
            },
          },
        },
        '500': { description: 'Internal error.', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
      },
    },
  },
  '/api/reports/expiry-forecast': {
    get: {
      tags: ['Reports'],
      summary: 'Credential expiry forecast',
      description: 'Predicts upcoming credential expiry waves over a configurable horizon.',
      parameters: [
        { name: 'horizon', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 365, default: 90 }, description: 'Forecast horizon in days.' },
      ],
      responses: {
        '200': { description: 'Expiry forecast.', content: { 'application/json': { schema: { type: 'object', additionalProperties: true } } } },
        '500': { description: 'Internal error.', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
      },
    },
  },
  '/api/reports/expiry-advance-notify': {
    post: {
      tags: ['Reports'],
      summary: 'Dispatch advance expiry notifications',
      description: 'Dispatches `credential_expiring` notifications for credentials expiring within `threshold_days` (default 30).',
      requestBody: {
        content: {
          'application/json': {
            schema: {
              type: 'object',
              properties: {
                threshold_days: { type: 'integer', minimum: 1, maximum: 365, default: 30 },
              },
            },
          },
        },
      },
      responses: {
        '200': {
          description: 'Notification dispatch result.',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  notified: { type: 'integer' },
                  threshold_days: { type: 'integer' },
                  dispatched: { type: 'array', items: { type: 'object', additionalProperties: true } },
                },
              },
            },
          },
        },
        '500': { description: 'Internal error.', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
      },
    },
  },
};
