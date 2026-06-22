export interface CredentialEvent {
  type: 'issued' | 'attested' | 'revoked' | 'suspended' | 'verified';
  credential_id: string;
  timestamp: string;
  issuer?: string;
  subject?: string;
  attestor?: string;
  metadata?: Record<string, unknown>;
}

export interface HourlyMetrics {
  date: string;
  hour: number;
  issued_count: number;
  attested_count: number;
  revoked_count: number;
  suspended_count: number;
  verified_count: number;
  unique_issuers: Set<string>;
  unique_subjects: Set<string>;
  unique_attestors: Set<string>;
}

export interface DailyMetrics {
  date: string;
  issued_count: number;
  attested_count: number;
  revoked_count: number;
  suspended_count: number;
  verified_count: number;
  unique_issuers: number;
  unique_subjects: number;
  unique_attestors: number;
  issuance_rate: number;
  revocation_rate: number;
  attestation_rate: number;
  anomaly_score: number;
}

export interface AnomalyDetectionResult {
  is_anomalous: boolean;
  score: number;
  reason?: string;
  zscore: number;
  expected_range: { min: number; max: number };
}

const RETENTION_DAYS = 730; // 2 years
const DAILY_AGGREGATION_INTERVAL = 24 * 60 * 60 * 1000;
const DATA_RETENTION_MS = RETENTION_DAYS * 24 * 60 * 60 * 1000;

class MetricsStore {
  private hourlyMetrics: Map<string, HourlyMetrics> = new Map();
  private dailyMetrics: Map<string, DailyMetrics> = new Map();
  private eventLog: CredentialEvent[] = [];

  recordEvent(event: CredentialEvent): void {
    this.eventLog.push(event);
    this.aggregateToHourly(event);
  }

  private aggregateToHourly(event: CredentialEvent): void {
    const date = new Date(event.timestamp);
    const dateStr = date.toISOString().split('T')[0];
    const hour = date.getUTCHours();
    const key = `${dateStr}:${hour}`;

    if (!this.hourlyMetrics.has(key)) {
      this.hourlyMetrics.set(key, {
        date: dateStr,
        hour,
        issued_count: 0,
        attested_count: 0,
        revoked_count: 0,
        suspended_count: 0,
        verified_count: 0,
        unique_issuers: new Set(),
        unique_subjects: new Set(),
        unique_attestors: new Set(),
      });
    }

    const metrics = this.hourlyMetrics.get(key)!;

    switch (event.type) {
      case 'issued':
        metrics.issued_count++;
        if (event.issuer) metrics.unique_issuers.add(event.issuer);
        if (event.subject) metrics.unique_subjects.add(event.subject);
        break;
      case 'attested':
        metrics.attested_count++;
        if (event.attestor) metrics.unique_attestors.add(event.attestor);
        break;
      case 'revoked':
        metrics.revoked_count++;
        break;
      case 'suspended':
        metrics.suspended_count++;
        break;
      case 'verified':
        metrics.verified_count++;
        break;
    }
  }

  aggregateToDaily(dateStr: string): void {
    const hourlyKeysForDate = Array.from(this.hourlyMetrics.keys()).filter((k) =>
      k.startsWith(dateStr)
    );

    if (hourlyKeysForDate.length === 0) return;

    let issued_count = 0;
    let attested_count = 0;
    let revoked_count = 0;
    let suspended_count = 0;
    let verified_count = 0;
    const issuers = new Set<string>();
    const subjects = new Set<string>();
    const attestors = new Set<string>();

    for (const key of hourlyKeysForDate) {
      const hourly = this.hourlyMetrics.get(key)!;
      issued_count += hourly.issued_count;
      attested_count += hourly.attested_count;
      revoked_count += hourly.revoked_count;
      suspended_count += hourly.suspended_count;
      verified_count += hourly.verified_count;
      hourly.unique_issuers.forEach((i) => issuers.add(i));
      hourly.unique_subjects.forEach((s) => subjects.add(s));
      hourly.unique_attestors.forEach((a) => attestors.add(a));
    }

    const total_credentials =
      issued_count + attested_count + revoked_count + suspended_count + verified_count;
    const daily: DailyMetrics = {
      date: dateStr,
      issued_count,
      attested_count,
      revoked_count,
      suspended_count,
      verified_count,
      unique_issuers: issuers.size,
      unique_subjects: subjects.size,
      unique_attestors: attestors.size,
      issuance_rate: total_credentials > 0 ? issued_count / total_credentials : 0,
      revocation_rate: total_credentials > 0 ? revoked_count / total_credentials : 0,
      attestation_rate: total_credentials > 0 ? attested_count / total_credentials : 0,
      anomaly_score: 0,
    };

    daily.anomaly_score = this.calculateAnomalyScore(daily);
    this.dailyMetrics.set(dateStr, daily);
  }

