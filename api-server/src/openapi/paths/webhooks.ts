import type { PathsFragment } from './types.js';

const webhookEventEnum = { type: 'string' as const, enum: ['credential_issued', 'credential_attested', 'credential_revoked'] };

export const webhooksPaths: PathsFragment = {
  '/api/webhooks': {
    post: {
      tags: ['Webhooks'],
      summary: 'Register a webhook',
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              properties: {
                url: { type: 'string', format: 'uri' },
                events: { type: 'array', items: webhookEventEnum, minItems: 1 },
                secret: { type: 'string', description: 'Used to HMAC-sign delivered payloads.' },
              },
              required: ['url', 'events'],
            },
          },
        },
      },
      responses: {
        '201': { description: 'Registered.', content: { 'application/json': { schema: { $ref: '#/components/schemas/Webhook' } } } },
        '400': { description: 'Invalid url or events.', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
      },
    },
    get: {
      tags: ['Webhooks'],
      summary: 'List registered webhooks',
      responses: { '200': { description: 'Webhooks.', content: { 'application/json': { schema: { type: 'object', properties: { data: { type: 'array', items: { $ref: '#/components/schemas/Webhook' } } } } } } } },
    },
  },
  '/api/webhooks/deliveries/log': {
    get: {
      tags: ['Webhooks'],
      summary: 'Get the webhook delivery log',
      responses: { '200': { description: 'Delivery attempts.', content: { 'application/json': { schema: { type: 'object', properties: { data: { type: 'array', items: { type: 'object', additionalProperties: true } } } } } } } },
    },
  },
  '/api/webhooks/dead-letters': {
    get: {
      tags: ['Webhooks'],
      summary: 'List deliveries that exhausted retries',
      responses: { '200': { description: 'Dead-lettered deliveries.', content: { 'application/json': { schema: { type: 'object', properties: { data: { type: 'array', items: { type: 'object', additionalProperties: true } } } } } } } },
    },
  },
  '/api/webhooks/dead-letters/{id}/replay': {
    post: {
      tags: ['Webhooks'],
      summary: 'Re-queue a dead-lettered delivery',
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
      responses: {
        '202': { description: 'Re-queued.', content: { 'application/json': { schema: { type: 'object', additionalProperties: true } } } },
        '404': { description: 'Not found.', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
      },
    },
  },
  '/api/webhooks/{id}': {
    get: {
      tags: ['Webhooks'],
      summary: 'Get a webhook',
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
      responses: {
        '200': { description: 'The webhook.', content: { 'application/json': { schema: { $ref: '#/components/schemas/Webhook' } } } },
        '404': { description: 'Not found.', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
      },
    },
    delete: {
      tags: ['Webhooks'],
      summary: 'Remove a webhook',
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
      responses: {
        '204': { description: 'Removed.' },
        '404': { description: 'Not found.', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
      },
    },
  },
};
