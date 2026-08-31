import type { PathsFragment } from './types.js';

export const passwordlessAuthPaths: PathsFragment = {
  '/api/auth/passwordless/start': {
    post: {
      tags: ['PasswordlessAuth'],
      summary: 'Initiate magic-link authentication',
      description:
        'Sends a magic-link token to the provided email address. ' +
        'In dev/test mode the token is also returned in the response body.',
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              required: ['email'],
              properties: {
                email: { type: 'string', format: 'email' },
              },
            },
          },
        },
      },
      responses: {
        '202': {
          description: 'Magic link dispatched.',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  message: { type: 'string' },
                  expires_at: { type: 'string', format: 'date-time' },
                  magic_link_token: { type: 'string', description: 'Dev/test only — remove in production.' },
                },
              },
            },
          },
        },
        '400': {
          description: 'Invalid or missing email.',
          content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } },
        },
      },
    },
  },
  '/api/auth/passwordless/verify': {
    post: {
      tags: ['PasswordlessAuth'],
      summary: 'Verify a magic-link token',
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              required: ['token'],
              properties: {
                token: { type: 'string' },
              },
            },
          },
        },
      },
      responses: {
        '200': {
          description: 'Authentication successful.',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  success: { type: 'boolean' },
                  email: { type: 'string' },
                  message: { type: 'string' },
                },
              },
            },
          },
        },
        '400': {
          description: 'Missing token.',
          content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } },
        },
        '401': {
          description: 'Invalid or expired token.',
          content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } },
        },
      },
    },
  },
  '/api/auth/webauthn/register/start': {
    post: {
      tags: ['PasswordlessAuth'],
      summary: 'Begin WebAuthn credential registration',
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              required: ['user_id'],
              properties: {
                user_id: { type: 'string' },
              },
            },
          },
        },
      },
      responses: {
        '200': {
          description: 'Registration challenge.',
          content: {
            'application/json': {
              schema: { type: 'object', additionalProperties: true },
            },
          },
        },
        '400': {
          description: 'Missing user_id.',
          content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } },
        },
      },
    },
  },
  '/api/auth/webauthn/register/verify': {
    post: {
      tags: ['PasswordlessAuth'],
      summary: 'Complete WebAuthn credential registration',
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              required: ['challenge', 'credential_id', 'public_key', 'client_data_json', 'user_id'],
              properties: {
                challenge: { type: 'string' },
                credential_id: { type: 'string' },
                public_key: { type: 'string' },
                client_data_json: { type: 'string', description: 'base64url-encoded client data.' },
                user_id: { type: 'string' },
              },
            },
          },
        },
      },
      responses: {
        '201': {
          description: 'WebAuthn credential registered.',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  success: { type: 'boolean' },
                  credential: { type: 'object', additionalProperties: true },
                  message: { type: 'string' },
                },
              },
            },
          },
        },
        '400': {
          description: 'Missing required fields.',
          content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } },
        },
        '401': {
          description: 'Registration verification failed.',
          content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } },
        },
      },
    },
  },
  '/api/auth/webauthn/authenticate/start': {
    post: {
      tags: ['PasswordlessAuth'],
      summary: 'Begin WebAuthn authentication',
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              required: ['user_id'],
              properties: {
                user_id: { type: 'string' },
              },
            },
          },
        },
      },
      responses: {
        '200': {
          description: 'Authentication challenge.',
          content: {
            'application/json': {
              schema: { type: 'object', additionalProperties: true },
            },
          },
        },
        '400': {
          description: 'Missing user_id.',
          content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } },
        },
      },
    },
  },
  '/api/auth/webauthn/authenticate/verify': {
    post: {
      tags: ['PasswordlessAuth'],
      summary: 'Complete WebAuthn authentication',
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              required: ['challenge', 'credential_id', 'client_data_json', 'authenticator_data', 'signature', 'user_id'],
              properties: {
                challenge: { type: 'string' },
                credential_id: { type: 'string' },
                client_data_json: { type: 'string', description: 'base64url-encoded.' },
                authenticator_data: { type: 'string', description: 'base64url-encoded.' },
                signature: { type: 'string', description: 'base64url-encoded.' },
                sign_count: { type: 'integer', minimum: 0 },
                user_id: { type: 'string' },
              },
            },
          },
        },
      },
      responses: {
        '200': {
          description: 'Authentication successful.',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  success: { type: 'boolean' },
                  message: { type: 'string' },
                },
              },
            },
          },
        },
        '400': {
          description: 'Missing or invalid fields.',
          content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } },
        },
        '401': {
          description: 'Authentication verification failed.',
          content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } },
        },
      },
    },
  },
};
