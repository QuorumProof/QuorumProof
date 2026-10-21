import { Router, Request, Response } from 'express';
import { Keypair, StrKey } from '@stellar/stellar-sdk';
import { requireAuth } from '../middleware/auth.js';
import { getDefaultUserWalletStore } from '../services/userWalletStore.js';

const router = Router();
const WALLET_LINK_SIGNATURE = /^[0-9a-fA-F]{128}$/;

export function buildWalletLinkMessage(userId: string, stellarAddress: string): string {
  return `QuorumProof Wallet Link\nuser_id:${userId}\naddress:${stellarAddress}`;
}

router.post('/', requireAuth, (req: Request, res: Response) => {
  const { stellarAddress, signature } = req.body as {
    stellarAddress?: unknown;
    signature?: unknown;
  };

  if (typeof stellarAddress !== 'string' || !StrKey.isValidEd25519PublicKey(stellarAddress)) {
    res.status(400).json({ error: 'stellarAddress must be a valid Stellar public key' });
    return;
  }
  if (typeof signature !== 'string' || !WALLET_LINK_SIGNATURE.test(signature)) {
    res.status(400).json({ error: 'signature must be a 64-byte hex Stellar signature' });
    return;
  }

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
});

export default router;
