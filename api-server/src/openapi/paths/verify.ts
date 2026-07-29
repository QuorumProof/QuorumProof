import type { PathsFragment } from './types.js';

export const verifyPaths: PathsFragment = {
  '/api/verify/batch': {
    post: {
      tags: ['Verification'],
      summary: 'Batch-verify credential/claim pairs',
      description:
        'Verifies many `(credential_id, claim_type)` pairs in one round trip. Duplicate ' +
        'pairs are deduplicated and resolved once; results are fanned back out in input order.',
      requestBody: {
        required: true,
        content: {
          'application/json': { schema: { $ref: '#/components/schemas/VerifyBatchClaimsRequest' } },
        },
      },
      responses: {
        '200': {
          description: 'Per-item verification results plus a summary.',
          content: {
            'application/json': { schema: { $ref: '#/components/schemas/BatchVerificationResponse' } },
          },
        },
        '400': {
          description: 'Malformed request body.',
          content: { 'application/json': { schema: { $ref: '#/components/schemas/ValidationErrorResponse' } } },
        },
      },
    },
  },
  '/api/verify/{id}': {
    get: {
      tags: ['Verification'],
      summary: 'Look up the current verification status of a single credential',
      description:
        'Canonical verification endpoint that a credential-export QR code links to. When ' +
        '`claim_type` is supplied, also returns a verification proof for that claim.',
      parameters: [
        { name: 'id', in: 'path', required: true, schema: { type: 'integer', minimum: 1 } },
        {
          name: 'claim_type',
          in: 'query',
          required: false,
          schema: { type: 'string' },
          description: 'When present, also returns a signed verification proof for this claim.',
        },
      ],
      responses: {
        '200': {
          description: 'Current credential status.',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  credential_id: { type: 'integer' },
                  status: {
                    type: 'string',
                    enum: ['verified', 'failed', 'not_found', 'revoked', 'expired', 'error'],
                  },
                  checked_at: { type: 'string', format: 'date-time' },
                  claim_type: { type: 'string' },
                  proof: { $ref: '#/components/schemas/BatchVerificationResult/properties/proof' },
                },
              },
            },
          },
        },
        '400': {
          description: 'Invalid credential id.',
          content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } },
        },
      },
    },
  },
};
