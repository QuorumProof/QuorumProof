import { useEffect, useRef, useState } from 'react'

interface DashboardStats {
  issuances_per_minute: number[]
  attestation_success_rate: number | null
  errors_last_minute: number
  timestamp: string
}

const WS_URL = (typeof import.meta !== 'undefined' && (import.meta as any).env?.VITE_WS_URL) || 'ws://localhost:3000/ws'
const RECONNECT_DELAY_MS = 3000

type ConnectionState = 'connecting' | 'connected' | 'disconnected'

function Sparkline({ values, width = 240, height = 56 }: { values: number[]; width?: number; height?: number }) {
  if (values.length === 0) return null
  const max = Math.max(...values, 1)
  const pts = values.map((v, i) => {
    const x = (i / (values.length - 1)) * width
    const y = height - (v / max) * (height - 4)
    return `${x.toFixed(1)},${y.toFixed(1)}`
  })
  const fillPath =
    `M0,${height} L` +
    pts.join(' L') +
    ` L${width},${height} Z`

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
    pct === null ? 'var(--ld-muted)' :
    pct >= 95 ? 'var(--ld-success)' :
    pct >= 80 ? 'var(--ld-warn)' : 'var(--ld-error)'

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
  return (
    <span
      className={`live-dashboard__dot live-dashboard__dot--${state}`}
      aria-label={state}
      title={state}
    />
  )
}

export function LiveDashboard() {
  const [stats, setStats] = useState<DashboardStats | null>(null)
  const [connState, setConnState] = useState<ConnectionState>('connecting')
  const wsRef = useRef<WebSocket | null>(null)
  const reconnectTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const unmounted = useRef(false)

  function connect() {
    if (unmounted.current) return
    setConnState('connecting')
    const ws = new WebSocket(WS_URL)
    wsRef.current = ws

    ws.onopen = () => {
      setConnState('connected')
      ws.send(JSON.stringify({ type: 'subscribe_dashboard' }))
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

    ws.onclose = () => {
      if (unmounted.current) return
      setConnState('disconnected')
      reconnectTimer.current = setTimeout(connect, RECONNECT_DELAY_MS)
    }

    ws.onerror = () => {
      ws.close()
    }
  }

  useEffect(() => {
    connect()
    return () => {
      unmounted.current = true
      if (reconnectTimer.current) clearTimeout(reconnectTimer.current)
      wsRef.current?.close()
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const currentIssuanceRate = stats ? stats.issuances_per_minute[stats.issuances_per_minute.length - 1] : 0
  const lastUpdated = stats ? new Date(stats.timestamp).toLocaleTimeString() : '—'

  return (
    <div className="live-dashboard" aria-label="Live credential issuance dashboard">
      <div className="live-dashboard__header">
        <h2 className="live-dashboard__title">Live Dashboard</h2>
        <div className="live-dashboard__status">
          <StatusDot state={connState} />
          <span className="live-dashboard__status-text">{connState}</span>
          {stats && <span className="live-dashboard__updated">updated {lastUpdated}</span>}
        </div>
      </div>

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
            {stats?.attestation_success_rate === null || stats?.attestation_success_rate === undefined
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
            style={{ color: (stats?.errors_last_minute ?? 0) > 0 ? 'var(--ld-error)' : undefined }}
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
