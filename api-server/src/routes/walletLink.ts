import { Router, Request, Response } from 'express';
import { Keypair, StrKey } from '@stellar/stellar-sdk';
import { requireAuth } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { getDefaultUserWalletStore } from '../services/userWalletStore.js';

const router = Router();

const walletLinkBodySchema = {
  type: 'object',
  properties: {
    stellarAddress: { type: 'string', pattern: '^G[A-Z2-7]{55}$' },
    signature: { type: 'string', pattern: '^[0-9a-fA-F]{128}$' },
  },
  required: ['stellarAddress', 'signature'],
  additionalProperties: false,
};

export function buildWalletLinkMessage(userId: string, stellarAddress: string): string {
  return `QuorumProof Wallet Link\nuser_id:${userId}\naddress:${stellarAddress}`;
}

router.post(
  '/',
  requireAuth,
  validate(
    {
      body: {
        schema: walletLinkBodySchema,
        custom: (data) => {
          const { stellarAddress } = data as { stellarAddress: string };
          if (!StrKey.isValidEd25519PublicKey(stellarAddress)) {
            return 'stellarAddress must be a valid Stellar public key';
          }
          return true;
        },
      },
    },
    { coerceTypes: false },
  ),
  (req: Request, res: Response) => {
    const { stellarAddress, signature } = req.body as {
      stellarAddress: string;
      signature: string;
    };

    const message = Buffer.from(buildWalletLinkMessage(req.auth!.sub, stellarAddress), 'utf8');
    let validSignature = false;
    try {
      validSignature = Keypair.fromPublicKey(stellarAddress).verify(message, Buffer.from(signature, 'hex'));
    } catch {
      validSignature = false;
    }

    if (!validSignature) {
      res.status(401).json({ error: 'Invalid wallet signature' });
      return;
    }

    const result = getDefaultUserWalletStore().link(req.auth!.sub, stellarAddress);
    if (result === 'conflict') {
      res.status(409).json({ error: 'A different Stellar wallet is already linked to this account' });
      return;
    }

    res.status(result === 'linked' ? 201 : 200).json({
      userId: req.auth!.sub,
      stellarAddress,
      linked: true,
    });
  },
);

export default router;
