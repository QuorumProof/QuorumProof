/**
 * Issue #3 follow-up — monitoring/prometheus/prometheus.yml never scraped
 * api-server's /metrics/events route, so the four alert rules in alerts.yml
 * that reference quorumproof_critical_events_total /
 * quorumproof_critical_event_alert_failures_total could never evaluate true.
 *
 * These tests read the real monitoring/prometheus/*.yml files (not copies)
 * so a future rename on either side of the contract breaks CI instead of
 * drifting silently.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { CriticalEventListener } from '../src/services/criticalEventListener.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const monitoringDir = path.join(__dirname, '..', '..', 'monitoring', 'prometheus');
const alertsYmlPath = path.join(monitoringDir, 'alerts.yml');
const prometheusYmlPath = path.join(monitoringDir, 'prometheus.yml');

const CRITICAL_EVENT_ALERT_NAMES = [
  'RevocationSpike',
  'DisputeRaised',
  'ContractUpgradeDetected',
  'CriticalEventAlertingDegraded',
] as const;

/** Pulls out `- alert: <name>` ... next `- alert:`/EOF block, then every `quorumproof_*` token in it. */
function metricNamesReferencedByAlert(alertsYml: string, alertName: string): string[] {
  const startMarker = `- alert: ${alertName}`;
  const start = alertsYml.indexOf(startMarker);
  if (start === -1) throw new Error(`alert ${alertName} not found in alerts.yml`);
  const nextAlert = alertsYml.indexOf('- alert:', start + startMarker.length);
  const block = alertsYml.slice(start, nextAlert === -1 ? undefined : nextAlert);
  const matches = block.match(/quorumproof_[a-zA-Z0-9_]+/g) ?? [];
  return [...new Set(matches)];
}

describe('critical-event alert rules reference metrics the listener actually emits', () => {
  const alertsYml = fs.readFileSync(alertsYmlPath, 'utf8');
  const listener = new CriticalEventListener({
    dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'critical-event-metric-names-')),
    contractId: '',
  });
  const exposition = listener.getMetricsPrometheus();

  for (const alertName of CRITICAL_EVENT_ALERT_NAMES) {
    it(`every quorumproof_* metric in ${alertName}'s expr is emitted by getMetricsPrometheus()`, () => {
      const names = metricNamesReferencedByAlert(alertsYml, alertName);
      expect(names.length).toBeGreaterThan(0);
      for (const name of names) {
        expect(exposition, `expected getMetricsPrometheus() to expose ${name} (referenced by ${alertName})`).toMatch(
          new RegExp(`^${name}(\\{|\\s)`, 'm')
        );
      }
    });
  }

  it('exposes the exact two metric names the four critical-event alerts depend on', () => {
    const allReferenced = new Set(
      CRITICAL_EVENT_ALERT_NAMES.flatMap((name) => metricNamesReferencedByAlert(alertsYml, name))
    );
    expect(allReferenced).toEqual(new Set(['quorumproof_critical_events_total', 'quorumproof_critical_event_alert_failures_total']));
  });
});

describe('prometheus.yml scrapes the route those metrics come from', () => {
  const prometheusYml = fs.readFileSync(prometheusYmlPath, 'utf8');

  it('defines a scrape job with metrics_path: /metrics/events', () => {
    expect(prometheusYml).toMatch(/metrics_path:\s*\/metrics\/events/);
  });

  it('scrapes it at an interval at or below the tightest alert window (5m, for DisputeRaised/ContractUpgradeDetected)', () => {
    const jobBlockStart = prometheusYml.indexOf('metrics_path: /metrics/events');
    const jobStart = prometheusYml.lastIndexOf('- job_name:', jobBlockStart);
    const nextJob = prometheusYml.indexOf('- job_name:', jobBlockStart);
    const block = prometheusYml.slice(jobStart, nextJob === -1 ? undefined : nextJob);
    const match = block.match(/scrape_interval:\s*(\d+)s/) ?? prometheusYml.match(/^\s*scrape_interval:\s*(\d+)s/m);
    expect(match, 'expected an explicit or global scrape_interval').not.toBeNull();
    const intervalSeconds = parseInt(match![1], 10);
    expect(intervalSeconds).toBeLessThanOrEqual(5 * 60);
  });
});
