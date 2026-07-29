import type { PathsFragment } from './types.js';

export const shareLinksPaths: PathsFragment = {
  '/api/credentials/{id}/share': {
    post: {
      tags: ['Share Links'],
      summary: 'Create a time-limited share link for a credential',
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer', minimum: 1 } }],
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              properties: {
                subject: { type: 'string', description: 'Stellar address of the credential holder.' },
                expiry_hours: { type: 'integer', minimum: 1, maximum: 8760 },
                permission: { type: 'string', enum: ['view_only', 'download'] },
                password: { type: 'string', description: 'Optional; omit for a public link.' },
              },
              required: ['subject', 'expiry_hours', 'permission'],
            },
          },
        },
      },
      responses: {
        '201': {
          description: 'Created.',
          content: { 'application/json': { schema: { type: 'object', properties: { token: { type: 'string' }, expires_at: { type: 'integer' }, permission: { type: 'string' }, password_protected: { type: 'boolean' }, credential_id: { type: 'integer' } } } } },
        },
        '400': { description: 'Missing/invalid fields.', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
        '403': { description: 'Only the credential holder can create share links.', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
        '404': { description: 'Credential not found.', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
      },
    },
  },
  '/api/credentials/share/validate': {
    post: {
      tags: ['Share Links'],
      summary: 'Validate / redeem a share token',
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: { type: 'object', properties: { token: { type: 'string', description: '32-char hex.' }, password: { type: 'string' } }, required: ['token'] },
          },
        },
      },
      responses: {
        '200': { description: 'Link metadata.', content: { 'application/json': { schema: { type: 'object', additionalProperties: true } } } },
        '400': { description: 'Malformed token.', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
        '403': { description: 'Invalid or missing password.', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
        '410': { description: 'Link expired, revoked, or invalid.', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
      },
    },
  },
  '/api/credentials/share/{token}': {
    get: {
      tags: ['Share Links'],
      summary: 'Inspect share-link metadata (no access enforcement)',
      parameters: [{ name: 'token', in: 'path', required: true, schema: { type: 'string' } }],
      responses: {
        '200': { description: 'Link metadata (password hash redacted).', content: { 'application/json': { schema: { type: 'object', additionalProperties: true } } } },
        '400': { description: 'Malformed token.', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
        '404': { description: 'Not found.', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
      },
    },
    delete: {
      tags: ['Share Links'],
      summary: 'Revoke a share link early',
      parameters: [{ name: 'token', in: 'path', required: true, schema: { type: 'string' } }],
      requestBody: {
        required: true,
        content: { 'application/json': { schema: { type: 'object', properties: { subject: { type: 'string' } }, required: ['subject'] } } },
      },
      responses: {
        '200': { description: 'Revoked.', content: { 'application/json': { schema: { type: 'object', properties: { success: { type: 'boolean' }, message: { type: 'string' } } } } } },
        '400': { description: 'Missing subject or malformed token.', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
        '403': { description: 'Only the link creator can revoke it.', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
        '404': { description: 'Not found.', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
      },
    },
  },
};
