import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest'
import { render, screen, fireEvent, act } from '@testing-library/react'
import { LiveDashboard, calcBackoff } from '../components/LiveDashboard'

// ---------------------------------------------------------------------------
// WebSocket mock
// ---------------------------------------------------------------------------

type WsListener = (ev: Partial<CloseEvent | MessageEvent | Event>) => void

interface MockWsInstance {
  onopen: WsListener | null
  onclose: WsListener | null
  onerror: WsListener | null
  onmessage: WsListener | null
  send: Mock
  close: Mock
  readyState: number
  // Test helpers
  simulateOpen: () => void
  simulateMessage: (data: unknown) => void
  simulateClose: (code?: number) => void
  simulateError: () => void
}

let lastWs: MockWsInstance | null = null
const MockWebSocket = vi.fn(function (this: MockWsInstance) {
  this.onopen = null
  this.onclose = null
  this.onerror = null
  this.onmessage = null
  this.readyState = 0 // CONNECTING
  this.send = vi.fn()
  this.close = vi.fn().mockImplementation(() => {
    this.readyState = 3
    this.onclose?.({ code: 1000 })
  })

  this.simulateOpen = () => {
    this.readyState = 1
    this.onopen?.({})
  }
  this.simulateMessage = (data: unknown) => {
    this.onmessage?.({ data: JSON.stringify(data) } as MessageEvent)
  }
  this.simulateClose = (code = 1006) => {
    this.readyState = 3
    this.onclose?.({ code } as CloseEvent)
  }
  this.simulateError = () => {
    this.onerror?.({})
  }

  // eslint-disable-next-line @typescript-eslint/no-this-alias
  lastWs = this
})

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  lastWs = null
  vi.useFakeTimers()
  vi.stubGlobal('WebSocket', MockWebSocket)
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})

function ws(): MockWsInstance {
  if (!lastWs) throw new Error('No WebSocket instance created yet')
  return lastWs
}

// ---------------------------------------------------------------------------
// calcBackoff unit tests
// ---------------------------------------------------------------------------

describe('calcBackoff', () => {
  it('returns a value in [0, 3000) for attempt 0', () => {
    for (let i = 0; i < 50; i++) {
      const v = calcBackoff(0)
      expect(v).toBeGreaterThanOrEqual(0)
      expect(v).toBeLessThan(3_000)
    }
  })

  it('caps at BACKOFF_MAX_MS (30 000) for large attempt counts', () => {
    for (let i = 0; i < 50; i++) {
      const v = calcBackoff(100)
      expect(v).toBeGreaterThanOrEqual(0)
      expect(v).toBeLessThanOrEqual(30_000)
    }
  })

  it('returns higher values (on average) for higher attempt numbers', () => {
    // Statistical: average of 200 samples should be higher at attempt 5 vs 0
    const avg = (n: number) =>
      Array.from({ length: 200 }, () => calcBackoff(n)).reduce((a, b) => a + b, 0) / 200
    expect(avg(5)).toBeGreaterThan(avg(0))
  })
})

// ---------------------------------------------------------------------------
// Connection state transitions
// ---------------------------------------------------------------------------

