import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useRealtimeUpdates } from '../useRealtimeUpdates';

// ── WebSocket mock ──────────────────────────────────────────────────────────

class MockWebSocket {
  static instances: MockWebSocket[] = [];
  url: string;
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: ((ev: { code: number }) => void) | null = null;
  readyState = 0;

  constructor(url: string) {
    this.url = url;
    MockWebSocket.instances.push(this);
  }

  close() {
    this.readyState = 3;
    this.onclose?.({ code: 1000 });
  }

  simulateOpen() { this.readyState = 1; this.onopen?.(); }
  simulateMessage(data = '{}') { this.onmessage?.({ data }); }
  simulateError() { this.onerror?.(); }
  simulateClose(code = 1006) { this.readyState = 3; this.onclose?.({ code }); }
}

beforeEach(() => {
  MockWebSocket.instances = [];
  vi.stubGlobal('WebSocket', MockWebSocket);
  vi.useFakeTimers();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('useRealtimeUpdates', () => {
  it('starts in connecting state when wsUrl provided', () => {
    const onUpdate = vi.fn();
    const { result } = renderHook(() =>
      useRealtimeUpdates({ wsUrl: 'ws://localhost:9000', onUpdate })
    );
    expect(result.current.status).toBe('connecting');
  });

  it('transitions to connected on WebSocket open', () => {
    const onUpdate = vi.fn();
    const { result } = renderHook(() =>
      useRealtimeUpdates({ wsUrl: 'ws://localhost:9000', onUpdate })
    );
    act(() => { MockWebSocket.instances[0].simulateOpen(); });
    expect(result.current.status).toBe('connected');
  });

  it('calls onUpdate when WebSocket message received', () => {
    const onUpdate = vi.fn();
    renderHook(() =>
      useRealtimeUpdates({ wsUrl: 'ws://localhost:9000', onUpdate })
    );
    act(() => {
      MockWebSocket.instances[0].simulateOpen();
      MockWebSocket.instances[0].simulateMessage('{"type":"update"}');
    });
    expect(onUpdate).toHaveBeenCalledTimes(1);
  });

  it('falls back to polling on WebSocket error', () => {
    const onUpdate = vi.fn();
    const { result } = renderHook(() =>
      useRealtimeUpdates({ wsUrl: 'ws://localhost:9000', onUpdate, pollIntervalMs: 1000 })
    );
    act(() => { MockWebSocket.instances[0].simulateError(); });
    expect(result.current.status).toBe('polling');
  });

  it('falls back to polling on non-clean WebSocket close', () => {
    const onUpdate = vi.fn();
    const { result } = renderHook(() =>
      useRealtimeUpdates({ wsUrl: 'ws://localhost:9000', onUpdate, pollIntervalMs: 1000 })
    );
    act(() => { MockWebSocket.instances[0].simulateClose(1006); });
    expect(result.current.status).toBe('polling');
  });

  it('calls onUpdate on each poll interval', () => {
    const onUpdate = vi.fn();
    renderHook(() =>
      useRealtimeUpdates({ wsUrl: 'ws://localhost:9000', onUpdate, pollIntervalMs: 1000 })
    );
    act(() => { MockWebSocket.instances[0].simulateError(); });
    act(() => { vi.advanceTimersByTime(3000); });
    expect(onUpdate).toHaveBeenCalledTimes(3);
  });

  it('starts polling immediately when no wsUrl provided', () => {
    const onUpdate = vi.fn();
    const { result } = renderHook(() =>
      useRealtimeUpdates({ onUpdate, pollIntervalMs: 1000 })
    );
    expect(result.current.status).toBe('polling');
    act(() => { vi.advanceTimersByTime(2000); });
    expect(onUpdate).toHaveBeenCalledTimes(2);
  });

  it('reconnect restarts the connection', () => {
    const onUpdate = vi.fn();
    const { result } = renderHook(() =>
      useRealtimeUpdates({ wsUrl: 'ws://localhost:9000', onUpdate })
    );
    act(() => { MockWebSocket.instances[0].simulateOpen(); });
    expect(result.current.status).toBe('connected');

    act(() => { result.current.reconnect(); });
    expect(result.current.status).toBe('connecting');
    expect(MockWebSocket.instances.length).toBe(2);
  });

  it('cleans up on unmount', () => {
    const onUpdate = vi.fn();
    const { unmount } = renderHook(() =>
      useRealtimeUpdates({ onUpdate, pollIntervalMs: 500 })
    );
    unmount();
    act(() => { vi.advanceTimersByTime(2000); });
    // No calls after unmount
    expect(onUpdate).not.toHaveBeenCalled();
  });
});
