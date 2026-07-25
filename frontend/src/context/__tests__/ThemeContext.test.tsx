import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { ThemeProvider } from '../ThemeContext';
import { useTheme, type ThemeMode } from '../ThemeContextValue';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TestConsumer = () => {
  const { preference, resolvedTheme, setTheme, toggleTheme } = useTheme();
  return (
    <div>
      <span data-testid="preference">{preference}</span>
      <span data-testid="resolved">{resolvedTheme}</span>
      <button data-testid="toggle" onClick={toggleTheme}>
        Toggle
      </button>
      <button data-testid="set-light" onClick={() => setTheme('light')}>
        Light
      </button>
      <button data-testid="set-dark" onClick={() => setTheme('dark')}>
        Dark
      </button>
      <button data-testid="set-system" onClick={() => setTheme('system')}>
        System
      </button>
    </div>
  );
};

function renderWithTheme(defaultPreference?: ThemeMode) {
  return render(
    <ThemeProvider defaultPreference={defaultPreference}>
      <TestConsumer />
    </ThemeProvider>,
  );
}

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

// Mock matchMedia — default: system prefers dark
function mockMatchMedia(prefersDark: boolean) {
  const listeners: Array<(e: MediaQueryListEvent) => void> = [];
  const mql = {
    matches: prefersDark,
    addEventListener: vi.fn((_: string, cb: (e: MediaQueryListEvent) => void) => {
      listeners.push(cb);
    }),
    removeEventListener: vi.fn(),
    // Helper to simulate OS change
    _fireChange(newPrefersDark: boolean) {
      mql.matches = newPrefersDark;
      listeners.forEach((cb) =>
        cb({ matches: newPrefersDark } as MediaQueryListEvent),
      );
    },
  };
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: vi.fn().mockReturnValue(mql),
  });
  return mql;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ThemeContext', () => {
  beforeEach(() => {
    localStorage.clear();
    // Reset html classes
    document.documentElement.classList.remove('dark', 'light');
    document.documentElement.removeAttribute('data-theme');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // -------------------------------------------------------------------------
  // Initial state — system preference
  // -------------------------------------------------------------------------

  describe('initial state', () => {
    it('defaults to "system" preference when no localStorage entry exists', () => {
      mockMatchMedia(true);
      renderWithTheme();
      expect(screen.getByTestId('preference').textContent).toBe('system');
    });

    it('resolves to "dark" when system prefers dark and preference is "system"', () => {
      mockMatchMedia(true);
      renderWithTheme();
      expect(screen.getByTestId('resolved').textContent).toBe('dark');
    });

    it('resolves to "light" when system prefers light and preference is "system"', () => {
      mockMatchMedia(false);
      renderWithTheme();
      expect(screen.getByTestId('resolved').textContent).toBe('light');
    });

    it('restores preference from localStorage', () => {
      localStorage.setItem('quorum-proof-theme', 'light');
      mockMatchMedia(true); // system prefers dark, but stored pref wins
      renderWithTheme();
      expect(screen.getByTestId('preference').textContent).toBe('light');
      expect(screen.getByTestId('resolved').textContent).toBe('light');
    });

    it('ignores invalid localStorage values and falls back to "system"', () => {
      localStorage.setItem('quorum-proof-theme', 'invalid-value');
      mockMatchMedia(false);
      renderWithTheme();
      expect(screen.getByTestId('preference').textContent).toBe('system');
    });
  });

  // -------------------------------------------------------------------------
  // DOM class application
  // -------------------------------------------------------------------------

  describe('DOM class application', () => {
    it('adds "dark" class to <html> when resolved theme is dark', () => {
      mockMatchMedia(true);
      renderWithTheme('dark');
      expect(document.documentElement.classList.contains('dark')).toBe(true);
      expect(document.documentElement.classList.contains('light')).toBe(false);
    });

    it('adds "light" class to <html> when resolved theme is light', () => {
      mockMatchMedia(false);
      renderWithTheme('light');
      expect(document.documentElement.classList.contains('light')).toBe(true);
      expect(document.documentElement.classList.contains('dark')).toBe(false);
    });

    it('sets data-theme attribute to match resolved theme', () => {
      mockMatchMedia(true);
      renderWithTheme('dark');
      expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
    });

    it('switches class when theme changes', () => {
      mockMatchMedia(true);
      renderWithTheme('dark');
      expect(document.documentElement.classList.contains('dark')).toBe(true);

      fireEvent.click(screen.getByTestId('set-light'));

      expect(document.documentElement.classList.contains('light')).toBe(true);
      expect(document.documentElement.classList.contains('dark')).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // setTheme
  // -------------------------------------------------------------------------

  describe('setTheme', () => {
    it('sets preference to "light" and persists to localStorage', () => {
      mockMatchMedia(true);
      renderWithTheme();
      fireEvent.click(screen.getByTestId('set-light'));
      expect(screen.getByTestId('preference').textContent).toBe('light');
      expect(screen.getByTestId('resolved').textContent).toBe('light');
      expect(localStorage.getItem('quorum-proof-theme')).toBe('light');
    });

    it('sets preference to "dark" and persists to localStorage', () => {
      mockMatchMedia(false);
      renderWithTheme();
      fireEvent.click(screen.getByTestId('set-dark'));
      expect(screen.getByTestId('preference').textContent).toBe('dark');
      expect(screen.getByTestId('resolved').textContent).toBe('dark');
      expect(localStorage.getItem('quorum-proof-theme')).toBe('dark');
    });

    it('sets preference to "system" and re-follows system preference', () => {
      mockMatchMedia(true); // system = dark
      renderWithTheme('light'); // start with explicit light

      fireEvent.click(screen.getByTestId('set-system'));

      expect(screen.getByTestId('preference').textContent).toBe('system');
      expect(screen.getByTestId('resolved').textContent).toBe('dark');
      expect(localStorage.getItem('quorum-proof-theme')).toBe('system');
    });
  });

  // -------------------------------------------------------------------------
  // toggleTheme
  // -------------------------------------------------------------------------

  describe('toggleTheme', () => {
    it('toggles from dark to light', () => {
      mockMatchMedia(false); // system = light, irrelevant when explicit
      renderWithTheme('dark');
      fireEvent.click(screen.getByTestId('toggle'));
      expect(screen.getByTestId('resolved').textContent).toBe('light');
      expect(screen.getByTestId('preference').textContent).toBe('light');
    });

    it('toggles from light to dark', () => {
      mockMatchMedia(false);
      renderWithTheme('light');
      fireEvent.click(screen.getByTestId('toggle'));
      expect(screen.getByTestId('resolved').textContent).toBe('dark');
      expect(screen.getByTestId('preference').textContent).toBe('dark');
    });

    it('when preference is "system" (dark), toggle produces explicit "light"', () => {
      mockMatchMedia(true); // system = dark
      renderWithTheme('system');
      fireEvent.click(screen.getByTestId('toggle'));
      expect(screen.getByTestId('preference').textContent).toBe('light');
      expect(screen.getByTestId('resolved').textContent).toBe('light');
    });

    it('persists toggled value to localStorage', () => {
      mockMatchMedia(false);
      renderWithTheme('dark');
      fireEvent.click(screen.getByTestId('toggle'));
      expect(localStorage.getItem('quorum-proof-theme')).toBe('light');
    });
  });

  // -------------------------------------------------------------------------
  // System preference change listener
  // -------------------------------------------------------------------------

  describe('system preference change listener', () => {
    it('updates resolved theme when OS switches to dark', () => {
      const mql = mockMatchMedia(false); // start: system = light
      renderWithTheme('system');
      expect(screen.getByTestId('resolved').textContent).toBe('light');

      act(() => {
        mql._fireChange(true); // OS switches to dark
      });

      expect(screen.getByTestId('resolved').textContent).toBe('dark');
    });

    it('does NOT update resolved theme when explicit preference overrides system', () => {
      const mql = mockMatchMedia(false);
      renderWithTheme('light'); // explicit light
      expect(screen.getByTestId('resolved').textContent).toBe('light');

      act(() => {
        mql._fireChange(true); // OS switches to dark
      });

      // Resolved should remain light because the user chose explicitly
      expect(screen.getByTestId('resolved').textContent).toBe('light');
    });
  });

  // -------------------------------------------------------------------------
  // defaultPreference prop (used in tests)
  // -------------------------------------------------------------------------

  describe('defaultPreference prop', () => {
    it('uses provided defaultPreference over localStorage', () => {
      localStorage.setItem('quorum-proof-theme', 'dark');
      mockMatchMedia(false);
      renderWithTheme('light');
      expect(screen.getByTestId('preference').textContent).toBe('light');
    });
  });
});
