import type { PathsFragment } from './types.js';

export const bridgePaths: PathsFragment = {
  '/api/bridge/chains': {
    get: {
      tags: ['Bridge'],
      summary: 'List supported cross-chain networks',
      description: 'Returns all foreign-chain networks the bridge currently supports.',
      responses: {
        '200': {
          description: 'Supported chains.',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  chains: { type: 'array', items: { type: 'object', additionalProperties: true } },
                },
              },
            },
          },
        },
      },
    },
  },
  '/api/bridge/headers': {
    post: {
      tags: ['Bridge'],
      summary: 'Checkpoint a finalised foreign-chain block header',
      description: 'Admin-only. Records a verified foreign-chain block header as a trust anchor for subsequent anchor verifications.',
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              required: ['chain_id', 'header', 'finality'],
              properties: {
                chain_id: { type: 'integer', description: 'EIP-155 chain ID.' },
                header: { type: 'object', additionalProperties: true, description: 'Raw eth_getBlockByNumber/eth_getBlockByHash result.' },
                finality: { type: 'object', additionalProperties: true, description: "Finality descriptor: {mode:'tag',tag} or {mode:'confirmations',head_block_number}." },
              },
            },
          },
        },
      },
      responses: {
        '201': { description: 'Header checkpointed.', content: { 'application/json': { schema: { type: 'object', additionalProperties: true } } } },
        '400': { description: 'Invalid input.', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
        '422': { description: 'Header verification failed.', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
      },
    },
  },
  '/api/bridge/anchors': {
    post: {
      tags: ['Bridge'],
      summary: 'Submit a foreign-chain event reference to anchor',
      description: 'Records an unauthenticated cross-chain anchor claim. Must be followed by POST /anchors/:id/verify to confirm it.',
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              required: ['credential_id', 'chain_id', 'tx_hash', 'block_number', 'block_hash', 'block_timestamp', 'contract_address', 'admin'],
              properties: {
                credential_id: { type: 'integer' },
                chain_id: { type: 'integer' },
                tx_hash: { type: 'string' },
                block_number: { type: 'integer' },
                block_hash: { type: 'string' },
                block_timestamp: { type: 'integer' },
                contract_address: { type: 'string' },
                proof_type: { type: 'integer', description: '1=Groth16, 2=PLONK, 3=HashOnly (default).' },
                admin: { type: 'string', description: 'Stellar admin address.' },
              },
            },
          },
        },
      },
      responses: {
        '201': { description: 'Anchor registered on-chain.', content: { 'application/json': { schema: { type: 'object', additionalProperties: true } } } },
        '202': { description: 'Anchor prepared but on-chain registration pending.', content: { 'application/json': { schema: { type: 'object', additionalProperties: true } } } },
        '400': { description: 'Missing or invalid fields.', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
        '403': { description: 'Unauthorized.', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
        '404': { description: 'Credential not found.', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
        '409': { description: 'Transaction already anchored.', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
      },
    },
    get: {
      tags: ['Bridge'],
      summary: 'List all confirmed anchors',
      description: 'Returns all cross-chain anchors recorded on this instance (up to 100 from on-chain, or all from durable store as fallback).',
      responses: {
        '200': {
          description: 'List of anchors.',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  total: { type: 'integer' },
                  anchors: { type: 'array', items: { type: 'object', additionalProperties: true } },
                },
              },
            },
          },
        },
      },
    },
  },
  '/api/bridge/anchors/pending': {
    get: {
      tags: ['Bridge'],
      summary: 'List pending anchors',
      description: 'Returns anchors that have been prepared but not yet confirmed on-chain.',
      responses: {
        '200': {
          description: 'Pending anchors.',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  total: { type: 'integer' },
                  anchors: { type: 'array', items: { type: 'object', additionalProperties: true } },
                },
              },
            },
          },
        },
      },
    },
  },
  '/api/bridge/anchors/{id}': {
    get: {
      tags: ['Bridge'],
      summary: 'Get anchor by ID',
      parameters: [
        { name: 'id', in: 'path', required: true, schema: { type: 'integer' }, description: 'On-chain anchor ID.' },
      ],
      responses: {
        '200': { description: 'Anchor record.', content: { 'application/json': { schema: { type: 'object', additionalProperties: true } } } },
        '400': { description: 'Invalid anchor ID.', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
        '404': { description: 'Anchor not found.', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
      },
    },
  },
  '/api/bridge/credentials/{id}/anchors': {
    get: {
      tags: ['Bridge'],
      summary: 'Get all anchors for a credential',
      parameters: [
        { name: 'id', in: 'path', required: true, schema: { type: 'integer' }, description: 'Credential ID.' },
      ],
      responses: {
        '200': {
          description: 'Anchors for the credential.',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  credential_id: { type: 'integer' },
                  anchors: { type: 'array', items: { type: 'object', additionalProperties: true } },
                },
              },
            },
          },
        },
        '400': { description: 'Invalid credential ID.', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
      },
    },
  },
  '/api/bridge/anchors/{id}/verify': {
    post: {
      tags: ['Bridge'],
      summary: 'Verify anchor via Merkle-Patricia receipt proof',
      description: 'Verifies the anchor against a checkpointed block header\'s receiptsRoot, then calls verify_chain_anchor on-chain.',
      parameters: [
        { name: 'id', in: 'path', required: true, schema: { type: 'integer' }, description: 'Anchor ID.' },
      ],
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              required: ['admin', 'log_index', 'receipt_proof'],
              properties: {
                admin: { type: 'string', description: 'Stellar admin address.' },
                log_index: { type: 'integer' },
                receipt_proof: { type: 'object', additionalProperties: true },
              },
            },
          },
        },
      },
      responses: {
        '200': { description: 'Verified.', content: { 'application/json': { schema: { type: 'object', additionalProperties: true } } } },
        '202': { description: 'Proof verified off-chain; on-chain update pending.', content: { 'application/json': { schema: { type: 'object', additionalProperties: true } } } },
        '400': { description: 'Invalid input.', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
        '403': { description: 'Unauthorized.', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
        '404': { description: 'Anchor not found.', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
        '422': { description: 'Proof verification failed.', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
      },
    },
  },
  '/api/bridge/light-client/bootstrap': {
    post: {
      tags: ['Bridge'],
      summary: 'Bootstrap the beacon-chain light client',
      description: 'Admin-only. Establishes the light client trust anchor from a weak-subjectivity checkpoint.',
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              required: ['chain_id', 'trusted_block_root', 'bootstrap'],
              properties: {
                chain_id: { type: 'integer' },
                trusted_block_root: { type: 'string', description: '0x-prefixed 32-byte beacon block root.' },
                bootstrap: { type: 'object', additionalProperties: true },
              },
            },
          },
        },
      },
      responses: {
        '201': { description: 'Light client bootstrapped.', content: { 'application/json': { schema: { type: 'object', properties: { success: { type: 'boolean' }, chain_id: { type: 'integer' } } } } } },
        '400': { description: 'Invalid input.', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
        '422': { description: 'Light client error.', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
      },
    },
  },
  '/api/bridge/light-client/update': {
    post: {
      tags: ['Bridge'],
      summary: 'Feed a sync-committee-signed update to the light client',
      description: 'Admin-only. Advances the finalized header when a supermajority BLS aggregate signature verifies.',
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              required: ['chain_id', 'update'],
              properties: {
                chain_id: { type: 'integer' },
                update: { type: 'object', additionalProperties: true },
              },
            },
          },
        },
      },
      responses: {
        '200': { description: 'Update applied.', content: { 'application/json': { schema: { type: 'object', additionalProperties: true } } } },
        '400': { description: 'Invalid input.', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
        '422': { description: 'Light client error.', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
      },
    },
  },
};
