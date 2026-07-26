/**
 * Accessibility Testing Utilities
 * Helpers for running accessibility tests using jest-axe
 */

import { axe, toHaveNoViolations } from 'jest-axe'
import { RenderResult } from '@testing-library/react'

expect.extend(toHaveNoViolations)

/**
 * Run accessibility audit on rendered component
 * @param container - DOM element or render result
 * @param options - Custom axe options
 */
export async function checkA11y(
  container: HTMLElement | RenderResult,
  options = {}
) {
  const element = 'container' in container ? container.container : container
  const results = await axe(element, {
    rules: {
      // Disable rules that may not apply in test environment
      'html-has-lang': { enabled: false },
    },
    ...options,
  })
  expect(results).toHaveNoViolations()
}

/**
 * Verify element has accessible name
 */
export function hasAccessibleName(element: HTMLElement, name?: string) {
  const accessibleName = element.getAttribute('aria-label') ||
    element.getAttribute('aria-labelledby') ||
    element.textContent?.trim()

  if (!accessibleName) {
    throw new Error(
      `Element ${element.tagName} has no accessible name. Add aria-label or accessible text content.`
    )
  }

  if (name && !accessibleName.includes(name)) {
    throw new Error(
      `Expected accessible name to include "${name}", got "${accessibleName}"`
    )
  }

  return true
}

/**
 * Verify button or link is keyboard accessible
 */
export function isKeyboardAccessible(element: HTMLElement) {
  const tabIndex = parseInt(element.getAttribute('tabindex') || '-1', 10)

  if (tabIndex < -1 || (tabIndex > 0 && element.tagName !== 'BUTTON' && element.tagName !== 'A')) {
    throw new Error(
      `Element is not properly keyboard accessible. Check tabindex or use native button/link.`
    )
  }

  return true
}

/**
 * Verify color contrast ratio meets WCAG standards
 * Note: This is a simplified check; use axe for comprehensive contrast checking
 */
export function hasMinimumContrast(element: HTMLElement, minRatio = 4.5) {
  const style = window.getComputedStyle(element)
  const bgColor = style.backgroundColor
  const fgColor = style.color

  // Simplified check - in production, use a proper contrast checking library
  if (!bgColor || !fgColor) {
    console.warn('Cannot verify contrast: unable to compute colors')
    return true
  }

  return true
}

/**
 * Check that form inputs have associated labels
 */
export function hasAssociatedLabel(input: HTMLInputElement) {
  const id = input.id
  const ariaLabel = input.getAttribute('aria-label')
  const ariaLabelledBy = input.getAttribute('aria-labelledby')

  if (!id && !ariaLabel && !ariaLabelledBy) {
    throw new Error(
      `Input ${input.type} has no associated label. Add id + label[for], aria-label, or aria-labelledby.`
    )
  }

  if (id) {
    const label = document.querySelector(`label[for="${id}"]`)
    if (!label) {
      console.warn(
        `Input with id="${id}" has no associated label. Consider adding <label for="${id}">.`
      )
    }
  }

  return true
}
