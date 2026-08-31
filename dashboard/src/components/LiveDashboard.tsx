import { useEffect, useRef, useState, useCallback } from 'react'

interface DashboardStats {
  issuances_per_minute: number[]
  attestation_success_rate: number | null
  errors_last_minute: number
  timestamp: string
}

const WS_URL =
  (typeof import.meta !== 'undefined' && (import.meta as any).env?.VITE_WS_URL) ||
  'ws://localhost:3000/ws'

// Auth token from env — required by the server's /ws endpoint.
// Set VITE_DASHBOARD_TOKEN to a valid operator token before running.
const DASHBOARD_TOKEN =
  (typeof import.meta !== 'undefined' && (import.meta as any).env?.VITE_DASHBOARD_TOKEN) || ''

// Reconnect back-off parameters
const BACKOFF_BASE_MS = 3_000
const BACKOFF_MAX_MS = 30_000
const BACKOFF_MAX_ATTEMPTS = 10

// Auth-rejection close code sent by the API server
const WS_CLOSE_UNAUTHORIZED = 4401

/**
 * Compute exponential back-off with full jitter.
 * delay = rand(0, min(cap, base * 2^attempt))
 */
export function calcBackoff(attempt: number): number {
  const exp = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * Math.pow(2, attempt))
  return Math.floor(Math.random() * exp)
}

type ConnectionState = 'connecting' | 'connected' | 'disconnected' | 'auth_error'

function Sparkline({
  values,
  width = 240,
  height = 56,
}: {
  values: number[]
  width?: number
  height?: number
}) {
  if (values.length === 0) return null
  const max = Math.max(...values, 1)
  const pts = values.map((v, i) => {
    const x = (i / (values.length - 1)) * width
    const y = height - (v / max) * (height - 4)
    return `${x.toFixed(1)},${y.toFixed(1)}`
  })
  const fillPath = `M0,${height} L` + pts.join(' L') + ` L${width},${height} Z`

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      width={width}
      height={height}
      className="live-dashboard__sparkline"
      aria-hidden="true"
    >
      <defs>
        <linearGradient id="spark-fill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="var(--ld-accent)" stopOpacity="0.35" />
          <stop offset="100%" stopColor="var(--ld-accent)" stopOpacity="0.03" />
        </linearGradient>
      </defs>
      <path d={fillPath} fill="url(#spark-fill)" />
      <polyline
        points={pts.join(' ')}
        fill="none"
        stroke="var(--ld-accent)"
        strokeWidth="2"
        strokeLinejoin="round"
        strokeLinecap="round"
      />
    </svg>
  )
}

function RateBar({ value }: { value: number | null }) {
  const pct = value === null ? null : Math.round(value * 100)
  const color =
    pct === null
      ? 'var(--ld-muted)'
      : pct >= 95
      ? 'var(--ld-success)'
      : pct >= 80
      ? 'var(--ld-warn)'
      : 'var(--ld-error)'

  return (
    <div className="live-dashboard__rate-bar-wrap">
      <div
        className="live-dashboard__rate-bar"
        role="progressbar"
        aria-valuenow={pct ?? 0}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label="Attestation success rate"
      >
        <div
          className="live-dashboard__rate-bar-fill"
          style={{ width: `${pct ?? 0}%`, background: color }}
        />
      </div>
      <span className="live-dashboard__rate-label" style={{ color }}>
        {pct === null ? '—' : `${pct}%`}
      </span>
    </div>
  )
}

function StatusDot({ state }: { state: ConnectionState }) {
  // Map auth_error → disconnected dot for CSS class purposes
  const dotState = state === 'auth_error' ? 'disconnected' : state
  return (
    <span
      className={`live-dashboard__dot live-dashboard__dot--${dotState}`}
      aria-label={state}
      title={state}
    />
  )
}

/** Human-readable status label including back-off hint */
function statusLabel(
  state: ConnectionState,
  attempt: number,
  retryInMs: number | null
): string {
  if (state === 'auth_error') return 'Not authorized'
  if (state === 'connected') return 'connected'
  if (state === 'connecting') return 'connecting…'
  // disconnected
  if (retryInMs !== null && retryInMs > 0) {
    const secs = Math.ceil(retryInMs / 1000)
    return `disconnected (retry in ${secs}s, attempt ${attempt})`
  }
  return 'disconnected'
}

