/**
 * NotificationCenter.a11y.test.tsx
 * Accessibility tests for NotificationCenter — issue #1454
 *
 * Mirrors the pattern used in ShareCredentialDialog.a11y.test.tsx.
 */

import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import '@testing-library/jest-dom'
import { NotificationCenter } from '../components/NotificationCenter'
import { NotificationContext } from '../context/NotificationContextValue'
import type { NotificationContextValue, Notification } from '../context/NotificationContextValue'
import { checkA11y } from './utils/accessibility.test.utils'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeNotification(overrides: Partial<Notification> = {}): Notification {
  return {
    id: crypto.randomUUID(),
    title: 'Attestation received',
    message: 'Your credential has been attested.',
    type: 'success',
    timestamp: new Date(),
    read: false,
    ...overrides,
  }
}

function makeContextValue(
  overrides: Partial<NotificationContextValue> = {}
): NotificationContextValue {
  return {
    notifications: [],
    preferences: { issued: true, revoked: true, verified: true, disputed: true },
    addNotification: vi.fn(),
    notifyCredentialIssued: vi.fn(),
    notifyCredentialRevoked: vi.fn(),
    notifyCredentialVerified: vi.fn(),
    notifyCredentialDisputed: vi.fn(),
    markAsRead: vi.fn(),
    markAllAsRead: vi.fn(),
    removeNotification: vi.fn(),
    clearAll: vi.fn(),
    updatePreferences: vi.fn(),
    unreadCount: 0,
    ...overrides,
  }
}

function renderCenter(ctxOverrides: Partial<NotificationContextValue> = {}) {
  const ctx = makeContextValue(ctxOverrides)
  return render(
    <NotificationContext.Provider value={ctx}>
      <NotificationCenter />
    </NotificationContext.Provider>
  )
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('NotificationCenter — accessibility (#1454)', () => {
  it('has no axe violations when closed (empty)', async () => {
    const result = renderCenter()
    await checkA11y(result)
  })

  it('has no axe violations when open with notifications', async () => {
    const notifications = [
      makeNotification({ type: 'success' }),
      makeNotification({ type: 'error', title: 'Credential revoked', message: 'Revoked.' }),
      makeNotification({ type: 'warning', title: 'Threshold low', message: 'Only 1 of 3.' }),
      makeNotification({ type: 'info', title: 'Update available', message: 'New version.' }),
    ]
    const result = renderCenter({ notifications, unreadCount: 4 })

    // Open the panel
    fireEvent.click(screen.getByRole('button', { name: /notifications/i }))

    await checkA11y(result)
  })

  it('bell button has accessible name when there are no unread notifications', () => {
    renderCenter()
    const bell = screen.getByRole('button', { name: 'Notifications' })
    expect(bell).toBeInTheDocument()
  })

  it('bell button includes unread count in accessible name', () => {
    renderCenter({ unreadCount: 3 })
    const bell = screen.getByRole('button', { name: 'Notifications, 3 unread' })
    expect(bell).toBeInTheDocument()
  })

  it('unread badge has an accessible label', () => {
    renderCenter({ unreadCount: 5 })
    const badge = screen.getByLabelText('5 unread notifications')
    expect(badge).toBeInTheDocument()
  })

  it('unread badge uses singular label for exactly 1 unread', () => {
    renderCenter({ unreadCount: 1 })
    const badge = screen.getByLabelText('1 unread notification')
    expect(badge).toBeInTheDocument()
  })

  it('type icons have role="img" and an accessible label', () => {
    const notifications = [
      makeNotification({ type: 'success' }),
      makeNotification({ type: 'error', title: 'Error notif', message: 'err' }),
      makeNotification({ type: 'warning', title: 'Warn notif', message: 'warn' }),
      makeNotification({ type: 'info', title: 'Info notif', message: 'info' }),
    ]
    renderCenter({ notifications, unreadCount: 4 })
    fireEvent.click(screen.getByRole('button', { name: /notifications/i }))

    expect(screen.getByRole('img', { name: 'Success' })).toBeInTheDocument()
    expect(screen.getByRole('img', { name: 'Error' })).toBeInTheDocument()
    expect(screen.getByRole('img', { name: 'Warning' })).toBeInTheDocument()
    expect(screen.getByRole('img', { name: 'Info' })).toBeInTheDocument()
  })

  it('dismiss buttons have descriptive accessible labels', () => {
    const notif = makeNotification({ title: 'Attestation received' })
    renderCenter({ notifications: [notif], unreadCount: 1 })
    fireEvent.click(screen.getByRole('button', { name: /notifications/i }))

    const dismiss = screen.getByRole('button', {
      name: 'Dismiss notification: Attestation received',
    })
    expect(dismiss).toBeInTheDocument()
  })

  it('panel has a live region (role=alert) for in-panel announcements', () => {
    const notifications = [makeNotification()]
    renderCenter({ notifications, unreadCount: 1 })
    fireEvent.click(screen.getByRole('button', { name: /notifications/i }))

    // The notification list itself is the alert live region
    const alertRegion = screen.getByRole('alert')
    expect(alertRegion).toBeInTheDocument()
  })

  it('there is a polite live region (role=status) for out-of-panel announcements', () => {
    renderCenter()
    const statusRegion = screen.getByRole('status')
    expect(statusRegion).toBeInTheDocument()
  })

  it('bell button exposes aria-expanded state', () => {
    renderCenter()
    const bell = screen.getByRole('button', { name: /notifications/i })
    expect(bell).toHaveAttribute('aria-expanded', 'false')

    fireEvent.click(bell)
    expect(bell).toHaveAttribute('aria-expanded', 'true')
  })
})
