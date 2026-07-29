import type { PathsFragment } from './types.js';

export const gdprPaths: PathsFragment = {
  '/api/gdpr/personal-data': {
    post: {
      tags: ['GDPR'],
      summary: "Store a credential's personal data (encrypted, off-chain)",
      description:
        'Encrypts `personalData` with a per-credential key and returns a sha256 commitment ' +
        'the issuer should anchor on-chain. See docs/crypto-shredding-architecture.md.',
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              properties: {
                credentialId: { type: 'integer', minimum: 1 },
                subject: { type: 'string', description: 'Stellar address; must match the on-chain credential subject.' },
                personalData: {},
              },
              required: ['credentialId', 'subject', 'personalData'],
            },
          },
        },
      },
      responses: {
        '201': { description: 'Stored.', content: { 'application/json': { schema: { type: 'object', additionalProperties: true } } } },
        '400': { description: 'Invalid input or subject mismatch.', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
        '404': { description: 'Credential not found.', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
        '410': { description: 'Key already destroyed (erased).', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
      },
    },
  },
  '/api/gdpr/personal-data/{credentialId}/status': {
    get: {
      tags: ['GDPR'],
      summary: 'Get vault status for a credential (no decryption)',
      parameters: [{ name: 'credentialId', in: 'path', required: true, schema: { type: 'integer', minimum: 1 } }],
      responses: {
        '200': { description: 'Status.', content: { 'application/json': { schema: { type: 'object', additionalProperties: true } } } },
        '400': { description: 'Invalid credentialId.', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
      },
    },
  },
  '/api/gdpr/personal-data/{credentialId}': {
    get: {
      tags: ['GDPR'],
      summary: 'Retrieve (decrypted) personal data for a credential',
      parameters: [{ name: 'credentialId', in: 'path', required: true, schema: { type: 'integer', minimum: 1 } }],
      responses: {
        '200': { description: 'Decrypted record.', content: { 'application/json': { schema: { type: 'object', additionalProperties: true } } } },
        '400': { description: 'Invalid credentialId.', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
        '404': { description: 'No personal data stored for this credential.', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
        '410': { description: 'The decryption key has been erased (right-to-erasure completed).', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
      },
    },
  },
  '/api/gdpr/request': {
    post: {
      tags: ['GDPR'],
      summary: 'Submit a right-to-erasure request',
      description:
        'Completes immediately (key destroyed) if the credential has no current attestors; ' +
        'otherwise waits for every current attestor to POST /api/gdpr/consent.',
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: { type: 'object', properties: { credentialId: { type: 'integer', minimum: 1 } }, required: ['credentialId'] },
          },
        },
      },
      responses: {
        '201': { description: 'Request created.', content: { 'application/json': { schema: { $ref: '#/components/schemas/GdprRequest' } } } },
        '400': { description: 'Invalid credentialId.', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
        '404': { description: 'Credential not found.', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
      },
    },
  },
  '/api/gdpr/request/{requestId}': {
    get: {
      tags: ['GDPR'],
      summary: 'Get a GDPR request by id',
      parameters: [{ name: 'requestId', in: 'path', required: true, schema: { type: 'string' } }],
      responses: {
        '200': { description: 'The request.', content: { 'application/json': { schema: { $ref: '#/components/schemas/GdprRequest' } } } },
        '404': { description: 'Not found.', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
      },
    },
  },
  '/api/gdpr/consent': {
    post: {
      tags: ['GDPR'],
      summary: 'Attestor consent to a pending erasure request',
      description:
        'The signer must be a current on-chain attestor for the credential and submit an ' +
        'ed25519 signature over the canonical consent message. When the last required ' +
        "consent lands, the credential's decryption key is destroyed.",
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              properties: {
                requestId: { type: 'string' },
                attestorAddress: { type: 'string' },
                signature: { type: 'string', description: 'Hex-encoded ed25519 signature.' },
              },
              required: ['requestId', 'attestorAddress', 'signature'],
            },
          },
        },
      },
      responses: {
        '200': { description: 'Consent recorded.', content: { 'application/json': { schema: { $ref: '#/components/schemas/GdprRequest' } } } },
        '400': { description: 'Invalid request, or request not pending.', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
        '401': { description: 'Invalid attestor signature.', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
        '403': { description: 'attestorAddress is not a current attestor for this credential.', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
      },
    },
  },
};
