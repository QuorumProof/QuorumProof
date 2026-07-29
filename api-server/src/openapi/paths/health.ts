import type { PathsFragment } from './types.js';

export const healthPaths: PathsFragment = {
  '/health': {
    get: {
      tags: ['Health'],
      summary: 'Overall health status',
      description: '200 when healthy or degraded, 503 when unhealthy.',
      responses: {
        '200': {
          description: 'Healthy or degraded.',
          content: { 'application/json': { schema: { $ref: '#/components/schemas/HealthStatus' } } },
        },
        '503': {
          description: 'Unhealthy.',
          content: { 'application/json': { schema: { $ref: '#/components/schemas/HealthStatus' } } },
        },
      },
    },
  },
  '/health/ready': {
    get: {
      tags: ['Health'],
      summary: 'Readiness probe',
      description: 'Returns 503 while dependencies (DB, RPC, etc.) are not yet ready to serve traffic.',
      responses: {
        '200': { description: 'Ready.' },
        '503': { description: 'Not ready.' },
      },
    },
  },
  '/health/live': {
    get: {
      tags: ['Health'],
      summary: 'Liveness probe',
      description: 'Always 200 while the process is running; used by orchestrators to detect a hung process.',
      responses: { '200': { description: 'Alive.' } },
    },
  },
};
