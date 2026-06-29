import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  dispatchNotification,
  flushPendingBatch,
  setPreferences,
  getHistory,
  BATCH_WINDOW_MS,
  _resetStores,
} from '../src/notifications.js';

const BASE_PREFS = {
  address: 'GTEST',
  email: 'test@example.com',
  channels: ['email' as const],
  events: ['credential_issued' as const, 'credential_revoked' as const],
  enabled: true,
};

beforeEach(() => {
  _resetStores();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('notification batching', () => {
  it('sends a single notification when no other events arrive within the window', async () => {
    setPreferences(BASE_PREFS);
    await dispatchNotification('GTEST', 'credential_issued', 1, 'issuerA');

    await vi.runAllTimersAsync();

    const history = getHistory('GTEST');
    expect(history).toHaveLength(1);
    expect(history[0].credential_id).toBe(1);
    expect(history[0].issuer).toBe('issuerA');
    expect(history[0].batched_credential_ids).toBeUndefined();
  });

  it('batches multiple events from the same issuer into one notification', async () => {
    setPreferences(BASE_PREFS);
    await dispatchNotification('GTEST', 'credential_issued', 1, 'issuerA');
    await dispatchNotification('GTEST', 'credential_issued', 2, 'issuerA');
    await dispatchNotification('GTEST', 'credential_revoked', 3, 'issuerA');

    await vi.runAllTimersAsync();

    const history = getHistory('GTEST');
    expect(history).toHaveLength(1);
    expect(history[0].batched_credential_ids).toEqual([1, 2, 3]);
    expect(history[0].issuer).toBe('issuerA');
    expect(history[0].message).toContain('issuerA');
    expect(history[0].message).toContain('#1');
    expect(history[0].message).toContain('#2');
    expect(history[0].message).toContain('#3');
  });

  it('keeps events from different issuers in separate notifications', async () => {
    setPreferences(BASE_PREFS);
    await dispatchNotification('GTEST', 'credential_issued', 1, 'issuerA');
    await dispatchNotification('GTEST', 'credential_issued', 2, 'issuerB');

    await vi.runAllTimersAsync();

    const history = getHistory('GTEST');
    expect(history).toHaveLength(2);
    const issuers = history.map((r) => r.issuer).sort();
    expect(issuers).toEqual(['issuerA', 'issuerB']);
  });

  it('resets the batch window timer when a new event arrives before flush', async () => {
    setPreferences(BASE_PREFS);
    await dispatchNotification('GTEST', 'credential_issued', 1, 'issuerA');

    // Advance time to just before the window expires
    vi.advanceTimersByTime(BATCH_WINDOW_MS - 100);

    // A second event resets the timer
    await dispatchNotification('GTEST', 'credential_issued', 2, 'issuerA');

    // Original window would have fired here, but it was reset
    vi.advanceTimersByTime(100);
    expect(getHistory('GTEST')).toHaveLength(0);

    // After the full window from the second event, flush occurs
    vi.advanceTimersByTime(BATCH_WINDOW_MS);
    // Allow the async flush to complete
    await Promise.resolve();
    await Promise.resolve();

    const history = getHistory('GTEST');
    expect(history).toHaveLength(1);
    expect(history[0].batched_credential_ids).toEqual([1, 2]);
  });

  it('flushPendingBatch immediately dispatches the buffered events', async () => {
    setPreferences(BASE_PREFS);
    await dispatchNotification('GTEST', 'credential_issued', 10, 'issuerA');
    await dispatchNotification('GTEST', 'credential_issued', 11, 'issuerA');

    // Do NOT advance timers — explicitly flush
    await flushPendingBatch('GTEST', 'issuerA');

    const history = getHistory('GTEST');
    expect(history).toHaveLength(1);
    expect(history[0].batched_credential_ids).toEqual([10, 11]);
  });

  it('does not dispatch if address has no preferences', async () => {
    // No setPreferences call
    await dispatchNotification('GUNKNOWN', 'credential_issued', 1, 'issuerA');
    await vi.runAllTimersAsync();
    expect(getHistory('GUNKNOWN')).toHaveLength(0);
  });

  it('does not dispatch if notifications are disabled', async () => {
    setPreferences({ ...BASE_PREFS, enabled: false });
    await dispatchNotification('GTEST', 'credential_issued', 1, 'issuerA');
    await vi.runAllTimersAsync();
    expect(getHistory('GTEST')).toHaveLength(0);
  });

  it('does not dispatch for events the user has not subscribed to', async () => {
    setPreferences({ ...BASE_PREFS, events: ['credential_revoked'] });
    await dispatchNotification('GTEST', 'credential_issued', 1, 'issuerA');
    await vi.runAllTimersAsync();
    expect(getHistory('GTEST')).toHaveLength(0);
  });

  it('groups events without an issuer under an anonymous batch key', async () => {
    setPreferences(BASE_PREFS);
    await dispatchNotification('GTEST', 'credential_issued', 1);
    await dispatchNotification('GTEST', 'credential_issued', 2);

    await vi.runAllTimersAsync();

    const history = getHistory('GTEST');
    expect(history).toHaveLength(1);
    expect(history[0].batched_credential_ids).toEqual([1, 2]);
    expect(history[0].issuer).toBeUndefined();
  });
});
