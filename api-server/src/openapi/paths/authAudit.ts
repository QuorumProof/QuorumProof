import type { PathsFragment } from './types.js';

export const authAuditPaths: PathsFragment = {
  '/api/audit/auth-events': {
    get: {
      tags: ['AuthAudit'],
      summary: 'Query authentication audit events (admin only)',
      description: 'Returns paginated authentication audit events. Admin permission required.',
      parameters: [
        { name: 'user_id', in: 'query', schema: { type: 'string' }, description: 'Filter by user ID.' },
        {
          name: 'event_type',
          in: 'query',
          schema: {
            type: 'string',
            enum: [
              'login_success', 'login_failure', 'logout',
              'magic_link_requested', 'magic_link_verified', 'magic_link_failed',
              'webauthn_registered', 'webauthn_verified', 'webauthn_failed',
              'mfa_success', 'mfa_failure', 'key_rotation',
              'token_refreshed', 'session_expired', 'account_locked',
            ],
          },
          description: 'Filter by event type.',
        },
        {
          name: 'status',
          in: 'query',
          schema: { type: 'string', enum: ['success', 'failure', 'info'] },
          description: 'Filter by event status.',
        },
        { name: 'start_date', in: 'query', schema: { type: 'string', format: 'date-time' }, description: 'Inclusive lower date bound (ISO 8601).' },
        { name: 'end_date', in: 'query', schema: { type: 'string', format: 'date-time' }, description: 'Inclusive upper date bound (ISO 8601).' },
        { name: 'ip_address', in: 'query', schema: { type: 'string' }, description: 'Filter by IP address.' },
        { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 200, default: 50 } },
        { name: 'offset', in: 'query', schema: { type: 'integer', minimum: 0, default: 0 } },
      ],
      responses: {
        '200': {
          description: 'Paginated authentication events.',
          content: {
            'application/json': {
              schema: { type: 'object', additionalProperties: true },
            },
          },
        },
        '400': {
          description: 'Invalid query parameter.',
          content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } },
        },
        '403': {
          description: 'Admin permission required.',
          content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } },
        },
      },
    },
  },
  '/api/audit/auth-events/alerts': {
    get: {
      tags: ['AuthAudit'],
      summary: 'Get suspicious authentication activity alerts (admin only)',
      description: 'Detects brute-force attempts and credential stuffing patterns. Admin permission required.',
      responses: {
        '200': {
          description: 'Suspicious activity alerts.',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  count: { type: 'integer' },
                  alerts: { type: 'array', items: { type: 'object', additionalProperties: true } },
                },
              },
            },
          },
        },
        '403': {
          description: 'Admin permission required.',
          content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } },
        },
      },
    },
  },
};
