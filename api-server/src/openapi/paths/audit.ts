import type { PathsFragment } from './types.js';

const auditQueryParams = [
  { name: 'cursor', in: 'query' as const, schema: { type: 'string' as const }, description: 'Base64-encoded cursor from the previous response.' },
  { name: 'limit', in: 'query' as const, schema: { type: 'integer' as const, minimum: 1, maximum: 100, default: 20 } },
  { name: 'credential_id', in: 'query' as const, schema: { type: 'integer' as const }, description: 'Filter by credential ID.' },
  { name: 'action', in: 'query' as const, schema: { type: 'string' as const, enum: ['CredentialIssued', 'CredentialRevoked', 'CredentialAttested', 'CredentialSuspended', 'CredentialRenewed', 'SbtMinted', 'SbtBurned'] }, description: 'Filter by action name.' },
];

export const auditPaths: PathsFragment = {
  '/api/audit/entries': {
    get: {
      tags: ['Audit'],
      summary: 'List audit log entries (cursor-paginated)',
      description: 'Returns cursor-paginated audit log entries with optional credential_id and action filtering.',
      parameters: auditQueryParams,
      responses: {
        '200': {
          description: 'Paginated audit entries.',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  data: { type: 'array', items: { type: 'object', additionalProperties: true } },
                  pagination: {
                    type: 'object',
                    properties: {
                      cursor: { type: 'string', nullable: true },
                      next_cursor: { type: 'string', nullable: true },
                      limit: { type: 'integer' },
                      total: {},
                      has_more: { type: 'boolean' },
                    },
                  },
                },
              },
            },
          },
        },
        '400': { description: 'Invalid cursor or parameters.', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
        '500': { description: 'Internal error.', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
      },
    },
  },
  '/api/audit/entries/{id}': {
    get: {
      tags: ['Audit'],
      summary: 'Get a single audit entry by ID',
      parameters: [
        { name: 'id', in: 'path', required: true, schema: { type: 'integer' }, description: 'Audit entry ID.' },
      ],
      responses: {
        '200': { description: 'Audit entry.', content: { 'application/json': { schema: { type: 'object', additionalProperties: true } } } },
        '400': { description: 'Invalid entry ID.', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
        '404': { description: 'Entry not found.', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
        '500': { description: 'Internal error.', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
      },
    },
  },
  '/api/audit/notarizations/{batch_id}': {
    get: {
      tags: ['Audit'],
      summary: 'Get a notarisation record by batch ID',
      parameters: [
        { name: 'batch_id', in: 'path', required: true, schema: { type: 'integer' }, description: 'Batch (notarisation) ID.' },
      ],
      responses: {
        '200': { description: 'Notarisation record.', content: { 'application/json': { schema: { type: 'object', additionalProperties: true } } } },
        '400': { description: 'Invalid batch ID.', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
        '404': { description: 'Not found.', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
        '500': { description: 'Internal error.', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
      },
    },
  },
  '/api/audit/stats': {
    get: {
      tags: ['Audit'],
      summary: 'Audit log statistics',
      description: 'Returns total entry count and batch count.',
      responses: {
        '200': {
          description: 'Audit statistics.',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  entry_count: {},
                  batch_count: {},
                },
              },
            },
          },
        },
        '500': { description: 'Internal error.', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
      },
    },
  },
  '/api/audit/export': {
    get: {
      tags: ['Audit'],
      summary: 'Export audit logs for compliance',
      description: 'Exports audit log entries in JSON Lines, JSON, or CSV format with optional filtering by credential, action, and date range.',
      parameters: [
        { name: 'format', in: 'query', schema: { type: 'string', enum: ['jsonl', 'json', 'csv'], default: 'jsonl' } },
        { name: 'credential_id', in: 'query', schema: { type: 'integer' } },
        { name: 'action', in: 'query', schema: { type: 'string' } },
        { name: 'start_date', in: 'query', schema: { type: 'string', format: 'date-time' } },
        { name: 'end_date', in: 'query', schema: { type: 'string', format: 'date-time' } },
      ],
      responses: {
        '200': { description: 'Exported audit log (content-type varies by format).' },
        '400': { description: 'Invalid parameters.', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
        '500': { description: 'Internal error.', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
      },
    },
  },
  '/api/audit/verify': {
    post: {
      tags: ['Audit'],
      summary: 'Verify Merkle root integrity for a batch',
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              required: ['batch_id'],
              properties: {
                batch_id: { type: 'integer' },
              },
            },
          },
        },
      },
      responses: {
        '200': {
          description: 'Verification result.',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  batch_id: { type: 'integer' },
                  valid: { type: 'boolean' },
                  merkle_root: {},
                  entry_count: {},
                },
              },
            },
          },
        },
        '400': { description: 'Invalid body.', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
        '500': { description: 'Internal error.', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
      },
    },
  },
  '/api/audit/integrity': {
    get: {
      tags: ['Audit'],
      summary: 'Validate overall audit log integrity',
      description: 'Validates sequential IDs and monotonic timestamps across the entire audit log.',
      responses: {
        '200': {
          description: 'Integrity validation result.',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  total_entries: {},
                  validation_result: { type: 'object', additionalProperties: true },
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
