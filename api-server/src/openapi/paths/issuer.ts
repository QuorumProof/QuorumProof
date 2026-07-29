import type { PathsFragment } from './types.js';

export const issuerPaths: PathsFragment = {
  '/api/issuer/{address}/metrics': {
    get: {
      tags: ['Issuer'],
      summary: 'Get issuance metrics for an issuer over a period',
      parameters: [
        { name: 'address', in: 'path', required: true, schema: { type: 'string' } },
        { name: 'period_days', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 365, default: 30 } },
      ],
      responses: {
        '200': { description: 'Metrics.', content: { 'application/json': { schema: { type: 'object', additionalProperties: true } } } },
        '400': { description: 'Invalid period_days.', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
      },
    },
  },
};
