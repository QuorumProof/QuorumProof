import { useEffect, useRef, useCallback, useState } from 'react';

export type ConnectionStatus = 'connecting' | 'connected' | 'polling' | 'disconnected';

export interface RealtimeOptions {
  /** WebSocket URL. If omitted, falls back directly to polling. */
  wsUrl?: string;
  /** Polling interval in ms (default: 15000) */
  pollIntervalMs?: number;
  /** Called whenever an update event arrives (WS message or poll tick) */
  onUpdate: () => void;
}

interface RealtimeState {
  wsUrl?: string;
  pollIntervalMs: number;
  status: ConnectionStatus;
}

/**
 * useRealtimeUpdates — WebSocket connection with automatic polling fallback.
 *
 * Tries to open a WebSocket. If the connection fails or is unavailable,
 * falls back to polling at `pollIntervalMs` intervals.
 */
export function useRealtimeUpdates({
  wsUrl,
  pollIntervalMs = 15_000,
  onUpdate,
}: RealtimeOptions): { status: ConnectionStatus; reconnect: () => void } {
  const [realtimeState, setRealtimeState] = useState<RealtimeState>(() => ({
    wsUrl,
    pollIntervalMs,
    status: wsUrl ? 'connecting' : 'polling',
  }));
  const status =
    realtimeState.wsUrl === wsUrl && realtimeState.pollIntervalMs === pollIntervalMs
      ? realtimeState.status
      : wsUrl
        ? 'connecting'
        : 'polling';
  const updateStatus = useCallback(
    (nextStatus: ConnectionStatus) => setRealtimeState({ wsUrl, pollIntervalMs, status: nextStatus }),
    [wsUrl, pollIntervalMs]
  );
  const wsRef = useRef<WebSocket | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const onUpdateRef = useRef(onUpdate);
  useEffect(() => {
    onUpdateRef.current = onUpdate;
  }, [onUpdate]);

  const stopPolling = useCallback(() => {
    if (pollRef.current !== null) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }, []);

  const setupPolling = useCallback(() => {
    stopPolling();
    pollRef.current = setInterval(() => {
      onUpdateRef.current();
    }, pollIntervalMs);
  }, [pollIntervalMs, stopPolling]);

  const startPolling = useCallback(() => {
    setupPolling();
    updateStatus('polling');
  }, [setupPolling, updateStatus]);

  const closeWs = useCallback(() => {
    if (wsRef.current) {
      wsRef.current.onopen = null;
      wsRef.current.onmessage = null;
      wsRef.current.onerror = null;
      wsRef.current.onclose = null;
      wsRef.current.close();
      wsRef.current = null;
    }
  }, []);

  const connect = useCallback(() => {
    closeWs();
    stopPolling();

    if (!wsUrl) {
      setupPolling();
      return;
    }

    try {
      const ws = new WebSocket(wsUrl);
      wsRef.current = ws;

      ws.onopen = () => {
        updateStatus('connected');
        stopPolling();
      };

      ws.onmessage = () => {
        onUpdateRef.current();
      };

      ws.onerror = () => {
        // Fall back to polling on error
        closeWs();
        startPolling();
      };

      ws.onclose = (ev) => {
        // Only fall back if not a clean close initiated by us
        if (ev.code !== 1000) {
          startPolling();
        } else {
          updateStatus('disconnected');
        }
      };
    } catch {
      setupPolling();
      queueMicrotask(() => updateStatus('polling'));
    }
  }, [wsUrl, closeWs, stopPolling, setupPolling, startPolling, updateStatus]);

  const reconnect = useCallback(() => {
    updateStatus(wsUrl ? 'connecting' : 'polling');
    connect();
  }, [connect, updateStatus, wsUrl]);

  useEffect(() => {
    connect();
    return () => {
      closeWs();
      stopPolling();
    };
  }, [connect, closeWs, stopPolling]);

  return { status, reconnect };
}
