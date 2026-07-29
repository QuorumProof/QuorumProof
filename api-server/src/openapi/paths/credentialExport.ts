import type { PathsFragment } from './types.js';

export const credentialExportPaths: PathsFragment = {
  '/api/credentials/{id}/export': {
    get: {
      tags: ['Credentials'],
      summary: 'Export a credential as JSON, PDF, or a verification QR code',
      parameters: [
        { name: 'id', in: 'path', required: true, schema: { type: 'integer', minimum: 1 } },
        { name: 'format', in: 'query', schema: { type: 'string', enum: ['json', 'pdf', 'qrcode'], default: 'json' } },
      ],
      responses: {
        '200': {
          description: 'The export. Content-Type depends on `format`.',
          content: {
            'application/json': { schema: { type: 'object', properties: { credential: { $ref: '#/components/schemas/Credential' }, verification_url: { type: 'string', format: 'uri' }, exported_at: { type: 'string', format: 'date-time' } } } },
            'application/pdf': { schema: { type: 'string', format: 'binary' } },
            'image/png': { schema: { type: 'string', format: 'binary' } },
          },
        },
        '400': { description: 'Invalid credential id or format.', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
        '404': { description: 'Credential not found.', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
      },
    },
  },
};
