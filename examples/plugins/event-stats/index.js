// @ts-check
/**
 * Example QuorumProof plugin — issue #1647.
 *
 * - Counts broadcast events per type (credential_issued, credential_revoked, ...)
 * - Exposes GET /api/plugins/event-stats/stats
 * - Optionally forwards each event to `config.forwardUrl`
 * - Reports a health check that degrades when forwarding keeps failing
 *
 * Enable with:
 *   QUORUMPROOF_PLUGINS=../examples/plugins/event-stats/index.js
 *   QUORUMPROOF_PLUGIN_CONFIG='{"../examples/plugins/event-stats/index.js":{"forwardUrl":"https://example.com/hook"}}'
 *
 * @typedef {import('../../../api-server/src/plugins/types.js').QuorumProofPlugin} QuorumProofPlugin
 * @typedef {import('../../../api-server/src/plugins/types.js').PluginContext} PluginContext
 * @typedef {import('../../../api-server/src/plugins/types.js').PluginEvent} PluginEvent
 */

/**
 * Factory export: the host calls this with the plugin's config and expects a
 * QuorumProofPlugin back. Using a factory keeps state per instance, which
 * makes the plugin trivially testable.
 *
 * @param {Readonly<Record<string, unknown>>} [config]
 * @param {{ fetch?: typeof fetch }} [deps] injectable for tests
 * @returns {QuorumProofPlugin}
 */
export function createEventStatsPlugin(config = {}, deps = {}) {
  const doFetch = deps.fetch ?? globalThis.fetch;
  const forwardUrl = typeof config.forwardUrl === 'string' ? config.forwardUrl : undefined;
  const failureThreshold = typeof config.failureThreshold === 'number' ? config.failureThreshold : 5;

  /** @type {Map<string, number>} */
  const counts = new Map();
  let consecutiveForwardFailures = 0;
  let startedAt = new Date().toISOString();
  /** @type {PluginContext['logger'] | undefined} */
  let log;

  return {
    name: 'event-stats',
    version: '0.1.0',
    apiVersion: 1,

    setup(ctx) {
      log = ctx.logger;
      startedAt = new Date().toISOString();

      ctx.router.get('/stats', (_req, res) => {
        res.json({
          since: startedAt,
          total: [...counts.values()].reduce((a, b) => a + b, 0),
          byType: Object.fromEntries(counts),
          forwarding: forwardUrl ? { consecutiveFailures: consecutiveForwardFailures } : null,
        });
      });

      ctx.registerHealthCheck('forwarder', async () => {
        if (!forwardUrl) return { status: 'healthy', message: 'forwarding disabled' };
        return consecutiveForwardFailures >= failureThreshold
          ? { status: 'degraded', message: `${consecutiveForwardFailures} consecutive forward failures` }
          : { status: 'healthy' };
      });

      log.info('event-stats ready', { forwarding: Boolean(forwardUrl) });
    },

    async onEvent(event) {
      counts.set(event.type, (counts.get(event.type) ?? 0) + 1);

      if (!forwardUrl) return;
      try {
        const res = await doFetch(forwardUrl, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(event),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        consecutiveForwardFailures = 0;
      } catch (err) {
        consecutiveForwardFailures += 1;
        // Rethrowing lets the host count the failure in its plugin metrics.
        throw err;
      }
    },

    teardown() {
      log?.info('event-stats shutting down', { total: [...counts.values()].reduce((a, b) => a + b, 0) });
      counts.clear();
    },
  };
}

export default createEventStatsPlugin;
