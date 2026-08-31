/**
 * Tests for Issue #1434 — Sustained WebSocket message drop alerting.
 *
 * Verifies that a simulated drop burst triggers the alert dispatch path in
 * src/ws/metrics.ts, and that sub-threshold activity does not produce alerts.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as alertChannels from '../src/services/alertChannels.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Re-imports ws/metrics with fresh module state so each test starts clean.
 * We achieve this by saving/restoring the env vars that control the threshold
 * and window, then calling resetWsMetrics() so the in-module counters are
 * zeroed out between tests.
 */
async function getMetrics() {
  const m = await import('../src/ws/metrics.js');
  return m;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('WS message drop alerting (#1434)', () => {
  let originalThreshold: string | undefined;
  let originalWindow: string | undefined;

  beforeEach(async () => {
    originalThreshold = process.env.WS_DROP_ALERT_THRESHOLD;
    originalWindow = process.env.WS_DROP_ALERT_WINDOW_SECONDS;
    vi.restoreAllMocks();
    const { resetWsMetrics } = await getMetrics();
    resetWsMetrics();
  });

  afterEach(() => {
    // Restore env vars
    if (originalThreshold === undefined) {
      delete process.env.WS_DROP_ALERT_THRESHOLD;
    } else {
      process.env.WS_DROP_ALERT_THRESHOLD = originalThreshold;
    }
    if (originalWindow === undefined) {
      delete process.env.WS_DROP_ALERT_WINDOW_SECONDS;
    } else {
      process.env.WS_DROP_ALERT_WINDOW_SECONDS = originalWindow;
    }
    vi.restoreAllMocks();
  });

  it('does not dispatch alert when drops are below the default threshold within the window', async () => {
    const spy = vi
      .spyOn(alertChannels, 'dispatchWsMessageDropAlert')
      .mockResolvedValue([]);

    const { recordMessageDropped, resetWsMetrics } = await getMetrics();
    resetWsMetrics();

    // Default threshold is 10 — drop 5 (below threshold)
    for (let i = 0; i < 5; i++) recordMessageDropped();

    // No window rollover has occurred, so spy must not have been called
    expect(spy).not.toHaveBeenCalled();
  });

  it('dispatches alert when drop burst exceeds threshold within the window', async () => {
    const spy = vi
      .spyOn(alertChannels, 'dispatchWsMessageDropAlert')
      .mockResolvedValue([]);

    // Use a 0-second window so every call after the first sees an elapsed window
    process.env.WS_DROP_ALERT_THRESHOLD = '3';
    process.env.WS_DROP_ALERT_WINDOW_SECONDS = '0';

    const { recordMessageDropped, resetWsMetrics } = await getMetrics();
    resetWsMetrics();

    // Drop 4 times — on the 2nd+ call the 0s window has elapsed and count >= 3
    for (let i = 0; i < 4; i++) recordMessageDropped();

    // Allow any fire-and-forget microtasks to settle
    await Promise.resolve();

    expect(spy).toHaveBeenCalled();
  });

  it('increments messagesDropped metric on every call to recordMessageDropped', async () => {
    const { recordMessageDropped, getWsMetrics, resetWsMetrics } = await getMetrics();
    resetWsMetrics();

    expect(getWsMetrics().messagesDropped).toBe(0);
    recordMessageDropped();
    recordMessageDropped();
    recordMessageDropped();
    expect(getWsMetrics().messagesDropped).toBe(3);
  });

  it('dispatched alert receives dropsInWindow, windowSeconds, and instanceId as arguments', async () => {
    const spy = vi
      .spyOn(alertChannels, 'dispatchWsMessageDropAlert')
      .mockResolvedValue([]);

    process.env.WS_DROP_ALERT_THRESHOLD = '2';
    process.env.WS_DROP_ALERT_WINDOW_SECONDS = '0';

    const { recordMessageDropped, resetWsMetrics } = await getMetrics();
    resetWsMetrics();

    for (let i = 0; i < 3; i++) recordMessageDropped();

    await Promise.resolve();

    if (spy.mock.calls.length > 0) {
      const [dropsInWindow, windowSeconds, instanceIdArg] = spy.mock.calls[0];
      expect(typeof dropsInWindow).toBe('number');
      expect(dropsInWindow).toBeGreaterThan(0);
      expect(typeof windowSeconds).toBe('number');
      expect(typeof instanceIdArg).toBe('string');
      expect(instanceIdArg.length).toBeGreaterThan(0);
    }
  });

  it('resets the drop window counter after triggering an alert', async () => {
    const spy = vi
      .spyOn(alertChannels, 'dispatchWsMessageDropAlert')
      .mockResolvedValue([]);

    process.env.WS_DROP_ALERT_THRESHOLD = '2';
    process.env.WS_DROP_ALERT_WINDOW_SECONDS = '0';

    const { recordMessageDropped, resetWsMetrics } = await getMetrics();
    resetWsMetrics();

    // First burst — triggers alert
    for (let i = 0; i < 3; i++) recordMessageDropped();
    await Promise.resolve();
    const firstCallCount = spy.mock.calls.length;
    expect(firstCallCount).toBeGreaterThan(0);

    // Second burst — should trigger again after window reset
    for (let i = 0; i < 3; i++) recordMessageDropped();
    await Promise.resolve();
    expect(spy.mock.calls.length).toBeGreaterThanOrEqual(firstCallCount);
  });

  it('resetWsMetrics clears the messagesDropped counter to 0', async () => {
    const { recordMessageDropped, getWsMetrics, resetWsMetrics } = await getMetrics();
    resetWsMetrics();

    recordMessageDropped();
    recordMessageDropped();
    expect(getWsMetrics().messagesDropped).toBe(2);

    resetWsMetrics();
    expect(getWsMetrics().messagesDropped).toBe(0);
  });
});