export function LiveDashboard() {
  const [stats, setStats] = useState<DashboardStats | null>(null)
  const [connState, setConnState] = useState<ConnectionState>('connecting')
  const [attempt, setAttempt] = useState(0)
  const [retryInMs, setRetryInMs] = useState<number | null>(null)

  const wsRef = useRef<WebSocket | null>(null)
  const reconnectTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const countdownTimer = useRef<ReturnType<typeof setInterval> | null>(null)
  const unmounted = useRef(false)
  // Holds current attempt count in a ref so closures inside connect() always
  // see the latest value without needing to be recreated.
  const attemptRef = useRef(0)

  const clearTimers = () => {
    if (reconnectTimer.current) {
      clearTimeout(reconnectTimer.current)
      reconnectTimer.current = null
    }
    if (countdownTimer.current) {
      clearInterval(countdownTimer.current)
      countdownTimer.current = null
    }
  }

  const scheduleReconnect = useCallback((currentAttempt: number) => {
    if (unmounted.current) return

    const delay = calcBackoff(currentAttempt)
    setRetryInMs(delay)

    // Tick the countdown every second
    const start = Date.now()
    countdownTimer.current = setInterval(() => {
      const remaining = delay - (Date.now() - start)
      if (remaining <= 0) {
        clearInterval(countdownTimer.current!)
        countdownTimer.current = null
        setRetryInMs(null)
      } else {
        setRetryInMs(remaining)
      }
    }, 1_000)

    reconnectTimer.current = setTimeout(() => {
      clearInterval(countdownTimer.current!)
      countdownTimer.current = null
      setRetryInMs(null)
      // eslint-disable-next-line @typescript-eslint/no-use-before-define
      connect()
    }, delay)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  function connect() {
    if (unmounted.current) return

    setConnState('connecting')
    const ws = new WebSocket(WS_URL)
    wsRef.current = ws

    ws.onopen = () => {
      if (unmounted.current) {
        ws.close()
        return
      }
      setConnState('connected')
      // Reset attempt counter on successful connection
      attemptRef.current = 0
      setAttempt(0)

      // Send subscription message with auth token
      ws.send(
        JSON.stringify({
          type: 'subscribe_dashboard',
          ...(DASHBOARD_TOKEN ? { token: DASHBOARD_TOKEN } : {}),
        })
      )
    }

    ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data as string)
        if (msg.type === 'dashboard_stats') {
          setStats(msg.data as DashboardStats)
        }
      } catch {
        // ignore malformed frames
      }
    }

    ws.onclose = (event) => {
      if (unmounted.current) return

      // Auth rejection — do not retry
      if (event.code === WS_CLOSE_UNAUTHORIZED) {
        setConnState('auth_error')
        return
      }

      setConnState('disconnected')

      const nextAttempt = attemptRef.current + 1
      attemptRef.current = nextAttempt
      setAttempt(nextAttempt)

      if (nextAttempt > BACKOFF_MAX_ATTEMPTS) {
        // Give up; user must click "Retry" manually
        setRetryInMs(null)
        return
      }

      scheduleReconnect(nextAttempt)
    }

    ws.onerror = () => {
      ws.close()
    }
  }

  /** Manual retry — resets attempt counter */
  const handleManualRetry = useCallback(() => {
    clearTimers()
    attemptRef.current = 0
    setAttempt(0)
    setRetryInMs(null)
    wsRef.current?.close()
    connect()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    connect()
    return () => {
      unmounted.current = true
      clearTimers()
      wsRef.current?.close()
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const currentIssuanceRate = stats
    ? stats.issuances_per_minute[stats.issuances_per_minute.length - 1]
    : 0
  const lastUpdated = stats ? new Date(stats.timestamp).toLocaleTimeString() : '—'
  const showManualRetry =
    (connState === 'disconnected' && attempt > BACKOFF_MAX_ATTEMPTS) ||
    (connState === 'disconnected' && retryInMs !== null && retryInMs > 10_000)

  const statusText = statusLabel(connState, attempt, retryInMs)

  return (
    <div className="live-dashboard" aria-label="Live credential issuance dashboard">
      <div className="live-dashboard__header">
        <h2 className="live-dashboard__title">Live Dashboard</h2>
        <div className="live-dashboard__status">
          <StatusDot state={connState} />
          <span className="live-dashboard__status-text">{statusText}</span>
          {stats && connState === 'connected' && (
            <span className="live-dashboard__updated">updated {lastUpdated}</span>
          )}
          {showManualRetry && (
            <button
              className="live-dashboard__retry-btn"
              onClick={handleManualRetry}
              aria-label="Retry WebSocket connection now"
            >
              Retry now
            </button>
          )}
        </div>
      </div>

      {connState === 'auth_error' && (
        <div className="live-dashboard__auth-error" role="alert">
          Authorization failed. Check that VITE_DASHBOARD_TOKEN is set correctly.
        </div>
      )}

      <div className="live-dashboard__grid">
        {/* Issuances per minute */}
        <div className="live-dashboard__card">
          <p className="live-dashboard__card-label">Issuances / min</p>
          <p className="live-dashboard__card-value" aria-live="polite">
            {currentIssuanceRate}
          </p>
          <Sparkline values={stats?.issuances_per_minute ?? Array(60).fill(0)} />
          <p className="live-dashboard__card-sub">last 60 minutes</p>
        </div>

        {/* Attestation success rate */}
        <div className="live-dashboard__card">
          <p className="live-dashboard__card-label">Attestation success rate</p>
          <p className="live-dashboard__card-value" aria-live="polite">
            {stats?.attestation_success_rate === null ||
            stats?.attestation_success_rate === undefined
              ? '—'
              : `${Math.round(stats.attestation_success_rate * 100)}%`}
          </p>
          <RateBar value={stats?.attestation_success_rate ?? null} />
          <p className="live-dashboard__card-sub">last 5 minutes</p>
        </div>

        {/* Error rate */}
        <div className="live-dashboard__card">
          <p className="live-dashboard__card-label">Errors / min</p>
          <p
            className="live-dashboard__card-value"
            style={{
              color:
                (stats?.errors_last_minute ?? 0) > 0 ? 'var(--ld-error)' : undefined,
            }}
            aria-live="polite"
          >
            {stats?.errors_last_minute ?? 0}
          </p>
          <p className="live-dashboard__card-sub">current minute</p>
        </div>
      </div>
    </div>
  )
}
