/**
 * #924 — Predictive Analytics for Credential Expiry
 *
 * Pure functions that operate on already-fetched credentials. No external deps.
 * "Prediction" uses a linear trend extrapolated from historical expiry density
 * within user-defined windows to forecast future expiry waves.
 */

export interface CredentialExpirySummary {
  id: string;
  subject: string;
  issuer: string;
  credential_type: number;
  expires_at: string; // ISO string
  days_until_expiry: number;
}

export interface ExpiryWindow {
  label: string;        // e.g. "0-30 days"
  from_days: number;
  to_days: number;
  count: number;
  credentials: CredentialExpirySummary[];
}

export interface ExpiryForecast {
  generatedAt: string;
  reference_date: string;
  total_expiring: number;
  windows: ExpiryWindow[];
  /** Simple linear trend: expected expirations per-day in the next `forecast_horizon_days`. */
  trend: {
    forecast_horizon_days: number;
    avg_per_day: number;
    /** Projected peak window (the window label with the most expirations). */
    peak_window: string | null;
  };
  already_expired: number;
}

const DEFAULT_WINDOWS = [
  { label: '0-30 days',   from_days: 0,  to_days: 30  },
  { label: '31-60 days',  from_days: 31, to_days: 60  },
  { label: '61-90 days',  from_days: 61, to_days: 90  },
  { label: '91-180 days', from_days: 91, to_days: 180 },
];

type RawCredential = {
  id: string;
  subject: string;
  issuer: string;
  credential_type: number;
  revoked: boolean;
  suspended: boolean;
  expires_at: string | null;
};

/**
 * Build an expiry forecast from a list of credentials.
 * @param credentials  serialised credential list (expires_at as ISO string or null)
 * @param nowMs        reference timestamp in ms (defaults to Date.now())
 * @param horizonDays  forecast horizon in days (default 90)
 */
export function buildExpiryForecast(
  credentials: RawCredential[],
  nowMs = Date.now(),
  horizonDays = 90
): ExpiryForecast {
  const nowDate = new Date(nowMs);
  let alreadyExpired = 0;

  const summaries: CredentialExpirySummary[] = [];

  for (const c of credentials) {
    if (c.revoked || c.suspended || !c.expires_at) continue;
    const expiryMs = Date.parse(c.expires_at);
    if (isNaN(expiryMs)) continue;
    const daysUntil = (expiryMs - nowMs) / 86_400_000;
    if (daysUntil < 0) {
      alreadyExpired++;
      continue;
    }
    summaries.push({
      id: c.id,
      subject: c.subject,
      issuer: c.issuer,
      credential_type: c.credential_type,
      expires_at: c.expires_at,
      days_until_expiry: Math.floor(daysUntil),
    });
  }

  const windows: ExpiryWindow[] = DEFAULT_WINDOWS.map((w) => {
    const creds = summaries.filter(
      (s) => s.days_until_expiry >= w.from_days && s.days_until_expiry <= w.to_days
    );
    return { ...w, count: creds.length, credentials: creds };
  });

  // Trend: total expiring within horizon / horizon days
  const withinHorizon = summaries.filter((s) => s.days_until_expiry <= horizonDays);
  const avgPerDay = horizonDays > 0 ? withinHorizon.length / horizonDays : 0;
  const peakWindow = windows.reduce<ExpiryWindow | null>(
    (best, w) => (best === null || w.count > best.count ? w : best),
    null
  );

  return {
    generatedAt: nowDate.toISOString(),
    reference_date: nowDate.toISOString(),
    total_expiring: summaries.length,
    windows,
    trend: {
      forecast_horizon_days: horizonDays,
      avg_per_day: Math.round(avgPerDay * 100) / 100,
      peak_window: peakWindow && peakWindow.count > 0 ? peakWindow.label : null,
    },
    already_expired: alreadyExpired,
  };
}

/**
 * Return credentials expiring within `thresholdDays` days.
 * Used to drive advance notifications.
 */
export function getExpiringWithin(
  credentials: RawCredential[],
  thresholdDays: number,
  nowMs = Date.now()
): CredentialExpirySummary[] {
  const results: CredentialExpirySummary[] = [];
  for (const c of credentials) {
    if (c.revoked || c.suspended || !c.expires_at) continue;
    const expiryMs = Date.parse(c.expires_at);
    if (isNaN(expiryMs)) continue;
    const daysUntil = (expiryMs - nowMs) / 86_400_000;
    if (daysUntil >= 0 && daysUntil <= thresholdDays) {
      results.push({
        id: c.id,
        subject: c.subject,
        issuer: c.issuer,
        credential_type: c.credential_type,
        expires_at: c.expires_at,
        days_until_expiry: Math.floor(daysUntil),
      });
    }
  }
  return results.sort((a, b) => a.days_until_expiry - b.days_until_expiry);
}
