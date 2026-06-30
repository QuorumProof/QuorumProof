import { useState, useEffect } from 'react';
import { useWallet } from '../hooks';

interface ReputationData {
  address: string;
  score: number;
  attestation_count: number;
  total_activity: number;
  success_rate: number | null;
  period_days: number;
}

const API_BASE = import.meta.env.VITE_API_URL ?? '';

function ScoreGauge({ score }: { score: number }) {
  const radius = 54;
  const circumference = 2 * Math.PI * radius;
  const dashOffset = circumference * (1 - score / 100);
  const color = score >= 80 ? '#10b981' : score >= 50 ? '#f59e0b' : '#ef4444';

  return (
    <svg width="140" height="80" viewBox="0 0 140 80" aria-label={`Reputation score ${score} out of 100`}>
      {/* Background arc (half circle) */}
      <path
        d="M 14 70 A 56 56 0 0 1 126 70"
        fill="none"
        stroke="#334155"
        strokeWidth="12"
        strokeLinecap="round"
      />
      {/* Score arc */}
      <path
        d="M 14 70 A 56 56 0 0 1 126 70"
        fill="none"
        stroke={color}
        strokeWidth="12"
        strokeLinecap="round"
        strokeDasharray={`${(score / 100) * 176} 176`}
        style={{ transition: 'stroke-dasharray 0.6s ease' }}
      />
      {/* Score text */}
      <text x="70" y="68" textAnchor="middle" fontSize="22" fontWeight="700" fill={color}>
        {score}
      </text>
      <text x="70" y="78" textAnchor="middle" fontSize="9" fill="#94a3b8">
        / 100
      </text>
    </svg>
  );
}

function MetricCard({
  label,
  value,
  sub,
  color = 'text-slate-100',
}: {
  label: string;
  value: string;
  sub?: string;
  color?: string;
}) {
  return (
    <div className="bg-slate-800 border border-slate-700 rounded-lg p-4">
      <div className="text-xs text-slate-400 mb-1">{label}</div>
      <div className={`text-2xl font-bold ${color}`}>{value}</div>
      {sub && <div className="text-xs text-slate-500 mt-0.5">{sub}</div>}
    </div>
  );
}

function scoreLabel(score: number): string {
  if (score >= 80) return 'High';
  if (score >= 50) return 'Medium';
  return 'Low';
}

function scoreColor(score: number): string {
  if (score >= 80) return 'text-green-400';
  if (score >= 50) return 'text-yellow-400';
  return 'text-red-400';
}

function SpeedTier({ count }: { count: number }) {
  // Classify speed by attestation volume over 30 days
  if (count >= 50) return { label: 'Fast', color: 'text-green-400', desc: '50+ attestations/mo' };
  if (count >= 20) return { label: 'Moderate', color: 'text-yellow-400', desc: '20–49 attestations/mo' };
  if (count >= 5) return { label: 'Slow', color: 'text-orange-400', desc: '5–19 attestations/mo' };
  return { label: 'Inactive', color: 'text-slate-500', desc: 'Fewer than 5 this month' };
}

