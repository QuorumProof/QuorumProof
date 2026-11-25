import tseslint from 'typescript-eslint';

/**
 * api-server lint configuration.
 *
 * Intentionally minimal: this config exists so server code cannot silently
 * fall back to `console.log` (issue #1980).  All server logging must go
 * through `src/services/logger.ts`, which attaches the service name, request
 * IDs and metadata redaction.
 *
 * `console.warn` / `console.error` are still allowed here because a number of
 * pre-existing call sites outside the scope of #1980 use them; they can be
 * migrated and the allow-list tightened separately.
 */
export default tseslint.config(
  {
    ignores: ['dist/**', 'node_modules/**', 'coverage/**'],
  },
  {
    files: ['src/**/*.ts'],
    languageOptions: {
      parser: tseslint.parser,
      ecmaVersion: 2022,
      sourceType: 'module',
    },
    rules: {
      'no-console': ['error', { allow: ['warn', 'error'] }],
    },
  },
  {
    // Operator-facing migration CLI: terminal output is its user interface.
    files: ['src/migrations/cli.ts'],
    rules: {
      'no-console': 'off',
    },
  },
);
