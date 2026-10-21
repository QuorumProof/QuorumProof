import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  initTierRedemptionEvents,
  publishRedemptionApprovedEvent,
  publishRedemptionClaimedEvent,
  publishRedemptionExpiredEvent,
  publishRedemptionRequestedEvent,
  publishTierAdvancedEvent,
  publishTierPointsAccruedEvent,
} from '../src/services/tierRedemptionEvents.js';

describe('tier and redemption event publishing', () => {
  const broadcast = vi.fn(() => 1);

  beforeEach(() => {
    broadcast.mockClear();
    initTierRedemptionEvents(broadcast);
  });

  it('publishes tier changes and accrued points with their custom fields', () => {
    expect(publishTierAdvancedEvent(7, 'bronze', 'silver', 250)).toBe(1);
    expect(publishTierPointsAccruedEvent(7, 25, 'silver', 275)).toBe(1);

    expect(broadcast.mock.calls.map(([event]) => event)).toMatchObject([
      { type: 'tier_advanced', credential_id: 7, from_tier: 'bronze', to_tier: 'silver', points: 250 },
      { type: 'tier_points_accrued', credential_id: 7, points: 25, current_tier: 'silver', current_points: 275 },
    ]);
    for (const [event] of broadcast.mock.calls) {
      expect(event.timestamp).toEqual(expect.any(String));
    }
  });

  it('publishes all redemption lifecycle events with their identifying payload', () => {
    publishRedemptionRequestedEvent(7, 41, '12.50', 'GDESTINATION');
    publishRedemptionApprovedEvent(7, 41, '12.50');
    publishRedemptionClaimedEvent(7, 41, '12.50');
    publishRedemptionExpiredEvent(7, 41);

    expect(broadcast.mock.calls.map(([event]) => event)).toMatchObject([
      { type: 'redemption_requested', credential_id: 7, request_id: 41, amount: '12.50', destination: 'GDESTINATION' },
      { type: 'redemption_approved', credential_id: 7, request_id: 41, amount: '12.50' },
      { type: 'redemption_claimed', credential_id: 7, request_id: 41, amount: '12.50' },
      { type: 'redemption_expired', credential_id: 7, request_id: 41 },
    ]);
  });
});
