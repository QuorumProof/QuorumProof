import type { PathsFragment } from './types.js';

export const graphqlPaths: PathsFragment = {
  '/api/graphql': {
    post: {
      tags: ['GraphQL'],
      summary: 'Execute a GraphQL-compatible batch query',
      description:
        'GraphQL-compatible endpoint for batch queries against Soroban contract state. ' +
        'Supported top-level fields: `credential(id)`, `credentials(ids)`, `slice(id)`, ' +
        '`credentialCount`, `attestorReputation(address)`. ' +
        'Returns `{ data, errors? }` in GraphQL response shape.',
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              required: ['query'],
              properties: {
                query: {
                  type: 'string',
                  description: 'GraphQL query string.',
                  example: '{ credential(id: "1") { id subject issuer } credentialCount }',
                },
                variables: {
                  type: 'object',
                  additionalProperties: true,
                  description: 'Optional query variables.',
                },
              },
            },
          },
        },
      },
      responses: {
        '200': {
          description: 'GraphQL response. Partial errors are represented inside the `errors` array.',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  data: { type: 'object', additionalProperties: true },
                  errors: {
                    type: 'array',
                    items: {
                      type: 'object',
                      properties: {
                        message: { type: 'string' },
                        path: { type: 'string' },
                      },
                    },
                  },
                },
              },
            },
          },
        },
        '400': {
          description: 'Invalid query.',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  errors: {
                    type: 'array',
                    items: { type: 'object', properties: { message: { type: 'string' } } },
                  },
                },
              },
            },
          },
        },
      },
    },
    get: {
      tags: ['GraphQL'],
      summary: 'GraphQL schema discovery',
      description: 'Returns endpoint information and supported top-level fields for discoverability.',
      responses: {
        '200': {
          description: 'Schema information.',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  endpoint: { type: 'string' },
                  description: { type: 'string' },
                  supported_fields: { type: 'array', items: { type: 'string' } },
                  example: { type: 'object', additionalProperties: true },
                },
              },
            },
          },
        },
      },
    },
  },
};
