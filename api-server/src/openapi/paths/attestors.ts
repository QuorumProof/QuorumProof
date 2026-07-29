import type { PathsFragment } from './types.js';

export const attestorsPaths: PathsFragment = {
  '/api/attestors': {
    get: {
      tags: ['Attestors'],
      summary: 'List / filter the attestor directory',
      parameters: [
        { name: 'type', in: 'query', schema: { type: 'string' }, description: 'Exact match on attestor type.' },
        { name: 'region', in: 'query', schema: { type: 'string' }, description: 'Case-insensitive exact match.' },
        { name: 'q', in: 'query', schema: { type: 'string' }, description: 'Substring search across name, region, description.' },
        { name: 'active', in: 'query', schema: { type: 'boolean' } },
      ],
      responses: {
        '200': {
          description: 'Matching attestors.',
          content: {
            'application/json': {
              schema: { type: 'object', properties: { total: { type: 'integer' }, attestors: { type: 'array', items: { $ref: '#/components/schemas/AttestorStatus' } } } },
            },
          },
        },
      },
    },
  },
  '/api/attestors/{id}': {
    get: {
      tags: ['Attestors'],
      summary: 'Get a single attestor record with credential stats',
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
      responses: {
        '200': { description: 'The attestor.', content: { 'application/json': { schema: { $ref: '#/components/schemas/AttestorStatus' } } } },
        '404': { description: 'Unknown attestor id.', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
      },
    },
  },
  '/api/attestors/{id}/status': {
    get: {
      tags: ['Attestors'],
      summary: 'Get live availability metrics for an attestor',
      description: 'uptime_ratio and avg_response_ms are derived from the last 24h of recorded pings.',
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
      responses: {
        '200': {
          description: 'Availability status.',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  uptime_ratio: { type: ['number', 'null'] },
                  avg_response_ms: { type: ['number', 'null'] },
                  active_credential_count: { type: 'integer' },
                  last_seen: { type: ['string', 'null'], format: 'date-time' },
                  availability: { type: 'string', enum: ['excellent', 'good', 'degraded', 'offline', 'unknown'] },
                },
              },
            },
          },
        },
        '404': { description: 'Unknown attestor id.', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
      },
    },
  },
  '/api/attestors/{id}/status/ping': {
    post: {
      tags: ['Attestors'],
      summary: 'Record a heartbeat ping result for an attestor',
      description: 'Called by the monitoring agent or the attestor node itself after each health-check probe.',
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              properties: { ok: { type: 'boolean' }, response_ms: { type: 'number', minimum: 0 } },
              required: ['ok', 'response_ms'],
            },
          },
        },
      },
      responses: {
        '204': { description: 'Recorded.' },
        '400': { description: 'Invalid body.', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
        '404': { description: 'Unknown attestor id.', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
      },
    },
  },
  '/api/attestor/pending': {
    get: {
      tags: ['Attestors'],
      summary: 'Get the pending attestation queue for an address',
      parameters: [{ name: 'address', in: 'query', required: true, schema: { type: 'string' } }],
      responses: {
        '200': { description: 'Pending queue.', content: { 'application/json': { schema: { type: 'object', properties: { address: { type: 'string' }, items: { type: 'array', items: {} }, total: { type: 'integer' } } } } } },
        '400': { description: 'Missing address.', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
      },
    },
  },
  '/api/attestor/reputation/{address}': {
    get: {
      tags: ['Attestors'],
      summary: 'Get on-chain + derived reputation stats for an attestor address',
      parameters: [{ name: 'address', in: 'path', required: true, schema: { type: 'string' } }],
      responses: {
        '200': {
          description: 'Reputation snapshot (30-day window).',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  address: { type: 'string' },
                  attestation_count_score: { type: 'number' },
                  reputation: { type: ['object', 'null'], additionalProperties: true },
                  attestation_count: { type: 'integer' },
                  total_activity: { type: 'integer' },
                  success_rate: { type: ['number', 'null'] },
                  period_days: { type: 'integer' },
                },
              },
            },
          },
        },
      },
    },
  },
  '/api/attestor/batch-attest': {
    post: {
      tags: ['Attestors'],
      summary: 'Attest a batch of credentials against a slice',
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              properties: {
                attestor: { type: 'string' },
                credential_ids: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 50 },
                slice_id: { type: 'string' },
              },
              required: ['attestor', 'credential_ids', 'slice_id'],
            },
          },
        },
      },
      responses: {
        '200': {
          description: 'Per-credential attestation results.',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  total: { type: 'integer' },
                  succeeded: { type: 'integer' },
                  failed: { type: 'integer' },
                  results: {
                    type: 'array',
                    items: { type: 'object', properties: { credential_id: { type: 'string' }, success: { type: 'boolean' }, error: { type: 'string' } } },
                  },
                },
              },
            },
          },
        },
        '400': { description: 'Missing/invalid fields, or batch too large.', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
      },
    },
  },
};
