import { beforeEach, describe, expect, it } from 'vitest';
import type { WsBroadcastEvent } from '../src/ws/subscriptions.js';
import {
  initTierRedemptionEvents,
  publishRedemptionApprovedEvent,
  publishRedemptionClaimedEvent,
  publishRedemptionExpiredEvent,
  publishRedemptionRequestedEvent,
  publishTierAdvancedEvent,
  publishTierPointsAccruedEvent,
} from '../src/services/tierRedemptionEvents.js';

describe('tier and redemption websocket event payloads', () => {
  let events: WsBroadcastEvent[];

  beforeEach(() => {
    events = [];
    initTierRedemptionEvents((event) => {
      events.push(event);
      return events.length;
    });
  });

  it('publishes typed tier and redemption details', () => {
    expect(publishTierAdvancedEvent(1, 'bronze', 'silver', 120)).toBe(1);
    expect(publishTierPointsAccruedEvent(2, 25, 'silver', 145)).toBe(2);
    expect(publishRedemptionRequestedEvent(3, 4, '50', 'GDESTINATION')).toBe(3);
    expect(publishRedemptionApprovedEvent(3, 4, '50')).toBe(4);
    expect(publishRedemptionClaimedEvent(3, 4, '50')).toBe(5);
    expect(publishRedemptionExpiredEvent(3, 4)).toBe(6);

    expect(events.map(({ type }) => type)).toEqual([
      'tier_advanced',
      'tier_points_accrued',
      'redemption_requested',
      'redemption_approved',
      'redemption_claimed',
      'redemption_expired',
    ]);
    expect(events[0]).toMatchObject({
      from_tier: 'bronze',
      to_tier: 'silver',
      points: 120,
    });
    expect(events[1]).toMatchObject({
      points: 25,
      current_tier: 'silver',
      current_points: 145,
    });
    expect(events[2]).toMatchObject({
      request_id: 4,
      amount: '50',
      destination: 'GDESTINATION',
    });
    expect(events.slice(3)).toEqual([
      expect.objectContaining({ request_id: 4, amount: '50' }),
      expect.objectContaining({ request_id: 4, amount: '50' }),
      expect.objectContaining({ request_id: 4 }),
    ]);
  });
});
