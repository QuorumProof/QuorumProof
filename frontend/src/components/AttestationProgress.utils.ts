/**
 * AttestationProgress.utils — issue #468
 * Pure helpers extracted from AttestationProgress.tsx so that file can stay
 * component-only (react-refresh/only-export-components).
 */

/** Rough estimate: assume each pending attestor takes ~24 h */
export function estimateCompletion(pendingCount: number): string {
  if (pendingCount <= 0) return 'Complete';
  const hours = pendingCount * 24;
  if (hours < 48) return `~${hours}h`;
  return `~${Math.ceil(hours / 24)} days`;
}
