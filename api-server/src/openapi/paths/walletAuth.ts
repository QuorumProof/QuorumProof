import type { PathsFragment } from './types.js';

export const walletAuthPaths: PathsFragment = {
  '/api/auth/wallet/link': {
    post: {
      tags: ['Auth'],
      summary: 'Link a Stellar wallet to the authenticated account',
      description:
        'Requires a signature by the Stellar address over the exact UTF-8 message ' +
        '`QuorumProof Wallet Link\\nuser_id:<authenticated user id>\\naddress:<stellar address>`.',
      security: [{ bearerAuth: [] }],
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              required: ['stellarAddress', 'signature'],
              properties: {
                stellarAddress: { type: 'string', description: 'Stellar Ed25519 public address.' },
                signature: { type: 'string', pattern: '^[0-9a-fA-F]{128}$', description: 'Hex-encoded Ed25519 signature.' },
              },
            },
          },
        },
      },
      responses: {
        '200': { description: 'The same wallet was already linked.' },
        '201': { description: 'Wallet linked.' },
        '400': { description: 'Invalid address or signature format.' },
        '401': { description: 'Authentication or wallet signature failed.' },
        '409': { description: 'A different wallet is already linked to this account.' },
      },
    },
  },
};
