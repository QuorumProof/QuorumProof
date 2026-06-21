/** Human-readable message from wallet kit / extension throws. */
export function formatWalletError(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  if (error && typeof error === 'object') {
    const o = error as { message?: unknown; error?: { message?: unknown } };
    const nested = o.error?.message;
    if (typeof nested === 'string' && nested) return nested;
    if (typeof o.message === 'string' && o.message) return o.message;
  }
  return 'Wallet request failed';
}

export function isUserRejectedError(error: unknown): boolean {
  const msg = formatWalletError(error).toLowerCase();
  return (
    msg.includes('user declined') ||
    msg.includes('user rejected') ||
    msg.includes('request rejected') ||
    msg.includes('denied')
  );
}
