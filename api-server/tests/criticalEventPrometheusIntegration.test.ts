/**
 * Issue #3 follow-up — real-Prometheus proof that the scrape job added to
 * monitoring/prometheus/prometheus.yml actually lets the four
 * critical-event alert rules in alerts.yml see data.
 *
 * This spawns a real `prometheus` binary (not a mock/reimplementation)
 * against the repo's actual alerts.yml and a fixture that serves the real
 * CriticalEventListener's /metrics/events output, then queries Prometheus's
 * own HTTP API — the same thing an operator or Alertmanager would see.
 *
 * Requires a `prometheus` binary. Set PROMETHEUS_BIN, or have it on PATH
 * (`brew install prometheus`, or download from
 * https://github.com/prometheus/prometheus/releases). Skips (not fails) if
 * unavailable, matching how tests/helpers/wsCluster.ts treats a missing
 * redis-server.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { getFreePort } from './helpers/wsCluster.js';
import { prometheusBinary, startPrometheusAgainstFixture, pollUntil, type PrometheusHandle } from './helpers/promHarness.js';
import { startCriticalEventFixture, type CriticalEventFixtureHandle } from './helpers/criticalEventFixtureProcess.js';

const SCRAPE_INTERVAL_SECONDS = 2;
const binaryAvailable = prometheusBinary() !== null;

describe.skipIf(!binaryAvailable)('critical-event metrics scraped by a real Prometheus', () => {
  let fixture: CriticalEventFixtureHandle;
  let prom: PrometheusHandle;

  beforeAll(async () => {
    // Every dispatch fails (closed loopback port) so the same event batch
    // that drives RevocationSpike below also drives
    // CriticalEventAlertingDegraded, mirroring the real "revocations spiked
    // and alerting is broken" scenario docs/critical-event-alerting.md
    // describes for that alert.
    fixture = await startCriticalEventFixture({ slackWebhookUrl: 'http://127.0.0.1:1' });
    const promPort = await getFreePort();
    prom = await startPrometheusAgainstFixture({
      scrapeTarget: fixture.baseUrl.replace(/^http:\/\//, ''),
      metricsPath: '/metrics/events',
      scrapeIntervalSeconds: SCRAPE_INTERVAL_SECONDS,
      port: promPort,
    });
    // At least two real scrapes, so increase()/rate() over the counters
    // have something to compute against later.
    await pollUntil(
      () => prom.query('up{job="api-server-critical-events-fixture"}'),
      (r) => r.length === 1 && r[0].value[1] === '1',
      15_000,
      'up{job="api-server-critical-events-fixture"} == 1'
    );
    await new Promise((r) => setTimeout(r, SCRAPE_INTERVAL_SECONDS * 2 * 1000));
  }, 30_000);

  afterAll(async () => {
    await prom?.stop();
    await fixture?.stop();
  });

  it('exposes quorumproof_critical_events_total and quorumproof_critical_event_alert_failures_total as present-and-zero, not absent, before any event fires', async () => {
    for (const category of ['revocation', 'dispute', 'upgrade']) {
      const result = await prom.query(`quorumproof_critical_events_total{category="${category}"}`);
      expect(result, `expected a time series for category=${category} (absent means never scraped)`).toHaveLength(1);
      expect(result[0].value[1]).toBe('0');
    }
    const failures = await prom.query('quorumproof_critical_event_alert_failures_total');
    expect(failures).toHaveLength(1);
    expect(failures[0].value[1]).toBe('0');
  });

  it('fires RevocationSpike once increase(quorumproof_critical_events_total{category="revocation"}[15m]) > 10 is actually scraped', async () => {
    await fixture.emit('revocation', 15);

    await pollUntil(
      () => prom.query('quorumproof_critical_events_total{category="revocation"}'),
      (r) => r.length === 1 && r[0].value[1] === '15',
      15_000,
      'quorumproof_critical_events_total{category="revocation"} == 15'
    );

    await pollUntil(
      () => prom.query('ALERTS{alertname="RevocationSpike",alertstate="firing"}'),
      (r) => r.length === 1,
      15_000,
      'RevocationSpike to be firing'
    );
  }, 30_000);

  it('fires CriticalEventAlertingDegraded when every alert-dispatch attempt for those events failed', async () => {
    // No new emit() here — this asserts on the failures produced by the
    // revocation batch above (dispatch to a closed port fails every time).
    await pollUntil(
      () => prom.query('quorumproof_critical_event_alert_failures_total'),
      (r) => r.length === 1 && Number(r[0].value[1]) >= 15,
      15_000,
      'quorumproof_critical_event_alert_failures_total >= 15'
    );

    await pollUntil(
      () => prom.query('ALERTS{alertname="CriticalEventAlertingDegraded",alertstate="firing"}'),
      (r) => r.length === 1,
      15_000,
      'CriticalEventAlertingDegraded to be firing'
    );
  }, 30_000);

  it('does not fire DisputeRaised or ContractUpgradeDetected for a purely revocation-shaped batch', async () => {
    const dispute = await prom.query('ALERTS{alertname="DisputeRaised"}');
    const upgrade = await prom.query('ALERTS{alertname="ContractUpgradeDetected"}');
    expect(dispute).toHaveLength(0);
    expect(upgrade).toHaveLength(0);
  });
});

describe.skipIf(binaryAvailable)('critical-event metrics scraped by a real Prometheus (skipped)', () => {
  it.skip('no prometheus binary found on PATH or PROMETHEUS_BIN — see file header for how to install one', () => {});
});
