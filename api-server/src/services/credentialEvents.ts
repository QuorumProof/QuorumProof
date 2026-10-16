import { broadcastEvent as wsServerBroadcastEvent } from '../ws/server.js';
import type { WsBroadcastEvent } from '../ws/subscriptions.js';

export interface CredentialEventPayload {
  type:
    | 'credential_issued'
    | 'credential_revoked'
    | 'credential_attested'
    | 'credential_suspended'
    | 'credential_expired'
    | 'credential_tier_promoted'
    | 'reward_earned'
    | 'reward_claimed'
    | 'reward_settled'
    | 'reward_expired';
  credential_id?: number;
  issuer?: string;
  holder?: string;
  attestor?: string;
  tier?: string;
  reward_id?: string;
  amount?: string;
  timestamp: string;
  metadata?: Record<string, unknown>;
}

export class CredentialEventService {
  private eventHistory: CredentialEventPayload[] = [];
  private maxHistorySize = 1000;

  private addToHistory(event: CredentialEventPayload): void {
    this.eventHistory.push(event);
    if (this.eventHistory.length > this.maxHistorySize) {
      this.eventHistory = this.eventHistory.slice(-this.maxHistorySize);
    }
  }

  emitTierPromoted(
    credentialId: number,
    newTier: 'bronze' | 'silver' | 'gold',
    issuer?: string,
    holder?: string,
  ): void {
    const event: CredentialEventPayload = {
      type: 'credential_tier_promoted',
      credential_id: credentialId,
      issuer,
      holder,
      tier: newTier,
      timestamp: new Date().toISOString(),
      metadata: { new_tier: newTier },
    };

    this.addToHistory(event);
    this.broadcastEvent(event);
  }

  emitRewardEarned(
    credentialId: number,
    rewardId: string,
    tier: 'bronze' | 'silver' | 'gold',
    amount: string,
    issuer?: string,
    holder?: string,
  ): void {
    const event: CredentialEventPayload = {
      type: 'reward_earned',
      credential_id: credentialId,
      reward_id: rewardId,
      tier,
      amount,
      issuer,
      holder,
      timestamp: new Date().toISOString(),
      metadata: { tier, amount },
    };

    this.addToHistory(event);
    this.broadcastEvent(event);
  }

  emitRewardClaimed(
    credentialId: number,
    rewardId: string,
    amount: string,
    issuer?: string,
    holder?: string,
  ): void {
    const event: CredentialEventPayload = {
      type: 'reward_claimed',
      credential_id: credentialId,
      reward_id: rewardId,
      amount,
      issuer,
      holder,
      timestamp: new Date().toISOString(),
      metadata: { amount },
    };

    this.addToHistory(event);
    this.broadcastEvent(event);
  }

  emitRewardSettled(
    credentialId: number,
    rewardId: string,
    amount: string,
    settlementHash: string,
    issuer?: string,
    holder?: string,
  ): void {
    const event: CredentialEventPayload = {
      type: 'reward_settled',
      credential_id: credentialId,
      reward_id: rewardId,
      amount,
      issuer,
      holder,
      timestamp: new Date().toISOString(),
      metadata: { settlement_hash: settlementHash },
    };

    this.addToHistory(event);
    this.broadcastEvent(event);
  }

  emitRewardExpired(
    credentialId: number,
    rewardId: string,
    amount: string,
    issuer?: string,
    holder?: string,
  ): void {
    const event: CredentialEventPayload = {
      type: 'reward_expired',
      credential_id: credentialId,
      reward_id: rewardId,
      amount,
      issuer,
      holder,
      timestamp: new Date().toISOString(),
    };

    this.addToHistory(event);
    this.broadcastEvent(event);
  }

  emitCredentialIssued(
    credentialId: number,
    issuer: string,
    holder?: string,
  ): void {
    const event: CredentialEventPayload = {
      type: 'credential_issued',
      credential_id: credentialId,
      issuer,
      holder,
      timestamp: new Date().toISOString(),
    };

    this.addToHistory(event);
    this.broadcastEvent(event);
  }

  emitCredentialRevoked(
    credentialId: number,
    issuer?: string,
    holder?: string,
  ): void {
    const event: CredentialEventPayload = {
      type: 'credential_revoked',
      credential_id: credentialId,
      issuer,
      holder,
      timestamp: new Date().toISOString(),
    };

    this.addToHistory(event);
    this.broadcastEvent(event);
  }

  emitCredentialSuspended(
    credentialId: number,
    issuer?: string,
    holder?: string,
  ): void {
    const event: CredentialEventPayload = {
      type: 'credential_suspended',
      credential_id: credentialId,
      issuer,
      holder,
      timestamp: new Date().toISOString(),
    };

    this.addToHistory(event);
    this.broadcastEvent(event);
  }

  private broadcastEvent(event: CredentialEventPayload): void {
    const wsEvent: WsBroadcastEvent = {
      type: event.type,
      credential_id: event.credential_id,
      issuer: event.issuer,
      holder: event.holder,
      attestor: event.attestor,
      timestamp: event.timestamp,
    };

    wsServerBroadcastEvent(wsEvent);
  }

  getRecentEvents(limit = 50, filter?: { type?: string; credential_id?: number }): CredentialEventPayload[] {
    let events = [...this.eventHistory].reverse().slice(0, limit);

    if (filter) {
      if (filter.type) {
        events = events.filter((e) => e.type === filter.type);
      }
      if (filter.credential_id) {
        events = events.filter((e) => e.credential_id === filter.credential_id);
      }
    }

    return events;
  }

  getEventHistory(startTime: Date, endTime: Date): CredentialEventPayload[] {
    return this.eventHistory.filter((e) => {
      const ts = new Date(e.timestamp);
      return ts >= startTime && ts <= endTime;
    });
  }
}

export const credentialEventService = new CredentialEventService();
