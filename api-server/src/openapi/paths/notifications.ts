import type { PathsFragment } from './types.js';

export const notificationsPaths: PathsFragment = {
  '/api/notifications/preferences': {
    put: {
      tags: ['Notifications'],
      summary: 'Set notification preferences for an address',
      requestBody: {
        required: true,
        content: { 'application/json': { schema: { $ref: '#/components/schemas/NotificationPreferencesRequest' } } },
      },
      responses: {
        '200': { description: 'Saved.', content: { 'application/json': { schema: { type: 'object', properties: { success: { type: 'boolean' } } } } } },
        '400': { description: 'email/phone required for the enabled channel, or invalid body.', content: { 'application/json': { schema: { $ref: '#/components/schemas/ValidationErrorResponse' } } } },
      },
    },
  },
  '/api/notifications/preferences/{address}': {
    get: {
      tags: ['Notifications'],
      summary: 'Get notification preferences for an address',
      parameters: [{ name: 'address', in: 'path', required: true, schema: { type: 'string' } }],
      responses: {
        '200': { description: 'Preferences.', content: { 'application/json': { schema: { type: 'object', additionalProperties: true } } } },
        '404': { description: 'No preferences found.', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
      },
    },
  },
  '/api/notifications/history': {
    get: {
      tags: ['Notifications'],
      summary: 'Get notification delivery history',
      parameters: [{ name: 'address', in: 'query', schema: { type: 'string' } }],
      responses: {
        '200': { description: 'History entries.', content: { 'application/json': { schema: { type: 'object', properties: { data: { type: 'array', items: { type: 'object', additionalProperties: true } } } } } } },
      },
    },
  },
  '/api/notifications/send': {
    post: {
      tags: ['Notifications'],
      summary: 'Send (dispatch) a notification and broadcast over WebSocket',
      requestBody: {
        required: true,
        content: { 'application/json': { schema: { $ref: '#/components/schemas/NotificationSendRequest' } } },
      },
      responses: {
        '200': {
          description: 'Dispatched.',
          content: { 'application/json': { schema: { type: 'object', properties: { success: { type: 'boolean' }, ws_recipients: { type: 'integer' } } } } },
        },
        '400': { description: 'Invalid body.', content: { 'application/json': { schema: { $ref: '#/components/schemas/ValidationErrorResponse' } } } },
      },
    },
  },
};