  private calculateAnomalyScore(metrics: DailyMetrics): number {
    const historical = Array.from(this.dailyMetrics.values());
    if (historical.length === 0) return 0;

    const avgIssued = historical.reduce((sum, m) => sum + m.issued_count, 0) / historical.length;
    const stdDev = Math.sqrt(
      historical.reduce((sum, m) => sum + Math.pow(m.issued_count - avgIssued, 2), 0) /
        historical.length
    );

    if (stdDev === 0) return 0;
    const zscore = Math.abs((metrics.issued_count - avgIssued) / stdDev);
    return Math.min(zscore, 5);
  }

  getMetrics(startDate: string, endDate: string): DailyMetrics[] {
    const start = new Date(startDate);
    const end = new Date(endDate);
    const result: DailyMetrics[] = [];

    for (let d = new Date(start); d <= end; d.setUTCDate(d.getUTCDate() + 1)) {
      const dateStr = d.toISOString().split('T')[0];
      const metrics = this.dailyMetrics.get(dateStr);
      if (metrics) result.push(metrics);
    }

    return result;
  }

  detectAnomalies(metrics: DailyMetrics[]): AnomalyDetectionResult[] {
    return metrics.map((m) => {
      const historical = Array.from(this.dailyMetrics.values()).filter((h) => h.date < m.date);
      if (historical.length === 0) {
        return { is_anomalous: false, score: 0, zscore: 0, expected_range: { min: 0, max: 0 } };
      }

      const avgIssued = historical.reduce((sum, h) => sum + h.issued_count, 0) / historical.length;
      const stdDev = Math.sqrt(
        historical.reduce((sum, h) => sum + Math.pow(h.issued_count - avgIssued, 2), 0) /
          historical.length
      );

      const zscore = stdDev > 0 ? Math.abs((m.issued_count - avgIssued) / stdDev) : 0;
      const is_anomalous = zscore > 2.5;

      return {
        is_anomalous,
        score: m.anomaly_score,
        zscore,
        expected_range: {
          min: Math.max(0, avgIssued - 3 * stdDev),
          max: avgIssued + 3 * stdDev,
        },
        reason: is_anomalous ? `Z-score: ${zscore.toFixed(2)}, exceeds threshold of 2.5` : undefined,
      };
    });
  }

  cleanup(): void {
    const cutoffTime = Date.now() - DATA_RETENTION_MS;
    const cutoffDate = new Date(cutoffTime).toISOString().split('T')[0];

    for (const [key] of this.dailyMetrics) {
      if (key < cutoffDate) {
        this.dailyMetrics.delete(key);
      }
    }

    for (const [key] of this.hourlyMetrics) {
      if (key.split(':')[0] < cutoffDate) {
        this.hourlyMetrics.delete(key);
      }
    }

    this.eventLog = this.eventLog.filter(
      (e) => new Date(e.timestamp).getTime() > cutoffTime
    );
  }

  getEventLog(startDate: string, endDate: string): CredentialEvent[] {
    const start = new Date(startDate).getTime();
    const end = new Date(endDate).getTime();
    return this.eventLog.filter((e) => {
      const ts = new Date(e.timestamp).getTime();
      return ts >= start && ts <= end;
    });
  }

  getSummary(): {
    total_events: number;
    total_days: number;
    retention_days: number;
  } {
    return {
      total_events: this.eventLog.length,
      total_days: this.dailyMetrics.size,
      retention_days: RETENTION_DAYS,
    };
  }

  reset(): void {
    this.hourlyMetrics.clear();
    this.dailyMetrics.clear();
    this.eventLog = [];
  }
}

export const metricsStore = new MetricsStore();