export default function AttestorReputationPage() {
  const { address } = useWallet();
  const [data, setData] = useState<ReputationData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!address) return;
    setLoading(true);
    setError(null);

    fetch(`${API_BASE}/api/attestor/reputation/${encodeURIComponent(address)}`)
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json() as Promise<ReputationData>;
      })
      .then(setData)
      .catch((err) => setError(err.message ?? 'Failed to load reputation'))
      .finally(() => setLoading(false));
  }, [address]);

  if (!address) {
    return (
      <div className="max-w-2xl mx-auto py-16 text-center text-slate-400">
        Connect your wallet to view your attestor reputation.
      </div>
    );
  }

  const speed = data ? SpeedTier({ count: data.attestation_count }) : null;

  return (
    <div className="max-w-3xl mx-auto py-6 px-4">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-slate-100">Attestor Reputation</h1>
        <p className="text-slate-400 text-sm mt-1">
          Your attestation performance metrics and reputation score.
        </p>
        <div className="mt-2 font-mono text-xs text-slate-500 break-all">{address}</div>
      </div>

      {loading && (
        <div className="space-y-4">
          <div className="h-40 bg-slate-800 animate-pulse rounded-lg" />
          <div className="grid grid-cols-2 gap-4">
            {[1, 2, 3, 4].map((i) => <div key={i} className="h-20 bg-slate-800 animate-pulse rounded-lg" />)}
          </div>
        </div>
      )}

      {error && (
        <div className="p-4 bg-red-900/40 border border-red-700 rounded text-red-300 text-sm">{error}</div>
      )}

      {data && !loading && (
        <>
          {/* Reputation score hero card */}
          <div className="bg-slate-800 border border-slate-700 rounded-xl p-6 mb-6 flex flex-col sm:flex-row items-center gap-6">
            <div className="flex flex-col items-center">
              <ScoreGauge score={data.score} />
              <div className={`text-sm font-semibold mt-1 ${scoreColor(data.score)}`}>
                {scoreLabel(data.score)} Reputation
              </div>
            </div>
            <div className="flex-1">
              <h2 className="text-lg font-semibold text-slate-100 mb-2">Reputation Score</h2>
              <p className="text-sm text-slate-400 mb-3">
                Your score is derived from on-chain attestation activity and the quorum weighting of
                credentials you have attested. Scores range from 0 (new) to 100 (established).
              </p>
              <div className="w-full bg-slate-700 rounded-full h-2">
                <div
                  className="h-2 rounded-full transition-all duration-700"
                  style={{
                    width: `${data.score}%`,
                    backgroundColor: data.score >= 80 ? '#10b981' : data.score >= 50 ? '#f59e0b' : '#ef4444',
                  }}
                />
              </div>
            </div>
          </div>

          {/* Metrics grid */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 mb-6">
            <MetricCard
              label="Attestations (30d)"
              value={data.attestation_count.toString()}
              sub={`of ${data.total_activity} events`}
              color="text-indigo-400"
            />
            <MetricCard
              label="Success Rate"
              value={
                data.success_rate !== null
                  ? `${(data.success_rate * 100).toFixed(1)}%`
                  : 'N/A'
              }
              sub="attested / total"
              color={
                data.success_rate === null
                  ? 'text-slate-400'
                  : data.success_rate >= 0.8
                  ? 'text-green-400'
                  : data.success_rate >= 0.5
                  ? 'text-yellow-400'
                  : 'text-red-400'
              }
            />
            {speed && (
              <MetricCard
                label="Attestation Speed"
                value={speed.label}
                sub={speed.desc}
                color={speed.color}
              />
            )}
            <MetricCard
              label="Period"
              value={`${data.period_days}d`}
              sub="rolling window"
            />
          </div>

          {/* Tier breakdown */}
          <div className="bg-slate-800 border border-slate-700 rounded-lg p-5">
            <h3 className="text-sm font-semibold text-slate-200 mb-4">Score Breakdown</h3>
            <div className="space-y-3">
              {[
                { label: 'On-chain activity weight', pct: Math.min(data.score, 60), max: 60, desc: 'SBT tokens held × weight' },
                { label: 'Notification activity weight', pct: Math.min(Math.max(data.score - 40, 0), 40), max: 40, desc: 'Events logged × weight' },
              ].map((item) => (
                <div key={item.label}>
                  <div className="flex justify-between text-xs text-slate-400 mb-1">
                    <span>{item.label}</span>
                    <span>{item.pct} / {item.max}</span>
                  </div>
                  <div className="w-full bg-slate-700 rounded-full h-1.5">
                    <div
                      className="h-1.5 rounded-full bg-indigo-500 transition-all duration-700"
                      style={{ width: `${(item.pct / item.max) * 100}%` }}
                    />
                  </div>
                  <div className="text-xs text-slate-600 mt-0.5">{item.desc}</div>
                </div>
              ))}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
