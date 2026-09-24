import { Router, Request, Response } from 'express';
import { getPool } from '../db.js';
import {
  publishTierAdvancedEvent,
  publishTierPointsAccruedEvent,
} from '../services/tierRedemptionEvents.js';

export type CredentialTier = 'bronze' | 'silver' | 'gold';

interface TierInfo {
  credential_id: number;
  tier: CredentialTier;
  tier_points: number;
  tier_acquired_at: string;
  benefits: Record<string, string>;
}

interface TierRequirements {
  tier: CredentialTier;
  min_points: number;
  min_attestations: number;
  min_age_days: number;
}

export function createCredentialTiersRouter() {
  const router = Router();

  /**
   * GET /api/credentials/:id/tier
   * Get the tier information for a credential
   */
  router.get('/:id/tier', async (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      const pool = getPool();

      const tierResult = await pool.query(
        `SELECT credential_id, tier, tier_points, tier_acquired_at
         FROM credential_tiers WHERE credential_id = $1`,
        [id]
      );

      if (tierResult.rows.length === 0) {
        res.status(404).json({ error: 'Credential tier not found' });
        return;
      }

      const tierRow = tierResult.rows[0];

      // Get tier benefits
      const benefitsResult = await pool.query(
        `SELECT benefit_name, benefit_value FROM tier_benefits WHERE tier = $1`,
        [tierRow.tier]
      );

      const benefits: Record<string, string> = {};
      for (const benefit of benefitsResult.rows) {
        benefits[benefit.benefit_name] = benefit.benefit_value;
      }

      const tierInfo: TierInfo = {
        credential_id: parseInt(id, 10),
        tier: tierRow.tier,
        tier_points: tierRow.tier_points,
        tier_acquired_at: tierRow.tier_acquired_at,
        benefits,
      };

      res.json(tierInfo);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: msg });
    }
  });

  /**
   * POST /api/credentials/:id/tier/advance
   * Attempt to advance a credential to the next tier
   */
  router.post('/:id/tier/advance', async (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      const pool = getPool();

      // Get current tier
      const currentResult = await pool.query(
        `SELECT tier, tier_points FROM credential_tiers WHERE credential_id = $1`,
        [id]
      );

      if (currentResult.rows.length === 0) {
        res.status(404).json({ error: 'Credential not found' });
        return;
      }

      const current = currentResult.rows[0];
      const currentTier = current.tier as CredentialTier;
      const points = current.tier_points;

      // Determine next tier
      const tierOrder: CredentialTier[] = ['bronze', 'silver', 'gold'];
      const currentIndex = tierOrder.indexOf(currentTier);

      if (currentIndex === -1 || currentIndex === tierOrder.length - 1) {
        res.status(400).json({ error: 'Already at maximum tier or invalid tier' });
        return;
      }

      const nextTier = tierOrder[currentIndex + 1];

      // Check if requirements are met
      const requirementsResult = await pool.query(
        `SELECT min_points, min_attestations, min_age_days FROM tier_requirements WHERE tier = $1`,
        [nextTier]
      );

      if (requirementsResult.rows.length === 0) {
        res.status(500).json({ error: 'Tier requirements not found' });
        return;
      }

      const requirements = requirementsResult.rows[0] as TierRequirements;

      if (points < requirements.min_points) {
        res.status(400).json({
          error: `Insufficient tier points. Need ${requirements.min_points}, have ${points}`,
        });
        return;
      }

      // Update tier
      const client = await pool.connect();
      try {
        await client.query('BEGIN');

        await client.query(
          `UPDATE credential_tiers
           SET tier = $1, tier_updated_at = now()
           WHERE credential_id = $2`,
          [nextTier, id]
        );

        // Log tier advancement
        await client.query(
          `INSERT INTO tier_advancement_log (credential_id, from_tier, to_tier, reason)
           VALUES ($1, $2, $3, $4)`,
          [id, currentTier, nextTier, 'Automatic advancement based on points']
        );

        await client.query('COMMIT');

        // Publish tier advancement event for real-time notifications
        publishTierAdvancedEvent(parseInt(id, 10), currentTier, nextTier, points);

        res.json({
          credential_id: id,
          from_tier: currentTier,
          to_tier: nextTier,
          advanced_at: new Date().toISOString(),
        });
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: msg });
    }
  });

  /**
   * POST /api/credentials/:id/tier/points
   * Add tier points to a credential
   */
  router.post('/:id/tier/points', async (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      const { points, reason } = req.body as { points?: number; reason?: string };

      if (!points || points <= 0) {
        res.status(400).json({ error: 'Points must be a positive number' });
        return;
      }

      const pool = getPool();

      const result = await pool.query(
        `UPDATE credential_tiers
         SET tier_points = tier_points + $1, tier_updated_at = now()
         WHERE credential_id = $2
         RETURNING credential_id, tier, tier_points`,
        [points, id]
      );

      if (result.rows.length === 0) {
        res.status(404).json({ error: 'Credential not found' });
        return;
      }

      const row = result.rows[0];

      // Publish tier points accrued event for real-time notifications
      publishTierPointsAccruedEvent(
        row.credential_id,
        points,
        row.tier,
        row.tier_points
      );

      res.json({
        credential_id: row.credential_id,
        tier: row.tier,
        tier_points: row.tier_points,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: msg });
    }
  });

  /**
   * GET /api/tiers/requirements
   * Get tier advancement requirements
   */
  router.get('/tiers/requirements', async (req: Request, res: Response) => {
    try {
      const pool = getPool();
      const result = await pool.query(
        `SELECT tier, min_points, min_attestations, min_age_days
         FROM tier_requirements ORDER BY min_points ASC`
      );

      res.json(result.rows);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: msg });
    }
  });

  /**
   * GET /api/credentials/:id/tier/history
   * Get tier advancement history for a credential
   */
  router.get('/:id/tier/history', async (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      const pool = getPool();

      const result = await pool.query(
        `SELECT credential_id, from_tier, to_tier, reason, advanced_at
         FROM tier_advancement_log WHERE credential_id = $1
         ORDER BY advanced_at DESC`,
        [id]
      );

      res.json(result.rows);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: msg });
    }
  });

  return router;
}

export default createCredentialTiersRouter();
