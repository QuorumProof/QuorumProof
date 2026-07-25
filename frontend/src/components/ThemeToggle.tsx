import { useTheme } from '../context/ThemeContextValue';

interface ThemeToggleProps {
  /** Additional CSS classes to apply to the button. */
  className?: string;
}

/**
 * A button that toggles between light and dark mode.
 * Shows a sun icon in dark mode and a moon icon in light mode.
 */
export function ThemeToggle({ className = '' }: ThemeToggleProps) {
  const { resolvedTheme, toggleTheme, preference } = useTheme();
  const isDark = resolvedTheme === 'dark';

  const label = isDark ? 'Switch to light mode' : 'Switch to dark mode';
  const icon = isDark ? '☀️' : '🌙';
  const prefLabel =
    preference === 'system' ? ' (auto)' : '';

  return (
    <button
      type="button"
      onClick={toggleTheme}
      aria-label={label}
      title={`${label}${prefLabel}`}
      className={[
        // Base styles shared across both themes
        'inline-flex items-center justify-center',
        'w-8 h-8 rounded-lg',
        'text-sm transition-colors duration-200',
        // Light mode colours
        'bg-slate-100 hover:bg-slate-200 text-slate-700',
        // Dark mode colours
        'dark:bg-slate-700 dark:hover:bg-slate-600 dark:text-slate-200',
        'focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500',
        className,
      ]
        .filter(Boolean)
        .join(' ')}
      data-testid="theme-toggle"
    >
      <span aria-hidden="true">{icon}</span>
    </button>
  );
}
