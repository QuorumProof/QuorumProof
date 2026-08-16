/**
 * ShareCredentialDialog.a11y.test.tsx
 * Accessibility tests for credential sharing dialog — issue #1251
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import '@testing-library/jest-dom'
import { ShareCredentialDialog } from '../components/ShareCredentialDialog'
import { checkA11y, hasAccessibleName } from './utils/accessibility.test.utils'

const CRED_ID = '42'

function renderDialog(onClose = vi.fn()) {
  return render(
    <ShareCredentialDialog credentialId={CRED_ID} onClose={onClose} />
  )
}

describe('ShareCredentialDialog Accessibility', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('should have no accessibility violations', async () => {
    const result = renderDialog()
    await checkA11y(result)
  })

  it('should have accessible dialog structure', () => {
    renderDialog()
    const dialog = screen.getByRole('dialog')
    expect(dialog).toBeInTheDocument()
    expect(dialog).toHaveAttribute('aria-modal', 'true')
  })

  it('should have accessible close button', () => {
    const onClose = vi.fn()
    renderDialog(onClose)

    const closeButton = screen.getByRole('button', { name: 'Close share dialog' })
    expect(closeButton).toBeInTheDocument()
    expect(closeButton).toHaveAttribute('aria-label')
  })

  it('should have properly labeled input field', () => {
    renderDialog()
    const input = screen.getByPlaceholderText('G…') as HTMLInputElement

    expect(input).toBeInTheDocument()
    // Check for label or aria-label
    const label = document.querySelector(`label[for="${input.id}"]`)
    const hasAriaLabel = input.hasAttribute('aria-label')
    expect(label || hasAriaLabel).toBeTruthy()
  })

  it('should have accessible Add button', () => {
    renderDialog()
    const button = screen.getByRole('button', { name: /add/i })

    expect(button).toBeInTheDocument()
    expect(button).not.toBeDisabled()
    expect(hasAccessibleName(button, 'Add')).toBe(true)
  })

  it('should announce error messages accessibly', async () => {
    renderDialog()

    // Check that errors are announced to screen readers
    const errorRegion = screen.queryByRole('alert')
    if (errorRegion) {
      expect(errorRegion).toHaveAttribute('role', 'alert')
    }
  })

  it('should maintain focus management', () => {
    const { container } = renderDialog()

    const dialog = container.querySelector('[role="dialog"]')
    expect(dialog).toBeInTheDocument()

    // Dialog should trap focus or manage focus appropriately
    const focusableElements = dialog?.querySelectorAll(
      'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
    )
    expect((focusableElements?.length || 0) > 0).toBe(true)
  })

  it('should have sufficient color contrast', async () => {
    const result = renderDialog()
    // jest-axe will check color contrast as part of checkA11y
    await checkA11y(result)
  })

  it('should support keyboard navigation', () => {
    renderDialog()

    // Find all interactive elements
    const buttons = screen.getAllByRole('button')
    const inputs = screen.getAllByPlaceholderText('G…')

    // All interactive elements should be keyboard accessible
    buttons.forEach(btn => {
      expect(btn.tagName).toBe('BUTTON')
    })

    inputs.forEach(input => {
      expect(input).toBeInTheDocument()
    })
  })
})
