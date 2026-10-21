/**
 * Service for publishing tier advancement and redemption events to WebSocket subscribers.
 * This enables real-time push notifications for credential lifecycle events (Issue #1605).
 */

import type { WsBroadcastEvent } from '../ws/subscriptions.js';

let broadcastEventFn: ((event: WsBroadcastEvent) => number) | null = null;

/**
 * Initialize the event broadcaster. Called from index.ts after creating the WS server.
 */
export function initTierRedemptionEvents(broadcaster: (event: WsBroadcastEvent) => number): void {
  broadcastEventFn = broadcaster;
}

/**
 * Publish a tier advancement event to all subscribers.
 * Subscribers can filter by credential_id or event_type: 'tier_advanced'
 */
export function publishTierAdvancedEvent(
  credentialId: number,
  fromTier: string,
  toTier: string,
  points: number
): number {
  if (!broadcastEventFn) return 0;

  const event: WsBroadcastEvent = {
    type: 'tier_advanced',
    credential_id: credentialId,
    from_tier: fromTier,
    to_tier: toTier,
    points,
    timestamp: new Date().toISOString(),
  };

  return broadcastEventFn(event);
}

/**
 * Publish a tier points accrued event to all subscribers.
 * Subscribers can filter by credential_id or event_type: 'tier_points_accrued'
 */
export function publishTierPointsAccruedEvent(
  credentialId: number,
  points: number,
  currentTier: string,
  currentPoints: number
): number {
  if (!broadcastEventFn) return 0;

  const event: WsBroadcastEvent = {
    type: 'tier_points_accrued',
    credential_id: credentialId,
    points,
    current_tier: currentTier,
    current_points: currentPoints,
    timestamp: new Date().toISOString(),
  };

  return broadcastEventFn(event);
}

/**
 * Publish a redemption request submitted event.
 * Subscribers can filter by credential_id or event_type: 'redemption_requested'
 */
export function publishRedemptionRequestedEvent(
  credentialId: number,
  requestId: number,
  amount: string,
  destination: string
): number {
  if (!broadcastEventFn) return 0;

  const event: WsBroadcastEvent = {
    type: 'redemption_requested',
    credential_id: credentialId,
    request_id: requestId,
    amount,
    destination,
    timestamp: new Date().toISOString(),
  };

  return broadcastEventFn(event);
}

/**
 * Publish a redemption approved event.
 * Subscribers can filter by credential_id or event_type: 'redemption_approved'
 */
export function publishRedemptionApprovedEvent(
  credentialId: number,
  requestId: number,
  amount: string
): number {
  if (!broadcastEventFn) return 0;

  const event: WsBroadcastEvent = {
    type: 'redemption_approved',
    credential_id: credentialId,
    request_id: requestId,
    amount,
    timestamp: new Date().toISOString(),
  };

  return broadcastEventFn(event);
}

/**
 * Publish a redemption claimed event.
 * Subscribers can filter by credential_id or event_type: 'redemption_claimed'
 */
export function publishRedemptionClaimedEvent(
  credentialId: number,
  requestId: number,
  amount: string
): number {
  if (!broadcastEventFn) return 0;

  const event: WsBroadcastEvent = {
    type: 'redemption_claimed',
    credential_id: credentialId,
    request_id: requestId,
    amount,
    timestamp: new Date().toISOString(),
  };

  return broadcastEventFn(event);
}

/**
 * Publish a redemption expired event.
 * Subscribers can filter by credential_id or event_type: 'redemption_expired'
 */
export function publishRedemptionExpiredEvent(
  credentialId: number,
  requestId: number
): number {
  if (!broadcastEventFn) return 0;

  const event: WsBroadcastEvent = {
    type: 'redemption_expired',
    credential_id: credentialId,
    request_id: requestId,
    timestamp: new Date().toISOString(),
  };

  return broadcastEventFn(event);
}
