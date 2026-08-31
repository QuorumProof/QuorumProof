/**
 * Notification channel senders for security-relevant alerts (issue #3).
 *
 * Deliberately separate from Prometheus/Alertmanager (`monitoring/prometheus/`):
 * that pipeline is pull-based and evaluates on a scrape interval, which is
 * fine for trend alerts (error rate, latency) but too slow for "a
 * credential was just revoked" or "the contract was just upgraded" — those
 * need to reach an operator within seconds. This module pushes directly to
 * Slack and PagerDuty the moment `criticalEventListener.ts` classifies an
 * on-chain event as critical, independent of any metrics scrape.
 */

export type AlertSeverity = 'critical' | 'warning';

export interface AlertPayload {
  title: string;
  description: string;
  severity: AlertSeverity;
  /** Stable identifier used for PagerDuty dedup and Slack thread correlation. */
  dedupKey: string;
  metadata?: Record<string, unknown>;
}

export interface AlertChannelResult {
  channel: 'slack' | 'pagerduty';
  ok: boolean;
  error?: string;
}

/** POSTs a formatted message to a Slack incoming webhook. No-ops (returns ok: true, skipped) if unconfigured. */
export async function sendSlackAlert(payload: AlertPayload, webhookUrl = process.env.SLACK_ALERT_WEBHOOK_URL): Promise<AlertChannelResult> {
  if (!webhookUrl) return { channel: 'slack', ok: true };
  const emoji = payload.severity === 'critical' ? ':rotating_light:' : ':warning:';
  const body = {
    text: `${emoji} *${payload.title}*`,
    blocks: [
      {
        type: 'section',
        text: { type: 'mrkdwn', text: `${emoji} *${payload.title}*\n${payload.description}` },
      },
      ...(payload.metadata
        ? [
            {
              type: 'context',
              elements: [{ type: 'mrkdwn', text: '```' + JSON.stringify(payload.metadata, null, 2) + '```' }],
            },
          ]
        : []),
    ],
  };
  try {
    const res = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) return { channel: 'slack', ok: false, error: `HTTP ${res.status}` };
    return { channel: 'slack', ok: true };
  } catch (err) {
    return { channel: 'slack', ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** Triggers a PagerDuty Events API v2 incident. No-ops (returns ok: true, skipped) if unconfigured. */
export async function sendPagerDutyAlert(
  payload: AlertPayload,
  routingKey = process.env.PAGERDUTY_ROUTING_KEY
): Promise<AlertChannelResult> {
  if (!routingKey) return { channel: 'pagerduty', ok: true };
  const body = {
    routing_key: routingKey,
    event_action: 'trigger',
    dedup_key: payload.dedupKey,
    payload: {
      summary: payload.title,
      source: 'quorumproof-api-server',
      severity: payload.severity === 'critical' ? 'critical' : 'warning',
      custom_details: { description: payload.description, ...payload.metadata },
    },
  };
  try {
    const res = await fetch('https://events.pagerduty.com/v2/enqueue', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) return { channel: 'pagerduty', ok: false, error: `HTTP ${res.status}` };
    return { channel: 'pagerduty', ok: true };
  } catch (err) {
    return { channel: 'pagerduty', ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Fan out an alert to every configured channel. PagerDuty is only paged for
 * `critical` severity (warnings go to Slack only) to avoid alert fatigue —
 * see docs/critical-event-alerting.md for the severity policy.
 */
export async function dispatchAlert(payload: AlertPayload): Promise<AlertChannelResult[]> {
  const sends: Promise<AlertChannelResult>[] = [sendSlackAlert(payload)];
  if (payload.severity === 'critical') sends.push(sendPagerDutyAlert(payload));
  return Promise.all(sends);
}

/**
 * Dispatches a warning-severity alert when the WebSocket message drop rate
 * exceeds the configured threshold for a sustained period.
 * Called from src/ws/metrics.ts after detecting a sustained drop burst.
 *
 * @param dropsInWindow - number of messages dropped in the observation window
 * @param windowSeconds - length of the observation window in seconds
 * @param instanceId - ws instance identifier for dedup key
 */
export async function dispatchWsMessageDropAlert(
  dropsInWindow: number,
  windowSeconds: number,
  instanceId: string,
): Promise<AlertChannelResult[]> {
  return dispatchAlert({
    title: 'Sustained WebSocket Message Drops',
    description:
      `${dropsInWindow} message(s) dropped in the last ${windowSeconds}s on instance ${instanceId}. ` +
      'One or more clients are falling behind the send queue. ' +
      'Check for slow consumers or network issues. ' +
      'See docs/operational-runbook.md#ws-message-drops for remediation steps.',
    severity: 'warning',
    dedupKey: `ws-message-drops-${instanceId}`,
    metadata: { dropsInWindow, windowSeconds, instanceId },
  });
}
