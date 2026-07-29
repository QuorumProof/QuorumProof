import type { PathsFragment } from './types.js';

export const slicesPaths: PathsFragment = {
  '/api/slices': {
    get: {
      tags: ['Slices'],
      summary: 'List quorum slices (cursor-paginated)',
      parameters: [
        { name: 'cursor', in: 'query', schema: { type: 'string' }, description: 'Opaque base64 cursor from a previous response.' },
        { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 100, default: 20 } },
      ],
      responses: {
        '200': {
          description: 'Paginated list of slices.',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  data: { type: 'array', items: { $ref: '#/components/schemas/Slice' } },
                  pagination: { $ref: '#/components/schemas/Pagination' },
                },
              },
            },
          },
        },
        '400': { description: 'Invalid cursor.', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
      },
    },
  },
  '/api/slices/{id}': {
    get: {
      tags: ['Slices'],
      summary: 'Get a quorum slice by id',
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer', minimum: 1 } }],
      responses: {
        '200': { description: 'The slice.', content: { 'application/json': { schema: { $ref: '#/components/schemas/Slice' } } } },
        '404': { description: 'Slice not found.', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
      },
    },
  },
};
