import { getPool } from '../db.js';
import { randomUUID } from 'crypto';

export interface CredentialReward {
  id: string;
  credential_id: number;
  tier: 'bronze' | 'silver' | 'gold';
  amount: string; // DECIMAL
  status: 'pending' | 'claimed' | 'expired';
  earned_at: string;
  expires_at: string;
  claimed_at: string | null;
  created_at: string;
}

export interface RewardEscrow {
  id: string;
  credential_id: number;
  reward_id: string;
  amount: string; // DECIMAL
  status: 'escrowed' | 'settled' | 'refunded';
  held_until: string;
  settled_at: string | null;
  settlement_hash: string | null;
  created_at: string;
}

export interface RedemptionHistory {
  id: string;
  credential_id: number;
  reward_id: string;
  action: 'earned' | 'claimed' | 'settled' | 'expired' | 'refunded';
  amount: string; // DECIMAL
  notes: string | null;
  created_at: string;
}

export interface RewardTier {
  id: string;
  credential_tier: 'bronze' | 'silver' | 'gold';
  reward_amount: string; // DECIMAL
  created_at: string;
}

export class CredentialRedemptionService {
  private pool = getPool();

  async getRewardTier(tier: 'bronze' | 'silver' | 'gold'): Promise<RewardTier | null> {
    const result = await this.pool.query(
      'SELECT * FROM reward_tiers WHERE credential_tier = $1',
      [tier]
    );
    return result.rows[0] || null;
  }

  async createReward(credentialId: number, tier: 'bronze' | 'silver' | 'gold'): Promise<CredentialReward> {
    const rewardTier = await this.getRewardTier(tier);
    if (!rewardTier) {
      throw new Error(`No reward tier found for: ${tier}`);
    }

    const rewardId = `reward_${randomUUID()}`;
    const result = await this.pool.query(
      `INSERT INTO credential_rewards (id, credential_id, tier, amount)
       VALUES ($1, $2, $3, $4)
       RETURNING *`,
      [rewardId, credentialId, tier, rewardTier.reward_amount]
    );

    const reward = result.rows[0];

    await this.pool.query(
      `INSERT INTO redemption_history (id, credential_id, reward_id, action, amount, notes)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [randomUUID(), credentialId, rewardId, 'earned', reward.amount, `Reward earned for ${tier} tier`]
    );

    return reward;
  }

  async getReward(rewardId: string): Promise<CredentialReward | null> {
    const result = await this.pool.query(
      'SELECT * FROM credential_rewards WHERE id = $1',
      [rewardId]
    );
    return result.rows[0] || null;
  }

  async getCredentialRewards(credentialId: number, status?: string): Promise<CredentialReward[]> {
    const query = status
      ? 'SELECT * FROM credential_rewards WHERE credential_id = $1 AND status = $2 ORDER BY created_at DESC'
      : 'SELECT * FROM credential_rewards WHERE credential_id = $1 ORDER BY created_at DESC';
    const params = status ? [credentialId, status] : [credentialId];

    const result = await this.pool.query(query, params);
    return result.rows;
  }

  async claimReward(rewardId: string): Promise<RewardEscrow> {
    const reward = await this.getReward(rewardId);
    if (!reward) {
      throw new Error('Reward not found');
    }

    if (reward.status !== 'pending') {
      throw new Error(`Reward already ${reward.status}`);
    }

    // Update reward status to claimed
    await this.pool.query(
      `UPDATE credential_rewards
       SET status = $1, claimed_at = now()
       WHERE id = $2`,
      ['claimed', rewardId]
    );

    // Create escrow entry
    const escrowId = `escrow_${randomUUID()}`;
    const escrowResult = await this.pool.query(
      `INSERT INTO reward_escrow (id, credential_id, reward_id, amount)
       VALUES ($1, $2, $3, $4)
       RETURNING *`,
      [escrowId, reward.credential_id, rewardId, reward.amount]
    );

    const escrow = escrowResult.rows[0];

    await this.pool.query(
      `INSERT INTO redemption_history (id, credential_id, reward_id, action, amount, notes)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [randomUUID(), reward.credential_id, rewardId, 'claimed', reward.amount, 'Reward claimed and placed in escrow']
    );

    return escrow;
  }

