import { useState, useEffect, useCallback, type ReactNode } from 'react';
import { ThemeContext, type ThemeMode } from './ThemeContextValue';

const STORAGE_KEY = 'quorum-proof-theme';

function getSystemPreference(): 'light' | 'dark' {
  if (typeof window !== 'undefined' && window.matchMedia) {
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }
  return 'dark';
}

function loadStoredPreference(): ThemeMode | null {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored === 'light' || stored === 'dark' || stored === 'system') {
      return stored;
    }
    return null;
  } catch {
    return null;
  }
}

function savePreference(mode: ThemeMode): void {
  try {
    localStorage.setItem(STORAGE_KEY, mode);
  } catch {
    // Silently ignore storage errors (e.g. private browsing quota)
  }
}

function applyTheme(resolved: 'light' | 'dark'): void {
  const root = document.documentElement;
  if (resolved === 'dark') {
    root.classList.add('dark');
    root.classList.remove('light');
  } else {
    root.classList.add('light');
    root.classList.remove('dark');
  }
  root.setAttribute('data-theme', resolved);
}

interface ThemeProviderProps {
  children: ReactNode;
  /** Override default initial preference (useful in tests). */
  defaultPreference?: ThemeMode;
}

export function ThemeProvider({ children, defaultPreference }: ThemeProviderProps) {
  const [preference, setPreference] = useState<ThemeMode>(() => {
    if (defaultPreference) return defaultPreference;
    return loadStoredPreference() ?? 'system';
  });

  const [systemPreference, setSystemPreference] = useState<'light' | 'dark'>(
    getSystemPreference,
  );

  // Derive the resolved theme from preference + system
  const resolvedTheme: 'light' | 'dark' =
    preference === 'system' ? systemPreference : preference;

  // Apply the dark/light class to <html> whenever resolvedTheme changes
  useEffect(() => {
    applyTheme(resolvedTheme);
  }, [resolvedTheme]);

  // Listen for OS-level dark mode changes when preference is 'system'
  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return;

    const mq = window.matchMedia('(prefers-color-scheme: dark)');

    function handleChange(e: MediaQueryListEvent) {
      setSystemPreference(e.matches ? 'dark' : 'light');
    }

    mq.addEventListener('change', handleChange);
    return () => mq.removeEventListener('change', handleChange);
  }, []);

  const setTheme = useCallback((mode: ThemeMode) => {
    setPreference(mode);
    savePreference(mode);
  }, []);

  const toggleTheme = useCallback(() => {
    setPreference((prev) => {
      // Toggling always produces an explicit light/dark choice.
      // If current resolved is dark, switch to light; otherwise switch to dark.
      const next: ThemeMode =
        (prev === 'system' ? systemPreference : prev) === 'dark' ? 'light' : 'dark';
      savePreference(next);
      return next;
    });
  }, [systemPreference]);

  return (
    <ThemeContext.Provider value={{ preference, resolvedTheme, setTheme, toggleTheme }}>
      {children}
    </ThemeContext.Provider>
  );
}
