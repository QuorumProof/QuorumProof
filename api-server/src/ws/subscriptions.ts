import { WebSocket } from 'ws';

export interface SubscriptionFilter {
  credential_id?: number;
  issuer?: string;
  holder?: string;
  event_type?: string;
}

interface ClientSubscription {
  ws: WebSocket;
  filters: SubscriptionFilter[];
  subscribedAt: string;
}

const subscriptions = new Map<WebSocket, ClientSubscription>();

function matchesFilter(filter: SubscriptionFilter, event: WsBroadcastEvent): boolean {
  if (filter.credential_id !== undefined && event.credential_id !== filter.credential_id) {
    return false;
  }
  if (filter.issuer !== undefined && event.issuer !== filter.issuer) {
    return false;
  }
  if (filter.holder !== undefined && event.holder !== filter.holder) {
    return false;
  }
  if (filter.event_type !== undefined && event.type !== filter.event_type) {
    return false;
  }
  return true;
}

export interface WsBroadcastEvent {
  type: string;
  credential_id?: number;
  issuer?: string;
  holder?: string;
  attestor?: string;
  proof_request_id?: string;
  timestamp: string;
}

export function addSubscriber(ws: WebSocket, filters: SubscriptionFilter[]): void {
  const existing = subscriptions.get(ws);
  if (existing) {
    existing.filters.push(...filters);
  } else {
    subscriptions.set(ws, {
      ws,
      filters: [...filters],
      subscribedAt: new Date().toISOString(),
    });
  }
}

export function removeSubscriber(ws: WebSocket, filters?: SubscriptionFilter[]): void {
  if (!filters) {
    subscriptions.delete(ws);
    return;
  }

  const existing = subscriptions.get(ws);
  if (!existing) return;

  for (const filter of filters) {
    const idx = existing.filters.findIndex(
      (f) =>
        f.credential_id === filter.credential_id &&
        f.issuer === filter.issuer &&
        f.holder === filter.holder &&
        f.event_type === filter.event_type
    );
    if (idx !== -1) {
      existing.filters.splice(idx, 1);
    }
  }

  if (existing.filters.length === 0) {
    subscriptions.delete(ws);
  }
}

export function removeConnection(ws: WebSocket): void {
  subscriptions.delete(ws);
}

export function getSubscriberCount(): number {
  return subscriptions.size;
}

export function getMatchingSubscribers(event: WsBroadcastEvent): WebSocket[] {
  const matches: WebSocket[] = [];
  for (const [, sub] of subscriptions) {
    const matched = sub.filters.length === 0 ||
      sub.filters.some((filter) => matchesFilter(filter, event));
    if (matched) {
      if (sub.ws.readyState === WebSocket.OPEN) {
        matches.push(sub.ws);
      } else {
        subscriptions.delete(sub.ws);
      }
    }
  }
  return matches;
}

export function getSubscriptions(): Map<WebSocket, ClientSubscription> {
  return new Map(subscriptions);
}
