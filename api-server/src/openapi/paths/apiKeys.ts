import type { PathsFragment } from './types.js';

const apiKeySummary = {
  type: 'object' as const,
  properties: {
    id: { type: 'string' as const },
    name: { type: 'string' as const },
    createdAt: { type: 'string' as const, format: 'date-time' },
    lastUsedAt: { type: ['string', 'null'] as const, format: 'date-time' },
    active: { type: 'boolean' as const },
  },
};

export const apiKeysPaths: PathsFragment = {
  '/api/api-keys': {
    post: {
      tags: ['API Keys'],
      summary: 'Generate a new API key',
      description:
        'The full secret is returned exactly once, in this response. Callers must persist it — ' +
        'it cannot be retrieved again (only rotated).',
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              properties: { name: { type: 'string', minLength: 1 } },
              required: ['name'],
            },
          },
        },
      },
      responses: {
        '201': { description: 'Created.', content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiKeyCreateResponse' } } } },
        '400': { description: 'Missing name.', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
        '401': { description: 'Missing or invalid authorization.', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
      },
    },
    get: {
      tags: ['API Keys'],
      summary: "List the caller's active API keys",
      responses: {
        '200': { description: 'Keys (secrets never included).', content: { 'application/json': { schema: { type: 'object', properties: { data: { type: 'array', items: apiKeySummary } } } } } },
        '401': { description: 'Missing or invalid authorization.', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
      },
    },
  },
  '/api/api-keys/{id}': {
    get: {
      tags: ['API Keys'],
      summary: 'Get a single API key',
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
      responses: {
        '200': { description: 'The key.', content: { 'application/json': { schema: apiKeySummary } } },
        '404': { description: 'Not found.', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
      },
    },
    delete: {
      tags: ['API Keys'],
      summary: 'Revoke an API key',
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
      responses: {
        '204': { description: 'Revoked.' },
        '404': { description: 'Not found.', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
      },
    },
  },
  '/api/api-keys/{id}/rotate': {
    post: {
      tags: ['API Keys'],
      summary: 'Rotate an API key',
      description: 'Issues a new secret; the old key keeps working until `gracePeriodMs` elapses.',
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
      requestBody: {
        required: false,
        content: {
          'application/json': {
            schema: { type: 'object', properties: { gracePeriodMs: { type: 'integer', minimum: 1 } } },
          },
        },
      },
      responses: {
        '201': { description: 'New key issued.', content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiKeyCreateResponse' } } } },
        '404': { description: 'Not found.', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
        '409': { description: 'Key already inactive.', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
      },
    },
  },
  '/api/api-keys/{id}/usage': {
    get: {
      tags: ['API Keys'],
      summary: 'Get usage history for a key',
      parameters: [
        { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
        { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 1000, default: 100 } },
      ],
      responses: {
        '200': { description: 'Usage entries.', content: { 'application/json': { schema: { type: 'object', properties: { data: { type: 'array', items: { type: 'object', additionalProperties: true } } } } } } },
        '404': { description: 'Not found.', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
      },
    },
  },
  '/api/api-keys/stats/overview': {
    get: {
      tags: ['API Keys'],
      summary: "Get the caller's key statistics",
      responses: {
        '200': { description: 'Aggregate stats.', content: { 'application/json': { schema: { type: 'object', additionalProperties: true } } } },
        '401': { description: 'Missing or invalid authorization.', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
      },
    },
  },
};
