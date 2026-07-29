import type { PathsFragment } from './types.js';

const credentialNotFound = { description: 'Credential not found.', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } };
const forbidden = { description: 'Caller is not the credential holder.', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } };

export const consentPaths: PathsFragment = {
  '/api/credentials/{id}/consent/verifiers': {
    get: {
      tags: ['Consent'],
      summary: 'List verifiers who have accessed a credential',
      parameters: [
        { name: 'id', in: 'path', required: true, schema: { type: 'integer', minimum: 1 } },
        { name: 'holder', in: 'query', required: true, schema: { type: 'string' }, description: 'Stellar address of the credential holder.' },
      ],
      responses: {
        '200': { description: 'Verifiers.', content: { 'application/json': { schema: { type: 'object', properties: { credential_id: { type: 'integer' }, verifiers: { type: 'array', items: {} }, total: { type: 'integer' } } } } } },
        '400': { description: 'Invalid id or missing holder.', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
        '403': forbidden,
        '404': credentialNotFound,
      },
    },
  },
  '/api/credentials/{id}/consent/access-log': {
    get: {
      tags: ['Consent'],
      summary: 'Get the full verifier access log for a credential',
      parameters: [
        { name: 'id', in: 'path', required: true, schema: { type: 'integer', minimum: 1 } },
        { name: 'holder', in: 'query', required: true, schema: { type: 'string' } },
        { name: 'verifier', in: 'query', schema: { type: 'string' } },
        { name: 'access_type', in: 'query', schema: { type: 'integer', enum: [1, 2, 3] }, description: '1=share_link, 2=delegation, 3=proof_request.' },
      ],
      responses: {
        '200': { description: 'Access log entries.', content: { 'application/json': { schema: { type: 'object', properties: { credential_id: { type: 'integer' }, entries: { type: 'array', items: { type: 'object', additionalProperties: true } }, total: { type: 'integer' } } } } } },
        '400': { description: 'Invalid id or missing holder.', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
        '403': forbidden,
        '404': credentialNotFound,
      },
    },
  },
  '/api/credentials/{id}/consent/grants': {
    post: {
      tags: ['Consent'],
      summary: 'Grant a verifier consent to access a credential',
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer', minimum: 1 } }],
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              properties: { holder: { type: 'string' }, verifier: { type: 'string' }, expires_at: { type: 'integer', description: 'Unix timestamp; 0 = no expiry.', default: 0 } },
              required: ['holder', 'verifier'],
            },
          },
        },
      },
      responses: {
        '201': { description: 'Granted.', content: { 'application/json': { schema: { type: 'object', additionalProperties: true } } } },
        '400': { description: 'Missing fields or invalid expires_at.', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
        '403': forbidden,
        '404': credentialNotFound,
      },
    },
  },
  '/api/credentials/{id}/consent/grants/{verifier}': {
    get: {
      tags: ['Consent'],
      summary: 'Get a specific consent grant',
      parameters: [
        { name: 'id', in: 'path', required: true, schema: { type: 'integer', minimum: 1 } },
        { name: 'verifier', in: 'path', required: true, schema: { type: 'string' } },
      ],
      responses: {
        '200': { description: 'The grant.', content: { 'application/json': { schema: { type: 'object', additionalProperties: true } } } },
        '404': { description: 'No consent grant found.', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
      },
    },
    delete: {
      tags: ['Consent'],
      summary: 'Revoke a verifier consent grant',
      parameters: [
        { name: 'id', in: 'path', required: true, schema: { type: 'integer', minimum: 1 } },
        { name: 'verifier', in: 'path', required: true, schema: { type: 'string' } },
      ],
      requestBody: {
        required: true,
        content: { 'application/json': { schema: { type: 'object', properties: { holder: { type: 'string' } }, required: ['holder'] } } },
      },
      responses: {
        '200': { description: 'Revoked.', content: { 'application/json': { schema: { type: 'object', additionalProperties: true } } } },
        '400': { description: 'Missing holder.', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
        '403': forbidden,
        '404': credentialNotFound,
      },
    },
  },
  '/api/credentials/{id}/consent/grants/{verifier}/status': {
    get: {
      tags: ['Consent'],
      summary: 'Check whether a consent grant is currently active',
      parameters: [
        { name: 'id', in: 'path', required: true, schema: { type: 'integer', minimum: 1 } },
        { name: 'verifier', in: 'path', required: true, schema: { type: 'string' } },
      ],
      responses: {
        '200': { description: 'Status.', content: { 'application/json': { schema: { type: 'object', properties: { credential_id: { type: 'integer' }, verifier: { type: 'string' }, consent_active: { type: 'boolean' } } } } } },
      },
    },
  },
  '/api/credentials/{id}/consent/access': {
    post: {
      tags: ['Consent'],
      summary: 'Record a verifier access event',
      description: 'Used by internal services / the bridge relay to log access.',
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer', minimum: 1 } }],
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              properties: { holder: { type: 'string' }, verifier: { type: 'string' }, access_type: { type: 'integer', enum: [1, 2, 3] } },
              required: ['holder', 'verifier', 'access_type'],
            },
          },
        },
      },
      responses: {
        '201': { description: 'Recorded.', content: { 'application/json': { schema: { type: 'object', additionalProperties: true } } } },
        '400': { description: 'Missing/invalid fields.', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
        '403': forbidden,
        '404': credentialNotFound,
      },
    },
  },
};
