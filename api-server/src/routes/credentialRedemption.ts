import { Router, Request, Response } from 'express';
import { getPool } from '../db.js';
import {
  publishRedemptionRequestedEvent,
  publishRedemptionClaimedEvent,
} from '../services/tierRedemptionEvents.js';

type RedemptionStatus = 'pending' | 'approved' | 'claimed' | 'expired' | 'cancelled';

interface RewardInfo {
  credential_id: number;
  reward_points: number;
  accumulated_value: string;
}

interface RedemptionRequest {
  id: number;
  credential_id: number;
  amount: string;
  destination_address: string;
  status: RedemptionStatus;
  submitted_at: string;
  processed_at?: string;
}

export function createCredentialRedemptionRouter() {
  const router = Router();

  /**
   * GET /api/credentials/:id/rewards
   * Get reward balance for a credential
   */
  router.get('/:id/rewards', async (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      const pool = getPool();

      const result = await pool.query(
        `SELECT credential_id, reward_points, accumulated_value
         FROM credential_rewards WHERE credential_id = $1`,
        [id]
      );

      if (result.rows.length === 0) {
        res.status(404).json({ error: 'Reward account not found' });
        return;
      }

      const row = result.rows[0];
      const rewardInfo: RewardInfo = {
        credential_id: row.credential_id,
        reward_points: row.reward_points,
        accumulated_value: row.accumulated_value,
      };

      res.json(rewardInfo);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: msg });
    }
  });

  /**
   * POST /api/credentials/:id/rewards/accrue
   * Accrue rewards to a credential
   */
  router.post('/:id/rewards/accrue', async (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      const { points, value } = req.body as { points?: number; value?: string };

      if (!points || points <= 0) {
        res.status(400).json({ error: 'Points must be a positive number' });
        return;
      }

      const valueAmount = value ? parseFloat(value) : 0;
      const pool = getPool();

      const result = await pool.query(
        `UPDATE credential_rewards
         SET reward_points = reward_points + $1,
             accumulated_value = accumulated_value + $2
         WHERE credential_id = $3
         RETURNING credential_id, reward_points, accumulated_value`,
        [points, valueAmount, id]
      );

      if (result.rows.length === 0) {
        res.status(404).json({ error: 'Credential not found' });
        return;
      }

      const row = result.rows[0];
      res.json({
        credential_id: row.credential_id,
        reward_points: row.reward_points,
        accumulated_value: row.accumulated_value,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: msg });
    }
  });

  /**
   * POST /api/credentials/:id/redemptions
   * Submit a redemption request
   */
  router.post('/:id/redemptions', async (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      const { amount, destination_address, reason } = req.body as {
        amount?: string;
        destination_address?: string;
        reason?: string;
      };

      if (!amount || !destination_address) {
        res.status(400).json({
          error: 'amount and destination_address are required',
        });
        return;
      }

      const amountValue = parseFloat(amount);
      if (isNaN(amountValue) || amountValue <= 0) {
        res.status(400).json({ error: 'amount must be a positive number' });
        return;
      }

      const pool = getPool();

      // Check available rewards
      const rewardResult = await pool.query(
        `SELECT accumulated_value FROM credential_rewards WHERE credential_id = $1`,
        [id]
      );

      if (rewardResult.rows.length === 0) {
        res.status(404).json({ error: 'Credential not found' });
        return;
      }

      const availableValue = parseFloat(rewardResult.rows[0].accumulated_value);
      if (amountValue > availableValue) {
        res.status(400).json({
          error: `Insufficient reward balance. Available: ${availableValue}, Requested: ${amountValue}`,
        });
        return;
      }

      const client = await pool.connect();
      try {
        await client.query('BEGIN');

        // Create escrow
        const expiresAt = new Date();
        expiresAt.setDate(expiresAt.getDate() + 30); // 30-day expiration

        const escrowResult = await client.query(
          `INSERT INTO reward_escrow (credential_id, amount, escrow_status, expires_at)
           VALUES ($1, $2, 'pending', $3)
           RETURNING id`,
          [id, amountValue, expiresAt.toISOString()]
        );

        const escrowId = escrowResult.rows[0].id;

        // Create redemption request
        const redemptionResult = await client.query(
          `INSERT INTO redemption_requests
           (credential_id, reward_escrow_id, amount, destination_address, status, reason)
           VALUES ($1, $2, $3, $4, 'pending', $5)
           RETURNING id, credential_id, amount, destination_address, status, submitted_at`,
          [id, escrowId, amountValue, destination_address, reason || 'Manual redemption request']
        );

        // Update reward balance
        await client.query(
          `UPDATE credential_rewards
           SET accumulated_value = accumulated_value - $1
           WHERE credential_id = $2`,
          [amountValue, id]
        );

        // Create ledger entry
        await client.query(
          `INSERT INTO redemption_ledger
           (credential_id, redemption_request_id, debit, balance, transaction_type, description)
           SELECT $1, $2, $3, accumulated_value, 'redemption_request', $4
           FROM credential_rewards WHERE credential_id = $1`,
          [id, redemptionResult.rows[0].id, amountValue, `Redemption to ${destination_address}`]
        );

        await client.query('COMMIT');

        const redempReq = redemptionResult.rows[0];
        const redemptionReq: RedemptionRequest = {
          id: redempReq.id,
          credential_id: redempReq.credential_id,
          amount: redempReq.amount,
          destination_address: redempReq.destination_address,
          status: redempReq.status,
          submitted_at: redempReq.submitted_at,
        };

        // Publish redemption requested event for real-time notifications
        publishRedemptionRequestedEvent(
          parseInt(id, 10),
          redempReq.id,
          redempReq.amount,
          destination_address
        );

        res.status(201).json(redemptionReq);
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
   * GET /api/credentials/:id/redemptions
   * Get redemption history for a credential
   */
  router.get('/:id/redemptions', async (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      const { status: statusFilter, limit = '50' } = req.query;

      const pool = getPool();
      const limitNum = Math.min(parseInt(String(limit), 10), 100);

      let query =
        `SELECT id, credential_id, amount, destination_address, status, submitted_at, processed_at
         FROM redemption_requests WHERE credential_id = $1`;
      const params: any[] = [id];

      if (statusFilter) {
        query += ` AND status = $2`;
        params.push(statusFilter);
      }

      query += ` ORDER BY submitted_at DESC LIMIT $${params.length + 1}`;
      params.push(limitNum);

      const result = await pool.query(query, params);

      res.json(result.rows);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: msg });
    }
  });

  /**
   * POST /api/credentials/:id/redemptions/:requestId/claim
   * Claim an approved redemption
   */
  router.post('/:id/redemptions/:requestId/claim', async (req: Request, res: Response) => {
    try {
      const { id, requestId } = req.params;
      const pool = getPool();

      const client = await pool.connect();
      try {
        await client.query('BEGIN');

        // Get redemption request
        const reqResult = await client.query(
          `SELECT id, status, amount FROM redemption_requests
           WHERE id = $1 AND credential_id = $2`,
          [requestId, id]
        );

        if (reqResult.rows.length === 0) {
          await client.query('ROLLBACK');
          res.status(404).json({ error: 'Redemption request not found' });
          return;
        }

        const req_row = reqResult.rows[0];
        if (req_row.status !== 'approved') {
          await client.query('ROLLBACK');
          res.status(400).json({
            error: `Cannot claim redemption with status: ${req_row.status}`,
          });
          return;
        }

        // Update redemption request
        const updateResult = await client.query(
          `UPDATE redemption_requests
           SET status = 'claimed', processed_at = now()
           WHERE id = $1
           RETURNING id, status, processed_at`,
          [requestId]
        );

        // Update escrow
        await client.query(
          `UPDATE reward_escrow SET escrow_status = 'claimed' WHERE id =
           (SELECT reward_escrow_id FROM redemption_requests WHERE id = $1)`,
          [requestId]
        );

        // Create ledger entry
        await client.query(
          `INSERT INTO redemption_ledger
           (credential_id, redemption_request_id, credit, balance, transaction_type, description)
           SELECT $1, $2, $3, accumulated_value, 'redemption_claimed', 'Redemption claimed'
           FROM credential_rewards WHERE credential_id = $1`,
          [id, requestId, req_row.amount]
        );

        await client.query('COMMIT');

        // Publish redemption claimed event for real-time notifications
        publishRedemptionClaimedEvent(parseInt(id, 10), parseInt(requestId, 10), req_row.amount);

        res.json(updateResult.rows[0]);
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
   * GET /api/credentials/:id/ledger
   * Get redemption accounting ledger for a credential
   */
  router.get('/:id/ledger', async (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      const { limit = '100' } = req.query;

      const pool = getPool();
      const limitNum = Math.min(parseInt(String(limit), 10), 500);

      const result = await pool.query(
        `SELECT id, credential_id, debit, credit, balance, transaction_type, description, created_at
         FROM redemption_ledger WHERE credential_id = $1
         ORDER BY created_at DESC LIMIT $2`,
        [id, limitNum]
      );

      res.json(result.rows);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: msg });
    }
  });

  return router;
}

export default createCredentialRedemptionRouter();
