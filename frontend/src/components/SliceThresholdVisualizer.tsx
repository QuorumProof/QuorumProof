import { getSliceHealth, HEALTH_CONFIG } from './SliceThresholdVisualizer.utils';
export type { SliceHealth } from './SliceThresholdVisualizer.utils';

export interface SliceThresholdVisualizerProps {
  attestations: number;   // current attestations received
  threshold: number;      // minimum required
  totalAttestors: number; // total attestors in slice
  availableAttestors: number; // attestors currently available
}

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