describe('LiveDashboard connection states', () => {
  it('shows "connecting…" on initial mount', () => {
    render(<LiveDashboard />)
    expect(screen.getByText(/connecting/i)).toBeInTheDocument()
  })

  it('transitions to "connected" after WebSocket opens', () => {
    render(<LiveDashboard />)
    act(() => ws().simulateOpen())
    expect(screen.getByText('connected')).toBeInTheDocument()
  })

  it('sends subscribe_dashboard message on open', () => {
    render(<LiveDashboard />)
    act(() => ws().simulateOpen())
    expect(ws().send).toHaveBeenCalled()
    const payload = JSON.parse(ws().send.mock.calls[0][0])
    expect(payload.type).toBe('subscribe_dashboard')
  })

  it('transitions to disconnected and shows retry info on close', () => {
    render(<LiveDashboard />)
    act(() => ws().simulateOpen())
    act(() => ws().simulateClose())
    expect(screen.getByText(/disconnected/i)).toBeInTheDocument()
    // attempt count should be visible in status text
    expect(screen.getByText(/attempt 1/i)).toBeInTheDocument()
  })

  it('shows "Not authorized" on auth-rejection close code 4401', () => {
    render(<LiveDashboard />)
    act(() => ws().simulateOpen())
    act(() => ws().simulateClose(4401))
    expect(screen.getByText(/not authorized/i)).toBeInTheDocument()
    // Auth error banner is also present
    expect(screen.getByRole('alert')).toHaveTextContent(/authorization failed/i)
  })

  it('does not schedule reconnect after auth rejection', () => {
    render(<LiveDashboard />)
    act(() => ws().simulateOpen())
    const beforeCount = MockWebSocket.mock.instances.length
    act(() => ws().simulateClose(4401))

    // Advance time well past max backoff — no new WS should be created
    act(() => vi.advanceTimersByTime(60_000))
    expect(MockWebSocket.mock.instances.length).toBe(beforeCount)
  })

  it('closes the WebSocket on unmount', () => {
    const { unmount } = render(<LiveDashboard />)
    const instance = ws()
    unmount()
    expect(instance.close).toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// Message parsing
// ---------------------------------------------------------------------------

describe('LiveDashboard message parsing', () => {
  it('renders issuance rate from dashboard_stats message', () => {
    render(<LiveDashboard />)
    act(() => ws().simulateOpen())
    act(() =>
      ws().simulateMessage({
        type: 'dashboard_stats',
        data: {
          issuances_per_minute: [1, 2, 3, 7],
          attestation_success_rate: 0.95,
          errors_last_minute: 0,
          timestamp: new Date().toISOString(),
        },
      })
    )
    // Last value in the array is 7
    expect(screen.getByText('7')).toBeInTheDocument()
  })

  it('renders attestation success rate', () => {
    render(<LiveDashboard />)
    act(() => ws().simulateOpen())
    act(() =>
      ws().simulateMessage({
        type: 'dashboard_stats',
        data: {
          issuances_per_minute: [1],
          attestation_success_rate: 0.87,
          errors_last_minute: 0,
          timestamp: new Date().toISOString(),
        },
      })
    )
    // 87% appears in both the card value and the rate bar label
    expect(screen.getAllByText('87%').length).toBeGreaterThanOrEqual(1)
  })

  it('ignores malformed (non-JSON) frames without crashing', () => {
    render(<LiveDashboard />)
    act(() => ws().simulateOpen())
    act(() => {
      ws().onmessage?.({ data: 'not-valid-json{{{{' } as MessageEvent)
    })
    // Should still be in connected state
    expect(screen.getByText('connected')).toBeInTheDocument()
  })

  it('ignores unknown message types', () => {
    render(<LiveDashboard />)
    act(() => ws().simulateOpen())
    act(() => ws().simulateMessage({ type: 'unknown_event', data: {} }))
    // Stats remain null — issuances/min and errors/min both show 0
    expect(screen.getByText('connected')).toBeInTheDocument()
    expect(screen.getAllByText('0').length).toBeGreaterThanOrEqual(1)
  })
})

// ---------------------------------------------------------------------------
// Reconnect / backoff behaviour
// ---------------------------------------------------------------------------

describe('LiveDashboard reconnect backoff', () => {
  it('reconnects after backoff delay on close', () => {
    render(<LiveDashboard />)
    act(() => ws().simulateOpen())
    const firstWs = ws()
    act(() => firstWs.simulateClose())

    const countBefore = MockWebSocket.mock.instances.length

    // Advance time past max possible backoff
    act(() => vi.advanceTimersByTime(35_000))

    // A new WebSocket should have been created
    expect(MockWebSocket.mock.instances.length).toBeGreaterThan(countBefore)
  })

  it('resets attempt count to 0 after successful reconnect', () => {
    render(<LiveDashboard />)
    // First connection + close
    act(() => ws().simulateOpen())
    act(() => ws().simulateClose())
    expect(screen.getByText(/attempt 1/i)).toBeInTheDocument()

    // Advance time so reconnect fires
    act(() => vi.advanceTimersByTime(35_000))

    // New WS opens successfully
    act(() => ws().simulateOpen())

    // Attempt count should be gone (reset to 0, state = connected)
    expect(screen.getByText('connected')).toBeInTheDocument()
    expect(screen.queryByText(/attempt/i)).not.toBeInTheDocument()
  })

  it('shows "Retry now" button after max attempts are exhausted', () => {
    // Force all backoffs to be very small so we can advance past them quickly
    vi.spyOn(Math, 'random').mockReturnValue(0)

    render(<LiveDashboard />)

    // First open establishes connection; then disconnect starts the attempt cycle
    act(() => ws().simulateOpen())

    // Exhaust 10 attempts: for each, advance past the backoff (0ms with random=0),
    // then the reconnect fires, creating a new WS; close it immediately without opening.
    for (let i = 0; i < 10; i++) {
      act(() => ws().simulateClose())
      // random=0 means backoff=0, so advancing 1ms fires the reconnect timer
      act(() => vi.advanceTimersByTime(1))
    }

    // After 10 attempts (> BACKOFF_MAX_ATTEMPTS=10 requires attempt 11)
    // Actually BACKOFF_MAX_ATTEMPTS=10, condition is attempt > 10, so we need 11 closes
    act(() => ws().simulateClose())

    // Now attempt=11 > 10, no auto-retry → "Retry now" button should appear
    expect(screen.getByText(/retry now/i)).toBeInTheDocument()

    vi.restoreAllMocks()
  })
})
