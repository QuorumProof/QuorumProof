import { Router, Request, Response } from 'express';
import { credentialTieringService } from '../services/credentialTiering.js';

export function createCredentialTieringRouter() {
  const router = Router();

  // Get or create tier for a credential
  router.get('/:credentialId/tier', async (req: Request, res: Response) => {
    try {
      const credentialId = parseInt(req.params.credentialId, 10);
      if (!Number.isInteger(credentialId) || credentialId <= 0) {
        res.status(400).json({ error: 'Invalid credential ID' });
        return;
      }

      const tier = await credentialTieringService.getOrCreateTier(credentialId);
      res.json(tier);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: msg });
    }
  });

  // Get credentials by tier
  router.get('/tier/:tier', async (req: Request, res: Response) => {
    try {
      const tier = req.params.tier as 'bronze' | 'silver' | 'gold';
      if (!['bronze', 'silver', 'gold'].includes(tier)) {
        res.status(400).json({ error: 'Invalid tier' });
        return;
      }

      const limit = Math.min(parseInt(req.query.limit as string) || 100, 1000);
      const offset = parseInt(req.query.offset as string) || 0;

      const credentials = await credentialTieringService.getTiersByTier(tier, limit, offset);
      res.json(credentials);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: msg });
    }
  });

  // Get tier statistics
  router.get('/stats', async (req: Request, res: Response) => {
    try {
      const stats = await credentialTieringService.getTierStats();
      res.json(stats);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: msg });
    }
  });

  // Update reputation score
  router.post('/:credentialId/reputation', async (req: Request, res: Response) => {
    try {
      const credentialId = parseInt(req.params.credentialId, 10);
      const { scoreIncrement } = req.body as { scoreIncrement?: unknown };

      if (!Number.isInteger(credentialId) || credentialId <= 0) {
        res.status(400).json({ error: 'Invalid credential ID' });
        return;
      }

      if (typeof scoreIncrement !== 'number') {
        res.status(400).json({ error: 'scoreIncrement must be a number' });
        return;
      }

      const updated = await credentialTieringService.updateReputationScore(credentialId, scoreIncrement);
      res.json(updated);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: msg });
    }
  });

  // Check and promote tier if eligible
  router.post('/:credentialId/check-promotion', async (req: Request, res: Response) => {
    try {
      const credentialId = parseInt(req.params.credentialId, 10);
      if (!Number.isInteger(credentialId) || credentialId <= 0) {
        res.status(400).json({ error: 'Invalid credential ID' });
        return;
      }

      const tier = await credentialTieringService.checkAndPromoteTier(credentialId);
      if (!tier) {
        res.status(404).json({ error: 'Credential tier not found' });
        return;
      }
      res.json(tier);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: msg });
    }
  });

  return router;
}

export default createCredentialTieringRouter();
