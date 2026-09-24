import { Router, Request, Response } from 'express';
import { credentialRedemptionService } from '../services/credentialRedemption.js';

export function createCredentialRedemptionRouter() {
  const router = Router();

  // Get all rewards for a credential
  router.get('/:credentialId/rewards', async (req: Request, res: Response) => {
    try {
      const credentialId = parseInt(req.params.credentialId as string, 10);
      if (!Number.isInteger(credentialId) || credentialId <= 0) {
        res.status(400).json({ error: 'Invalid credential ID' });
        return;
      }

      let status: string | undefined;
      const statusVal = req.query.status;
      if (typeof statusVal === 'string') {
        status = statusVal;
      } else if (Array.isArray(statusVal)) {
        status = String(statusVal[0]);
      }
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
      const rewardId = Array.isArray(req.params.rewardId) ? req.params.rewardId[0] : (req.params.rewardId as string);
      const reward = await credentialRedemptionService.getReward(rewardId);
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
      const credentialId = parseInt(req.params.credentialId as string, 10);
      if (!Number.isInteger(credentialId) || credentialId <= 0) {
        res.status(400).json({ error: 'Invalid credential ID' });
        return;
      }

      const rewardId = Array.isArray(req.params.rewardId) ? req.params.rewardId[0] : (req.params.rewardId as string);
      const escrow = await credentialRedemptionService.claimReward(rewardId);
      res.json(escrow);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(400).json({ error: msg });
    }
  });

  // Get escrow entries for a credential
  router.get('/:credentialId/escrow', async (req: Request, res: Response) => {
    try {
      const credentialId = parseInt(req.params.credentialId as string, 10);
      if (!Number.isInteger(credentialId) || credentialId <= 0) {
        res.status(400).json({ error: 'Invalid credential ID' });
        return;
      }

      let status: string | undefined;
      const statusVal = req.query.status;
      if (typeof statusVal === 'string') {
        status = statusVal;
      } else if (Array.isArray(statusVal)) {
        status = String(statusVal[0]);
      }
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

      const escrowId = Array.isArray(req.params.escrowId) ? req.params.escrowId[0] : (req.params.escrowId as string);
      const escrow = await credentialRedemptionService.settleEscrow(escrowId, settlementHash);
      res.json(escrow);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(400).json({ error: msg });
    }
  });

  // Refund escrow (return reward to pending)
  router.post('/escrow/:escrowId/refund', async (req: Request, res: Response) => {
    try {
      const escrowId = Array.isArray(req.params.escrowId) ? req.params.escrowId[0] : (req.params.escrowId as string);
      const escrow = await credentialRedemptionService.refundEscrow(escrowId);
      res.json(escrow);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(400).json({ error: msg });
    }
  });

  // Get total rewards summary
  router.get('/:credentialId/rewards/summary', async (req: Request, res: Response) => {
    try {
      const credentialId = parseInt(req.params.credentialId as string, 10);
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
      const credentialId = parseInt(req.params.credentialId as string, 10);
      if (!Number.isInteger(credentialId) || credentialId <= 0) {
        res.status(400).json({ error: 'Invalid credential ID' });
        return;
      }

      let limitStr = '50';
      const limitVal = req.query.limit;
      if (typeof limitVal === 'string') {
        limitStr = limitVal;
      } else if (Array.isArray(limitVal)) {
        limitStr = String(limitVal[0]);
      }

      let offsetStr = '0';
      const offsetVal = req.query.offset;
      if (typeof offsetVal === 'string') {
        offsetStr = offsetVal;
      } else if (Array.isArray(offsetVal)) {
        offsetStr = String(offsetVal[0]);
      }

      const limit = Math.min(parseInt(limitStr || '50') || 50, 500);
      const offset = parseInt(offsetStr || '0') || 0;

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
