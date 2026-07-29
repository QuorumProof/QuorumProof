import type { PathsFragment } from './types.js';

const unauthorized = { description: 'No authenticated user address on the request.', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } };

export const dashboardPaths: PathsFragment = {
  '/api/me/credentials': {
    get: {
      tags: ['Dashboard'],
      summary: "List the authenticated user's credentials",
      responses: {
        '200': {
          description: 'Credential summary.',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  credentials: { type: 'array', items: { type: 'object', additionalProperties: true } },
                  total: { type: 'integer' },
                  active_count: { type: 'integer' },
                  revoked_count: { type: 'integer' },
                  suspended_count: { type: 'integer' },
                  expiring_soon: { type: 'integer', description: 'Active, non-revoked credentials expiring within 30 days.' },
                },
              },
            },
          },
        },
        '401': unauthorized,
      },
    },
  },
  '/api/me/credentials/{id}': {
    get: {
      tags: ['Dashboard'],
      summary: 'Get full detail for one of the authenticated user’s credentials',
      parameters: [
        { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
        { name: 'include_history', in: 'query', schema: { type: 'boolean' } },
        { name: 'include_disputes', in: 'query', schema: { type: 'boolean' } },
      ],
      responses: {
        '200': { description: 'Credential detail with attestations, and optionally amendment/dispute history.', content: { 'application/json': { schema: { type: 'object', additionalProperties: true } } } },
        '401': unauthorized,
        '403': { description: 'Credential does not belong to the authenticated user.', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
      },
    },
  },
  '/api/me/disputes': {
    get: {
      tags: ['Dashboard'],
      summary: "List disputes against the user's credentials",
      parameters: [
        { name: 'status', in: 'query', schema: { type: 'string', enum: ['pending', 'resolved', 'rejected'] } },
        { name: 'sort_by', in: 'query', schema: { type: 'string', enum: ['created_at', 'status'], default: 'created_at' } },
        { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 100, default: 50 } },
      ],
      responses: {
        '200': { description: 'Disputes.', content: { 'application/json': { schema: { type: 'object', properties: { disputes: { type: 'array', items: { type: 'object', additionalProperties: true } }, total: { type: 'integer' }, pending_count: { type: 'integer' }, resolved_count: { type: 'integer' } } } } } },
        '401': unauthorized,
      },
    },
    post: {
      tags: ['Dashboard'],
      summary: 'Create a dispute against a credential',
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              properties: { credential_id: { type: 'string' }, reason: { type: 'string' }, evidence_hash: { type: 'string' } },
              required: ['credential_id', 'reason'],
            },
          },
        },
      },
      responses: {
        '201': { description: 'Created.', content: { 'application/json': { schema: { type: 'object', additionalProperties: true } } } },
        '400': { description: 'Missing credential_id or reason.', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
        '401': unauthorized,
      },
    },
  },
  '/api/me/access-log': {
    get: {
      tags: ['Dashboard'],
      summary: "Get the access/audit log for the user's credentials",
      parameters: [
        { name: 'credential_id', in: 'query', schema: { type: 'string' } },
        { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 500, default: 100 } },
        { name: 'offset', in: 'query', schema: { type: 'integer', minimum: 0, default: 0 } },
        { name: 'from', in: 'query', schema: { type: 'string', format: 'date-time' } },
        { name: 'to', in: 'query', schema: { type: 'string', format: 'date-time' } },
      ],
      responses: {
        '200': { description: 'Access log entries.', content: { 'application/json': { schema: { type: 'object', properties: { access_logs: { type: 'array', items: { type: 'object', additionalProperties: true } }, total: { type: 'integer' } } } } } },
        '401': unauthorized,
      },
    },
    post: {
      tags: ['Dashboard'],
      summary: 'Log a credential access event',
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              properties: {
                credential_id: { type: 'string' },
                accessed_by: { type: 'string' },
                reason: { type: 'string' },
                duration_seconds: { type: 'number' },
              },
              required: ['credential_id', 'accessed_by', 'reason'],
            },
          },
        },
      },
      responses: {
        '201': { description: 'Logged.', content: { 'application/json': { schema: { type: 'object', additionalProperties: true } } } },
        '400': { description: 'Missing required fields.', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
      },
    },
  },
  '/api/me/summary': {
    get: {
      tags: ['Dashboard'],
      summary: 'Get a quick dashboard summary',
      responses: {
        '200': {
          description: 'Summary counts.',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  total_credentials: { type: 'integer' },
                  active_credentials: { type: 'integer' },
                  pending_disputes: { type: 'integer' },
                  credentials_expiring_30_days: { type: 'integer' },
                  last_access_at: { type: ['string', 'null'], format: 'date-time' },
                },
              },
            },
          },
        },
        '401': unauthorized,
      },
    },
  },
};
