/**
 * #1647 — Plugin bootstrap from environment.
 *
 *   QUORUMPROOF_PLUGINS        comma-separated module specifiers, loaded in order
 *                              e.g. "@acme/qp-plugin-audit,./plugins/credential-logger/index.js"
 *   QUORUMPROOF_PLUGIN_CONFIG  JSON object keyed by plugin *specifier*, passed as ctx.config
 *                              e.g. '{"@acme/qp-plugin-audit":{"endpoint":"https://..."}}'
 *   PLUGINS_STRICT             "true" to refuse startup if any plugin fails to load
 *   PLUGIN_EVENT_TIMEOUT_MS    per-event handler timeout (default 5000)
 *
 * Relative specifiers resolve against the process working directory.
 */

import { isAbsolute, resolve } from 'path';
import { pathToFileURL } from 'url';
import { PluginRegistry } from './registry.js';

export { PluginRegistry, validatePlugin } from './registry.js';
export * from './types.js';

export const pluginRegistry = new PluginRegistry({
  strict: process.env.PLUGINS_STRICT === 'true',
  eventTimeoutMs: process.env.PLUGIN_EVENT_TIMEOUT_MS
    ? parseInt(process.env.PLUGIN_EVENT_TIMEOUT_MS, 10)
    : undefined,
});

function toImportSpecifier(spec: string): string {
  if (spec.startsWith('.') || isAbsolute(spec)) {
    return pathToFileURL(resolve(process.cwd(), spec)).href;
  }
  return spec;
}

export async function loadPluginsFromEnv(
  registry: PluginRegistry = pluginRegistry,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const specs = (env.QUORUMPROOF_PLUGINS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (specs.length === 0) return;

  let allConfig: Record<string, Record<string, unknown>> = {};
  if (env.QUORUMPROOF_PLUGIN_CONFIG) {
    try {
      allConfig = JSON.parse(env.QUORUMPROOF_PLUGIN_CONFIG);
    } catch (err) {
      throw new Error(`QUORUMPROOF_PLUGIN_CONFIG is not valid JSON: ${(err as Error).message}`);
    }
  }

  for (const spec of specs) {
    await registry.load(toImportSpecifier(spec), allConfig[spec] ?? {});
  }
}
