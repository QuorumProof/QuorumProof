/**
 * Sentry error tracking integration for QuorumProof.
 * Initialise once at app startup. No-ops gracefully when DSN is absent (dev/test).
 */

import * as Sentry from '@sentry/react';

export type ErrorCategory =
  | 'wallet'
  | 'contract'
  | 'network'
  | 'credential'
  | 'ui'
  | 'unknown';

export function initSentry(): void {
  const dsn = import.meta.env.VITE_SENTRY_DSN as string | undefined;
  if (!dsn) return; // silently skip in dev when DSN is not configured

  Sentry.init({
    dsn,
    environment: (import.meta.env.VITE_STELLAR_NETWORK as string) ?? 'testnet',
    tracesSampleRate: 0.2,
    integrations: [Sentry.browserTracingIntegration()],
  });
}

/**
 * Capture an error with an optional category tag and extra context.
 */
export function captureError(
  error: unknown,
  category: ErrorCategory = 'unknown',
  extras?: Record<string, unknown>,
): void {
  const err = error instanceof Error ? error : new Error(String(error));

  Sentry.withScope((scope) => {
    scope.setTag('category', category);
    if (extras) scope.setExtras(extras);
    Sentry.captureException(err);
  });

  // Always mirror to console so local development isn't silenced
  console.error(`[QuorumProof:${category}]`, err, extras ?? '');
}
