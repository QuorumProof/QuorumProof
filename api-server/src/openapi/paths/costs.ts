import type { PathsFragment } from './types.js';

export const costsPaths: PathsFragment = {
  '/api/costs/report': {
    get: {
      tags: ['Costs'],
      summary: 'Aggregated gas cost report',
      description: 'Returns aggregated gas cost data across all tracked on-chain operations.',
      responses: {
        '200': {
          description: 'Gas cost report.',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                additionalProperties: true,
              },
            },
          },
        },
      },
    },
  },
  '/api/costs/optimizations': {
    get: {
      tags: ['Costs'],
      summary: 'Ranked optimisation recommendations',
      description: 'Returns a ranked list of operations worth optimising, ordered by estimated savings.',
      parameters: [
        {
          name: 'top',
          in: 'query',
          description: 'Number of top recommendations to return (default 5).',
          schema: { type: 'integer', minimum: 1, default: 5 },
        },
      ],
      responses: {
        '200': {
          description: 'Optimisation recommendations.',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  recommendations: { type: 'array', items: { type: 'object', additionalProperties: true } },
                },
              },
            },
          },
        },
      },
    },
  },
  '/api/costs/projection': {
    get: {
      tags: ['Costs'],
      summary: 'Project future gas costs for an operation',
      description: 'Estimates future gas costs for a given operation based on call frequency and duration.',
      parameters: [
        { name: 'operation', in: 'query', required: true, schema: { type: 'string' }, description: 'Operation name to project.' },
        { name: 'callsPerDay', in: 'query', required: true, schema: { type: 'number' }, description: 'Estimated calls per day.' },
        { name: 'days', in: 'query', schema: { type: 'number', default: 30 }, description: 'Projection horizon in days (default 30).' },
      ],
      responses: {
        '200': {
          description: 'Cost projection result.',
          content: { 'application/json': { schema: { type: 'object', additionalProperties: true } } },
        },
        '400': {
          description: 'Missing or invalid parameters.',
          content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } },
        },
        '404': {
          description: 'No recorded cost data for the given operation.',
          content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } },
        },
      },
    },
  },
};
