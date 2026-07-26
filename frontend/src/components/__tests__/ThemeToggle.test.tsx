import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ThemeToggle } from '../ThemeToggle';
import { ThemeProvider } from '../../context/ThemeContext';
import type { ThemeMode } from '../../context/ThemeContextValue';

// Mock matchMedia
function mockMatchMedia(prefersDark: boolean) {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: vi.fn().mockReturnValue({
      matches: prefersDark,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }),
  });
}

function renderToggle(defaultPreference?: ThemeMode) {
  return render(
    <ThemeProvider defaultPreference={defaultPreference}>
      <ThemeToggle />
    </ThemeProvider>,
  );
}

describe('ThemeToggle', () => {
  beforeEach(() => {
    localStorage.clear();
    document.documentElement.classList.remove('dark', 'light');
  });

  it('renders a button', () => {
    mockMatchMedia(true);
    renderToggle('dark');
    expect(screen.getByTestId('theme-toggle')).toBeTruthy();
  });

  it('shows sun icon (☀️) when in dark mode', () => {
    mockMatchMedia(true);
    renderToggle('dark');
    expect(screen.getByTestId('theme-toggle').textContent).toContain('☀️');
  });

  it('shows moon icon (🌙) when in light mode', () => {
    mockMatchMedia(false);
    renderToggle('light');
    expect(screen.getByTestId('theme-toggle').textContent).toContain('🌙');
  });

  it('has accessible aria-label in dark mode', () => {
    mockMatchMedia(true);
    renderToggle('dark');
    expect(screen.getByTestId('theme-toggle').getAttribute('aria-label')).toBe(
      'Switch to light mode',
    );
  });

  it('has accessible aria-label in light mode', () => {
    mockMatchMedia(false);
    renderToggle('light');
    expect(screen.getByTestId('theme-toggle').getAttribute('aria-label')).toBe(
      'Switch to dark mode',
    );
  });

  it('toggles to light mode when clicked in dark mode', () => {
    mockMatchMedia(true);
    renderToggle('dark');

    fireEvent.click(screen.getByTestId('theme-toggle'));

    // After toggle it should show the moon (we're now in light mode)
    expect(screen.getByTestId('theme-toggle').textContent).toContain('🌙');
  });

  it('toggles to dark mode when clicked in light mode', () => {
    mockMatchMedia(false);
    renderToggle('light');

    fireEvent.click(screen.getByTestId('theme-toggle'));

    expect(screen.getByTestId('theme-toggle').textContent).toContain('☀️');
  });

  it('applies custom className', () => {
    mockMatchMedia(true);
    render(
      <ThemeProvider defaultPreference="dark">
        <ThemeToggle className="custom-class" />
      </ThemeProvider>,
    );
    expect(screen.getByTestId('theme-toggle').className).toContain('custom-class');
  });
});
