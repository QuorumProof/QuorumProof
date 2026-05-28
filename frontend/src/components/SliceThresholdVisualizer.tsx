export type SliceHealth = 'healthy' | 'degraded' | 'critical';

export interface SliceThresholdVisualizerProps {
  attestations: number;   // current attestations received
  threshold: number;      // minimum required
  totalAttestors: number; // total attestors in slice
  availableAttestors: number; // attestors currently available
}

export function getSliceHealth(availableAttestors: number, threshold: number): SliceHealth {
  if (availableAttestors >= threshold) return 'healthy';
  if (availableAttestors > 0) return 'degraded';
  return 'critical';
}

const HEALTH_CONFIG: Record<SliceHealth, { color: string; label: string; icon: string }> = {
  healthy:  { color: '#10b981', label: 'All attestors available', icon: '✅' },
  degraded: { color: '#f59e0b', label: 'Some attestors unavailable', icon: '⚠️' },
  critical: { color: '#ef4444', label: 'No attestors available', icon: '🔴' },
};

export function SliceThresholdVisualizer({
  attestations,
  threshold,
  totalAttestors,
  availableAttestors,
}: SliceThresholdVisualizerProps) {
  const progress = totalAttestors > 0 ? Math.min((attestations / threshold) * 100, 100) : 0;
  const health = getSliceHealth(availableAttestors, threshold);
  const { color, label, icon } = HEALTH_CONFIG[health];

  return (
    <div className="slice-threshold-viz" data-testid="slice-threshold-viz">
      {/* Progress bar */}
      <div className="stv__progress-section">
        <div className="stv__labels">
          <span className="stv__label">Attestations</span>
          <span className="stv__count" data-testid="attestation-count">
            {attestations} / {threshold} required
          </span>
        </div>
        <div
          className="stv__track"
          role="progressbar"
          aria-valuenow={attestations}
          aria-valuemin={0}
          aria-valuemax={threshold}
          aria-label="Attestation progress"
        >
          <div
            className="stv__fill"
            style={{ width: `${progress}%`, backgroundColor: color }}
            data-testid="progress-fill"
          />
        </div>
        <div className="stv__pct" style={{ color }}>
          {Math.round(progress)}%
        </div>
      </div>

      {/* Health indicator */}
      <div
        className="stv__health"
        data-testid="health-indicator"
        data-health={health}
        style={{ color }}
        aria-label={`Slice health: ${label}`}
      >
        <span className="stv__health-icon" aria-hidden="true">{icon}</span>
        <span className="stv__health-label">{label}</span>
        <span className="stv__health-detail">
          {availableAttestors} of {totalAttestors} attestors available
        </span>
      </div>
    </div>
  );
}
