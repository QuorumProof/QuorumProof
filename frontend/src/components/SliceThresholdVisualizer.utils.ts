export type SliceHealth = 'healthy' | 'degraded' | 'critical';

export function getSliceHealth(availableAttestors: number, threshold: number): SliceHealth {
  if (availableAttestors >= threshold) return 'healthy';
  if (availableAttestors > 0) return 'degraded';
  return 'critical';
}

export const HEALTH_CONFIG: Record<SliceHealth, { color: string; label: string; icon: string }> = {
  healthy:  { color: '#10b981', label: 'All attestors available', icon: '✅' },
  degraded: { color: '#f59e0b', label: 'Some attestors unavailable', icon: '⚠️' },
  critical: { color: '#ef4444', label: 'No attestors available', icon: '🔴' },
};
