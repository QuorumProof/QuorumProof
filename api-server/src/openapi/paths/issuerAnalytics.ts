import type { PathsFragment } from './types.js';

const rangeParam = { name: 'range', in: 'query' as const, schema: { type: 'string' as const, enum: ['7d', '30d', '90d'], default: '30d' } };

export const issuerAnalyticsPaths: PathsFragment = {
  '/api/analytics/credentials': {
    get: {
      tags: ['Analytics'],
      summary: 'Get per-issuer credential issuance breakdown',
      parameters: [
        { name: 'issuer', in: 'query', required: true, schema: { type: 'string' } },
        rangeParam,
      ],
      responses: {
        '200': { description: 'Issuance totals, breakdown by type, expiry distribution.', content: { 'application/json': { schema: { type: 'object', additionalProperties: true } } } },
        '400': { description: 'Missing issuer or invalid range.', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
      },
    },
  },
  '/api/analytics/verifications': {
    get: {
      tags: ['Analytics'],
      summary: 'Get verification counts by claim type and verifier',
      parameters: [rangeParam],
      responses: {
        '200': { description: 'Verification distribution.', content: { 'application/json': { schema: { type: 'object', additionalProperties: true } } } },
        '400': { description: 'Invalid range.', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
      },
    },
  },
  '/api/analytics/disputes': {
    get: {
      tags: ['Analytics'],
      summary: 'Get dispute rate and resolution stats',
      parameters: [{ name: 'issuer', in: 'query', schema: { type: 'string' } }, rangeParam],
      responses: {
        '200': { description: 'Dispute stats.', content: { 'application/json': { schema: { type: 'object', additionalProperties: true } } } },
        '400': { description: 'Invalid range.', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
      },
    },
  },
};
