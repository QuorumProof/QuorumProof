import type { PathsFragment } from './types.js';

const internalError = { description: 'Internal server error.', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } };

export const privilegeEscalationPaths: PathsFragment = {
  '/api/admin/privilege-escalation/mfa-challenge': {
    post: {
      tags: ['Privilege Escalation'],
      summary: 'Request an MFA challenge for a privileged action',
      requestBody: {
        required: true,
        content: { 'application/json': { schema: { type: 'object', properties: { userId: { type: 'string' } }, required: ['userId'] } } },
      },
      responses: {
        '200': { description: 'Challenge issued.', content: { 'application/json': { schema: { type: 'object', properties: { userId: { type: 'string' }, expiresAt: { type: 'string', format: 'date-time' }, message: { type: 'string' } } } } } },
        '400': { description: 'Missing userId.', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
        '500': internalError,
      },
    },
  },
  '/api/admin/privilege-escalation/verify-mfa': {
    post: {
      tags: ['Privilege Escalation'],
      summary: 'Verify an MFA code for a pending escalation challenge',
      requestBody: {
        required: true,
        content: { 'application/json': { schema: { type: 'object', properties: { userId: { type: 'string' }, code: { type: 'string' } }, required: ['userId', 'code'] } } },
      },
      responses: {
        '200': { description: 'Verified.', content: { 'application/json': { schema: { type: 'object', properties: { verified: { type: 'boolean' }, message: { type: 'string' } } } } } },
        '400': { description: 'Missing userId or code.', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
        '401': { description: 'Invalid or expired MFA code.', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
        '500': internalError,
      },
    },
  },
  '/api/admin/privilege-escalation/request': {
    post: {
      tags: ['Privilege Escalation'],
      summary: 'Submit a privilege change request',
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              properties: { userId: { type: 'string' }, newRole: { type: 'string' }, reason: { type: 'string' }, approvers: { type: 'array', items: { type: 'string' } } },
              required: ['userId', 'newRole'],
            },
          },
        },
      },
      responses: {
        '200': { description: 'Submitted.', content: { 'application/json': { schema: { type: 'object', properties: { requestId: { type: 'string' }, status: { type: 'string' }, message: { type: 'string' } } } } } },
        '400': { description: 'Missing userId or newRole.', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
        '500': internalError,
      },
    },
  },
  '/api/admin/privilege-escalation/approve': {
    post: {
      tags: ['Privilege Escalation'],
      summary: 'Approve a pending privilege change request',
      requestBody: {
        required: true,
        content: { 'application/json': { schema: { type: 'object', properties: { requestId: { type: 'string' }, approverId: { type: 'string' } }, required: ['requestId', 'approverId'] } } },
      },
      responses: {
        '200': { description: 'Approved.', content: { 'application/json': { schema: { type: 'object', properties: { approved: { type: 'boolean' }, message: { type: 'string' } } } } } },
        '400': { description: 'Missing requestId or approverId.', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
        '404': { description: 'Request not found.', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
        '500': internalError,
      },
    },
  },
  '/api/admin/privilege-escalation/reject': {
    post: {
      tags: ['Privilege Escalation'],
      summary: 'Reject a pending privilege change request',
      requestBody: {
        required: true,
        content: { 'application/json': { schema: { type: 'object', properties: { requestId: { type: 'string' }, approverId: { type: 'string' }, reason: { type: 'string' } }, required: ['requestId', 'approverId'] } } },
      },
      responses: {
        '200': { description: 'Rejected.', content: { 'application/json': { schema: { type: 'object', properties: { rejected: { type: 'boolean' }, message: { type: 'string' } } } } } },
        '400': { description: 'Missing requestId or approverId.', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
        '404': { description: 'Request not found.', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
        '500': internalError,
      },
    },
  },
  '/api/admin/privilege-escalation/audit-log': {
    get: {
      tags: ['Privilege Escalation'],
      summary: 'Get the privilege-escalation audit log',
      parameters: [
        { name: 'userId', in: 'query', schema: { type: 'string' } },
        { name: 'limit', in: 'query', schema: { type: 'integer', default: 100 } },
      ],
      responses: {
        '200': { description: 'Log entries.', content: { 'application/json': { schema: { type: 'object', properties: { total: { type: 'integer' }, logs: { type: 'array', items: { type: 'object', additionalProperties: true } } } } } } },
        '500': internalError,
      },
    },
  },
  '/api/admin/privilege-escalation/pending': {
    get: {
      tags: ['Privilege Escalation'],
      summary: 'List pending privilege change approvals',
      responses: {
        '200': { description: 'Pending requests.', content: { 'application/json': { schema: { type: 'object', properties: { total: { type: 'integer' }, requests: { type: 'array', items: { type: 'object', additionalProperties: true } } } } } } },
        '500': internalError,
      },
    },
  },
};