  async getEscrow(escrowId: string): Promise<RewardEscrow | null> {
    const result = await this.pool.query(
      'SELECT * FROM reward_escrow WHERE id = $1',
      [escrowId]
    );
    return result.rows[0] || null;
  }

  async getCredentialEscrow(credentialId: number, status?: string): Promise<RewardEscrow[]> {
    const query = status
      ? 'SELECT * FROM reward_escrow WHERE credential_id = $1 AND status = $2 ORDER BY created_at DESC'
      : 'SELECT * FROM reward_escrow WHERE credential_id = $1 ORDER BY created_at DESC';
    const params = status ? [credentialId, status] : [credentialId];

    const result = await this.pool.query(query, params);
    return result.rows;
  }

  async settleEscrow(escrowId: string, settlementHash: string): Promise<RewardEscrow> {
    const result = await this.pool.query(
      `UPDATE reward_escrow
       SET status = $1, settled_at = now(), settlement_hash = $2
       WHERE id = $3
       RETURNING *`,
      ['settled', settlementHash, escrowId]
    );

    if (result.rows.length === 0) {
      throw new Error('Escrow not found');
    }

    const escrow = result.rows[0];

    await this.pool.query(
      `INSERT INTO redemption_history (id, credential_id, reward_id, action, amount, notes)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [randomUUID(), escrow.credential_id, escrow.reward_id, 'settled', escrow.amount, `Settled with hash: ${settlementHash}`]
    );

    return escrow;
  }

  async refundEscrow(escrowId: string): Promise<RewardEscrow> {
    const result = await this.pool.query(
      `UPDATE reward_escrow
       SET status = $1
       WHERE id = $2
       RETURNING *`,
      ['refunded', escrowId]
    );

    if (result.rows.length === 0) {
      throw new Error('Escrow not found');
    }

    const escrow = result.rows[0];

    // Update reward status back to pending
    await this.pool.query(
      `UPDATE credential_rewards
       SET status = $1, claimed_at = null
       WHERE id = $2`,
      ['pending', escrow.reward_id]
    );

    await this.pool.query(
      `INSERT INTO redemption_history (id, credential_id, reward_id, action, amount, notes)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [randomUUID(), escrow.credential_id, escrow.reward_id, 'refunded', escrow.amount, 'Reward refunded from escrow']
    );

    return escrow;
  }

  async expireOldRewards(): Promise<number> {
    const result = await this.pool.query(
      `UPDATE credential_rewards
       SET status = $1
       WHERE status = $2 AND expires_at < now()
       RETURNING id`,
      ['expired', 'pending']
    );

    for (const row of result.rows) {
      await this.pool.query(
        `INSERT INTO redemption_history (id, credential_id, reward_id, action, amount, notes)
         VALUES ($1, (SELECT credential_id FROM credential_rewards WHERE id = $2), $2, $3,
                 (SELECT amount FROM credential_rewards WHERE id = $2), $4)`,
        [randomUUID(), row.id, 'expired', 'Reward expired']
      );
    }

    return result.rowCount;
  }

  async getTotalRewardsByCredential(credentialId: number): Promise<{ total: string; claimed: string; pending: string }> {
    const result = await this.pool.query(
      `SELECT
        SUM(amount) FILTER (WHERE status IN ('pending', 'claimed')) as total,
        SUM(amount) FILTER (WHERE status = 'claimed') as claimed,
        SUM(amount) FILTER (WHERE status = 'pending') as pending
       FROM credential_rewards
       WHERE credential_id = $1`,
      [credentialId]
    );

    const row = result.rows[0];
    return {
      total: row.total || '0',
      claimed: row.claimed || '0',
      pending: row.pending || '0',
    };
  }

  async getRedemptionHistory(credentialId: number, limit = 50, offset = 0): Promise<RedemptionHistory[]> {
    const result = await this.pool.query(
      `SELECT * FROM redemption_history
       WHERE credential_id = $1
       ORDER BY created_at DESC
       LIMIT $2 OFFSET $3`,
      [credentialId, limit, offset]
    );
    return result.rows;
  }
}

export const credentialRedemptionService = new CredentialRedemptionService();
