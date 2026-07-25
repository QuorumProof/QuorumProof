import { createContext, useContext } from 'react';

export type ThemeMode = 'light' | 'dark' | 'system';

export interface ThemeState {
  /** The user's explicit preference ('light', 'dark', or 'system'). */
  preference: ThemeMode;
  /** The resolved theme actually applied to the UI (always 'light' or 'dark'). */
  resolvedTheme: 'light' | 'dark';
  /** Set an explicit theme preference. */
  setTheme: (mode: ThemeMode) => void;
  /** Toggle between light and dark (sets an explicit preference, clearing system). */
  toggleTheme: () => void;
}

export const ThemeContext = createContext<ThemeState>({
  preference: 'system',
  resolvedTheme: 'dark',
  setTheme: () => undefined,
  toggleTheme: () => undefined,
});

export function useTheme(): ThemeState {
  return useContext(ThemeContext);
}
