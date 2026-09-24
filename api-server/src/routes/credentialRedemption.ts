import { Router, Request, Response } from 'express';
import { credentialRedemptionService } from '../services/credentialRedemption.js';

export function createCredentialRedemptionRouter() {
  const router = Router();

  // Get all rewards for a credential
  router.get('/:credentialId/rewards', async (req: Request, res: Response) => {
    try {
      const credentialId = parseInt(req.params.credentialId, 10);
      if (!Number.isInteger(credentialId) || credentialId <= 0) {
        res.status(400).json({ error: 'Invalid credential ID' });
        return;
      }

      const status = req.query.status as string | undefined;
      const rewards = await credentialRedemptionService.getCredentialRewards(credentialId, status);
      res.json(rewards);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: msg });
    }
  });

  // Get reward details
  router.get('/rewards/:rewardId', async (req: Request, res: Response) => {
    try {
      const reward = await credentialRedemptionService.getReward(req.params.rewardId);
      if (!reward) {
        res.status(404).json({ error: 'Reward not found' });
        return;
      }
      res.json(reward);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: msg });
    }
  });

  // Claim a reward (moves to escrow)
  router.post('/:credentialId/rewards/:rewardId/claim', async (req: Request, res: Response) => {
    try {
      const credentialId = parseInt(req.params.credentialId, 10);
      if (!Number.isInteger(credentialId) || credentialId <= 0) {
        res.status(400).json({ error: 'Invalid credential ID' });
        return;
      }

      const escrow = await credentialRedemptionService.claimReward(req.params.rewardId);
      res.json(escrow);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(400).json({ error: msg });
    }
  });

  // Get escrow entries for a credential
  router.get('/:credentialId/escrow', async (req: Request, res: Response) => {
    try {
      const credentialId = parseInt(req.params.credentialId, 10);
      if (!Number.isInteger(credentialId) || credentialId <= 0) {
        res.status(400).json({ error: 'Invalid credential ID' });
        return;
      }

      const status = req.query.status as string | undefined;
      const escrow = await credentialRedemptionService.getCredentialEscrow(credentialId, status);
      res.json(escrow);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: msg });
    }
  });

  // Settle escrow (release reward)
  router.post('/escrow/:escrowId/settle', async (req: Request, res: Response) => {
    try {
      const { settlementHash } = req.body as { settlementHash?: unknown };
      if (typeof settlementHash !== 'string' || !settlementHash) {
        res.status(400).json({ error: 'settlementHash is required' });
        return;
      }

      const escrow = await credentialRedemptionService.settleEscrow(req.params.escrowId, settlementHash);
      res.json(escrow);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(400).json({ error: msg });
    }
  });

  // Refund escrow (return reward to pending)
  router.post('/escrow/:escrowId/refund', async (req: Request, res: Response) => {
    try {
      const escrow = await credentialRedemptionService.refundEscrow(req.params.escrowId);
      res.json(escrow);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(400).json({ error: msg });
    }
  });

  // Get total rewards summary
  router.get('/:credentialId/rewards/summary', async (req: Request, res: Response) => {
    try {
      const credentialId = parseInt(req.params.credentialId, 10);
      if (!Number.isInteger(credentialId) || credentialId <= 0) {
        res.status(400).json({ error: 'Invalid credential ID' });
        return;
      }

      const summary = await credentialRedemptionService.getTotalRewardsByCredential(credentialId);
      res.json(summary);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: msg });
    }
  });

  // Get redemption history
  router.get('/:credentialId/redemption-history', async (req: Request, res: Response) => {
    try {
      const credentialId = parseInt(req.params.credentialId, 10);
      if (!Number.isInteger(credentialId) || credentialId <= 0) {
        res.status(400).json({ error: 'Invalid credential ID' });
        return;
      }

      const limit = Math.min(parseInt(req.query.limit as string) || 50, 500);
      const offset = parseInt(req.query.offset as string) || 0;

      const history = await credentialRedemptionService.getRedemptionHistory(credentialId, limit, offset);
      res.json(history);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: msg });
    }
  });

  return router;
}

export default createCredentialRedemptionRouter();
