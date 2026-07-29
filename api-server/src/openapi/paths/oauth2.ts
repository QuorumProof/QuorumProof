import type { PathsFragment } from './types.js';

export const oauth2Paths: PathsFragment = {
  '/auth/oauth2/{provider}/authorize': {
    get: {
      tags: ['OAuth2'],
      summary: "Build the provider's consent-screen URL",
      parameters: [{ name: 'provider', in: 'path', required: true, schema: { type: 'string', enum: ['google', 'microsoft', 'github'] } }],
      responses: {
        '200': {
          description: 'Authorization URL and state.',
          content: { 'application/json': { schema: { type: 'object', properties: { provider: { type: 'string' }, url: { type: 'string', format: 'uri' }, state: { type: 'string' } } } } },
        },
        '400': { description: 'Unsupported provider.', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
      },
    },
  },
  '/auth/oauth2/callback': {
    post: {
      tags: ['OAuth2'],
      summary: 'Exchange an auth code and link the identity to a Stellar address',
      description:
        '`signature` must be an ed25519 signature (by `stellarAddress`) over the canonical ' +
        'link message, proving control of the address before it is linked to the OAuth2 identity.',
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              properties: {
                provider: { type: 'string', enum: ['google', 'microsoft', 'github'] },
                code: { type: 'string' },
                stellarAddress: { type: 'string' },
                signature: { type: 'string', description: 'Hex-encoded 64-byte ed25519 signature.' },
              },
              required: ['provider', 'code', 'stellarAddress', 'signature'],
            },
          },
        },
      },
      responses: {
        '200': { description: 'Identity linked.', content: { 'application/json': { schema: { type: 'object', additionalProperties: true } } } },
        '400': { description: 'Missing/invalid field.', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
        '401': { description: 'OAuth2 exchange failed, or signature invalid.', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
      },
    },
  },
  '/auth/oauth2/identities/{stellarAddress}': {
    get: {
      tags: ['OAuth2'],
      summary: 'List OAuth2 identities linked to a Stellar address',
      parameters: [{ name: 'stellarAddress', in: 'path', required: true, schema: { type: 'string' } }],
      responses: {
        '200': { description: 'Linked identities.', content: { 'application/json': { schema: { type: 'object', properties: { data: { type: 'array', items: { type: 'object', additionalProperties: true } } } } } } },
      },
    },
  },
};
