import { getPool } from '../db.js';

export interface CredentialTier {
  id: string;
  credential_id: number;
  tier: 'bronze' | 'silver' | 'gold';
  reputation_score: number;
  created_at: string;
  updated_at: string;
  promoted_at: string | null;
}

export interface TierProgressionRule {
  id: string;
  from_tier: 'bronze' | 'silver' | 'gold';
  to_tier: 'bronze' | 'silver' | 'gold';
  min_reputation_score: number;
  min_age_days: number;
  min_validations: number;
}

export class CredentialTieringService {
  private pool = getPool();

  async getOrCreateTier(credentialId: number): Promise<CredentialTier> {
    const existing = await this.pool.query(
      'SELECT * FROM credential_tiers WHERE credential_id = $1',
      [credentialId]
    );

    if (existing.rows.length > 0) {
      return existing.rows[0];
    }

    const result = await this.pool.query(
      'INSERT INTO credential_tiers (id, credential_id, tier, reputation_score) VALUES ($1, $2, $3, $4) RETURNING *',
      [`tier_${credentialId}`, credentialId, 'bronze', 0]
    );
    return result.rows[0];
  }

  async getTier(credentialId: number): Promise<CredentialTier | null> {
    const result = await this.pool.query(
      'SELECT * FROM credential_tiers WHERE credential_id = $1',
      [credentialId]
    );
    return result.rows[0] || null;
  }

  async updateReputationScore(credentialId: number, scoreIncrement: number): Promise<CredentialTier> {
    const result = await this.pool.query(
      `UPDATE credential_tiers
       SET reputation_score = reputation_score + $1
       WHERE credential_id = $2
       RETURNING *`,
      [scoreIncrement, credentialId]
    );
    return result.rows[0];
  }

  async getProgressionRules(fromTier: string): Promise<TierProgressionRule[]> {
    const result = await this.pool.query(
      'SELECT * FROM tier_progression_rules WHERE from_tier = $1',
      [fromTier]
    );
    return result.rows;
  }

  async checkAndPromoteTier(credentialId: number): Promise<CredentialTier | null> {
    const tier = await this.getTier(credentialId);
    if (!tier || tier.tier === 'gold') {
      return tier;
    }

    const rules = await this.getProgressionRules(tier.tier);
    if (rules.length === 0) {
      return tier;
    }

    const rule = rules[0];

    // Check if reputation score meets minimum
    if (tier.reputation_score < rule.min_reputation_score) {
      return tier;
    }

    // Check if credential is old enough
    const createdAt = new Date(tier.created_at);
    const ageInDays = Math.floor((Date.now() - createdAt.getTime()) / (1000 * 60 * 60 * 24));
    if (ageInDays < rule.min_age_days) {
      return tier;
    }

    // Promote to next tier
    const result = await this.pool.query(
      `UPDATE credential_tiers
       SET tier = $1, promoted_at = now()
       WHERE credential_id = $2
       RETURNING *`,
      [rule.to_tier, credentialId]
    );

    return result.rows[0];
  }

  async getTiersByTier(tier: 'bronze' | 'silver' | 'gold', limit = 100, offset = 0): Promise<CredentialTier[]> {
    const result = await this.pool.query(
      'SELECT * FROM credential_tiers WHERE tier = $1 ORDER BY reputation_score DESC LIMIT $2 OFFSET $3',
      [tier, limit, offset]
    );
    return result.rows;
  }

  async getTierStats(): Promise<{ tier: string; count: number; avg_reputation: number }[]> {
    const result = await this.pool.query(
      `SELECT tier, COUNT(*) as count, AVG(reputation_score)::INTEGER as avg_reputation
       FROM credential_tiers
       GROUP BY tier
       ORDER BY tier`
    );
    return result.rows;
  }
}

export const credentialTieringService = new CredentialTieringService();
