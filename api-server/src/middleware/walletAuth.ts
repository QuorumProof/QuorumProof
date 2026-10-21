import type { Request, RequestHandler } from 'express';
import { getDefaultUserWalletStore } from '../services/userWalletStore.js';

export function requireLinkedWallet(getClaimedAddress: (req: Request) => unknown): RequestHandler {
  return (req, res, next) => {
    const userId = req.auth?.sub;
    if (!userId) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }

    const claimedAddress = getClaimedAddress(req);
    if (typeof claimedAddress !== 'string' || !claimedAddress) {
      next();
      return;
    }

    const wallet = getDefaultUserWalletStore().getWallet(userId);
    if (!wallet) {
      res.status(403).json({ error: 'Link a Stellar wallet to your account before performing holder actions' });
      return;
    }
    if (claimedAddress !== wallet.stellarAddress) {
      res.status(403).json({ error: 'The supplied Stellar address does not match the authenticated account wallet' });
      return;
    }

    next();
  };
}
