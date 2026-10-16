/**
 * #1647 — Plugin registry: loading, validation, isolation, and lifecycle.
 *
 * Isolation rules (a misbehaving plugin must never take the server down):
 *   - setup() failures skip that plugin and are logged; others still load
 *     (unless PLUGINS_STRICT=true, where any failure aborts startup)
 *   - onEvent() runs asynchronously with a per-call timeout; errors and
 *     timeouts are counted and logged, never rethrown
 *   - teardown() failures are logged and do not block other plugins
 */

import { Router } from 'express';
import { logger as hostLogger } from '../services/logger.js';
import { healthCheckManager } from '../services/healthCheck.js';
import {
  PLUGIN_API_VERSION,
  type PluginContext,
  type PluginEvent,
  type PluginLogger,
  type PluginModuleExport,
  type QuorumProofPlugin,
} from './types.js';

const NAME_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;

export interface PluginInfo {
  name: string;
  version: string;
  source: string;
  eventsDelivered: number;
  eventErrors: number;
}

interface LoadedPlugin {
  plugin: QuorumProofPlugin;
  source: string;
  eventsDelivered: number;
  eventErrors: number;
}

export interface PluginRegistryOptions {
  /** Max ms an onEvent handler may run before it is abandoned. */
  eventTimeoutMs?: number;
  /** Abort on any load failure instead of skipping the plugin. */
  strict?: boolean;
}

function scopedLogger(name: string): PluginLogger {
  const mod = `plugin:${name}`;
  return {
    debug: (m, meta) => hostLogger.debug(m, mod, meta),
    info: (m, meta) => hostLogger.info(m, mod, meta),
    warn: (m, meta) => hostLogger.warn(m, mod, meta),
    error: (m, meta) => hostLogger.error(m, mod, meta),
  };
}

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout;
  return Promise.race([
    p,
    new Promise<T>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms}ms`)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

export function validatePlugin(candidate: unknown): asserts candidate is QuorumProofPlugin {
  const p = candidate as Partial<QuorumProofPlugin> | null;
  if (!p || typeof p !== 'object') throw new Error('plugin export is not an object');
  if (typeof p.name !== 'string' || !NAME_RE.test(p.name)) {
    throw new Error(`invalid plugin name ${JSON.stringify(p.name)} (must match ${NAME_RE})`);
  }
  if (typeof p.version !== 'string' || p.version.length === 0) {
    throw new Error(`plugin ${p.name}: missing version`);
  }
  if (p.apiVersion !== PLUGIN_API_VERSION) {
    throw new Error(
      `plugin ${p.name}: targets apiVersion ${p.apiVersion}, host provides ${PLUGIN_API_VERSION}`,
    );
  }
  if (typeof p.setup !== 'function') throw new Error(`plugin ${p.name}: setup() is required`);
  if (p.onEvent !== undefined && typeof p.onEvent !== 'function') {
    throw new Error(`plugin ${p.name}: onEvent must be a function`);
  }
  if (p.teardown !== undefined && typeof p.teardown !== 'function') {
    throw new Error(`plugin ${p.name}: teardown must be a function`);
  }
}

export class PluginRegistry {
  /** Parent router; mount once at /api/plugins. */
  readonly router: Router = Router();

  private readonly plugins = new Map<string, LoadedPlugin>();
  private readonly eventTimeoutMs: number;
  private readonly strict: boolean;

  constructor(opts: PluginRegistryOptions = {}) {
    this.eventTimeoutMs = opts.eventTimeoutMs ?? 5_000;
    this.strict = opts.strict ?? false;
  }

  /** Register an already-constructed plugin (used by tests and by load()). */
  async register(
    plugin: QuorumProofPlugin,
    config: Readonly<Record<string, unknown>> = {},
    source = '<inline>',
  ): Promise<void> {
    validatePlugin(plugin);
    if (this.plugins.has(plugin.name)) {
      throw new Error(`plugin ${plugin.name} is already registered`);
    }

    const pluginRouter = Router();
    const ctx: PluginContext = {
      router: pluginRouter,
      logger: scopedLogger(plugin.name),
      config: Object.freeze({ ...config }),
      apiVersion: PLUGIN_API_VERSION,
      registerHealthCheck: (checkName, check) => {
        healthCheckManager.registerHealthCheck(`plugin:${plugin.name}:${checkName}`, check);
      },
    };

    await plugin.setup(ctx);

    this.router.use(`/${plugin.name}`, pluginRouter);
    this.plugins.set(plugin.name, { plugin, source, eventsDelivered: 0, eventErrors: 0 });
    hostLogger.info(`Plugin loaded: ${plugin.name}@${plugin.version}`, 'plugins', { source });
  }

  /**
   * Import a plugin module by specifier (npm package name or absolute /
   * relative file path) and register it.
   */
  async load(specifier: string, config: Readonly<Record<string, unknown>> = {}): Promise<void> {
    try {
      const mod = await import(specifier);
      const exported: PluginModuleExport = mod.default ?? mod.plugin;
      const plugin = typeof exported === 'function' ? await exported(config) : exported;
      await this.register(plugin, config, specifier);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      hostLogger.error(`Plugin failed to load: ${specifier}`, 'plugins', { error: message });
      if (this.strict) throw err;
    }
  }

  /**
   * Fan an event out to every plugin with onEvent. Never throws and never
   * awaits plugin work on the caller's path.
   */
  emit(event: PluginEvent): void {
    for (const entry of this.plugins.values()) {
      const handler = entry.plugin.onEvent;
      if (!handler) continue;
      const frozen = Object.freeze({ ...event });
      void withTimeout(
        Promise.resolve().then(() => handler.call(entry.plugin, frozen)),
        this.eventTimeoutMs,
        `${entry.plugin.name}.onEvent`,
      ).then(
        () => { entry.eventsDelivered += 1; },
        (err) => {
          entry.eventErrors += 1;
          hostLogger.warn(`Plugin event handler failed: ${entry.plugin.name}`, 'plugins', {
            event: event.type,
            error: err instanceof Error ? err.message : String(err),
          });
        },
      );
    }
  }

  /** Tear down all plugins in reverse load order. */
  async teardownAll(): Promise<void> {
    const entries = [...this.plugins.values()].reverse();
    for (const { plugin } of entries) {
      if (!plugin.teardown) continue;
      try {
        await withTimeout(Promise.resolve(plugin.teardown()), 10_000, `${plugin.name}.teardown`);
      } catch (err) {
        hostLogger.warn(`Plugin teardown failed: ${plugin.name}`, 'plugins', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    this.plugins.clear();
  }

  list(): PluginInfo[] {
    return [...this.plugins.values()].map((e) => ({
      name: e.plugin.name,
      version: e.plugin.version,
      source: e.source,
      eventsDelivered: e.eventsDelivered,
      eventErrors: e.eventErrors,
    }));
  }

  has(name: string): boolean {
    return this.plugins.has(name);
  }
}
