import type { PathsFragment } from './types.js';

const notFound = { description: 'Recovery request not found.', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } };
const badRequest = { description: 'Missing or invalid field.', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } };

export const recoveryPaths: PathsFragment = {
  '/api/recovery/request': {
    post: {
      tags: ['Recovery'],
      summary: 'Start a wallet-recovery request',
      description: 'Sends an OTP to the contact channel; the request then awaits identity verification and attestor approval.',
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              properties: {
                credentialId: { type: 'string' },
                lostWallet: { type: 'string', pattern: '^G[A-Z2-7]{55}$' },
                newWallet: { type: 'string', pattern: '^G[A-Z2-7]{55}$' },
                contactType: { type: 'string', enum: ['email', 'phone'] },
                contactValue: { type: 'string' },
              },
              required: ['credentialId', 'lostWallet', 'newWallet', 'contactType', 'contactValue'],
            },
          },
        },
      },
      responses: {
        '201': { description: 'Request created; OTP sent.', content: { 'application/json': { schema: { type: 'object', properties: { requestId: { type: 'string' }, message: { type: 'string' } } } } } },
        '400': badRequest,
      },
    },
  },
  '/api/recovery/verify-otp': {
    post: {
      tags: ['Recovery'],
      summary: 'Verify the OTP for a recovery request',
      requestBody: {
        required: true,
        content: { 'application/json': { schema: { type: 'object', properties: { requestId: { type: 'string' }, code: { type: 'string' } }, required: ['requestId', 'code'] } } },
      },
      responses: {
        '200': { description: 'Verified; now pending attestor approval.', content: { 'application/json': { schema: { type: 'object', properties: { success: { type: 'boolean' }, message: { type: 'string' } } } } } },
        '400': { description: 'Invalid code.', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
        '404': notFound,
        '409': { description: 'Request is not awaiting verification.', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
        '410': { description: 'Code expired.', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
        '429': { description: 'Too many attempts.', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
      },
    },
  },
  '/api/recovery/resend-otp': {
    post: {
      tags: ['Recovery'],
      summary: 'Resend the OTP for a pending recovery request',
      requestBody: {
        required: true,
        content: { 'application/json': { schema: { type: 'object', properties: { requestId: { type: 'string' } }, required: ['requestId'] } } },
      },
      responses: {
        '200': { description: 'Resent.', content: { 'application/json': { schema: { type: 'object', properties: { message: { type: 'string' } } } } } },
        '400': badRequest,
        '404': notFound,
        '409': { description: 'Request is not awaiting verification.', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
      },
    },
  },
  '/api/recovery/status/{requestId}': {
    get: {
      tags: ['Recovery'],
      summary: 'Get the status of a recovery request',
      parameters: [{ name: 'requestId', in: 'path', required: true, schema: { type: 'string' } }],
      responses: {
        '200': { description: 'Request status (contact value redacted).', content: { 'application/json': { schema: { type: 'object', additionalProperties: true } } } },
        '404': notFound,
      },
    },
  },
  '/api/recovery/pending': {
    get: {
      tags: ['Recovery'],
      summary: 'List recovery requests pending attestor approval',
      parameters: [{ name: 'attestor', in: 'query', required: true, schema: { type: 'string' } }],
      responses: {
        '200': { description: 'Pending requests.', content: { 'application/json': { schema: { type: 'object', properties: { attestor: { type: 'string' }, items: { type: 'array', items: { type: 'object', additionalProperties: true } }, total: { type: 'integer' } } } } } },
        '400': badRequest,
      },
    },
  },
  '/api/recovery/approve': {
    post: {
      tags: ['Recovery'],
      summary: 'Approve a pending recovery request',
      requestBody: {
        required: true,
        content: { 'application/json': { schema: { type: 'object', properties: { requestId: { type: 'string' }, attestor: { type: 'string' } }, required: ['requestId', 'attestor'] } } },
      },
      responses: {
        '200': { description: 'Approved; re-issuance initiated.', content: { 'application/json': { schema: { type: 'object', properties: { success: { type: 'boolean' }, message: { type: 'string' } } } } } },
        '400': badRequest,
        '404': notFound,
        '409': { description: 'Request is not in pending_approval status.', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
      },
    },
  },
  '/api/recovery/reject': {
    post: {
      tags: ['Recovery'],
      summary: 'Reject a pending recovery request',
      requestBody: {
        required: true,
        content: { 'application/json': { schema: { type: 'object', properties: { requestId: { type: 'string' }, attestor: { type: 'string' }, reason: { type: 'string' } }, required: ['requestId', 'attestor'] } } },
      },
      responses: {
        '200': { description: 'Rejected.', content: { 'application/json': { schema: { type: 'object', properties: { success: { type: 'boolean' }, message: { type: 'string' } } } } } },
        '400': badRequest,
        '404': notFound,
        '409': { description: 'Request is not in pending_approval status.', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
      },
    },
  },
};
