import type { PathsFragment } from './types.js';

const prometheusText = {
  '200': {
    description: 'Prometheus text-exposition format (version 0.0.4).',
    content: { 'text/plain': { schema: { type: 'string' as const } } },
  },
};

export const metricsPaths: PathsFragment = {
  '/ws/metrics': {
    get: {
      tags: ['Metrics'],
      summary: 'Get WebSocket connection/subscription metrics (JSON)',
      responses: { '200': { description: 'Metrics.', content: { 'application/json': { schema: { type: 'object', additionalProperties: true } } } } },
    },
  },
  '/metrics/ws': {
    get: {
      tags: ['Metrics'],
      summary: 'WebSocket metrics in Prometheus format',
      description: 'Tagged with this instance id; scrape every replica and aggregate for cluster-wide totals.',
      responses: prometheusText,
    },
  },
  '/metrics/rpc': {
    get: {
      tags: ['Metrics'],
      summary: 'Soroban RPC circuit-breaker metrics in Prometheus format',
      responses: prometheusText,
    },
  },
  '/rpc/circuit-breaker': {
    get: {
      tags: ['Metrics'],
      summary: 'Soroban RPC circuit-breaker state (JSON)',
      responses: { '200': { description: 'Circuit breaker state.', content: { 'application/json': { schema: { type: 'object', additionalProperties: true } } } } },
    },
  },
  '/metrics/events': {
    get: {
      tags: ['Metrics'],
      summary: 'Critical on-chain event monitoring metrics in Prometheus format',
      responses: prometheusText,
    },
  },
  '/events/critical/recent': {
    get: {
      tags: ['Metrics'],
      summary: 'Recent critical on-chain events and their metrics (JSON)',
      responses: {
        '200': {
          description: 'Recent events.',
          content: { 'application/json': { schema: { type: 'object', properties: { metrics: { type: 'object', additionalProperties: true }, events: { type: 'array', items: { type: 'object', additionalProperties: true } } } } } },
        },
      },
    },
  },
};
