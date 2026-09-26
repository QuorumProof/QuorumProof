/**
 * #1647 — Plugin contract for the QuorumProof API server.
 *
 * A plugin is an ES module whose default export is a {@link QuorumProofPlugin}
 * (or a factory returning one). Plugins are loaded at startup from the
 * QUORUMPROOF_PLUGINS env var and can:
 *
 *   - mount HTTP routes under /api/plugins/<name>
 *   - react to credential/attestation events (the same events sent to
 *     WebSocket subscribers and webhooks)
 *   - contribute health checks to /health
 *   - release resources on graceful shutdown
 *
 * See docs/plugin-development-guide.md.
 */

import type { Router } from 'express';
import type { StructuredLogger } from '../services/logger.js';
import type { WsBroadcastEvent } from '../ws/subscriptions.js';

/** Bumped only on breaking changes to this file. */
export const PLUGIN_API_VERSION = 1;

/** Events delivered to {@link QuorumProofPlugin.onEvent}. */
export type PluginEvent = Readonly<WsBroadcastEvent>;

export interface PluginHealthResult {
  status: 'healthy' | 'degraded' | 'unhealthy';
  message?: string;
}

/** Scoped logger: every line is tagged with module `plugin:<name>`. */
export interface PluginLogger {
  debug(message: string, metadata?: Record<string, unknown>): void;
  info(message: string, metadata?: Record<string, unknown>): void;
  warn(message: string, metadata?: Record<string, unknown>): void;
  error(message: string, metadata?: Record<string, unknown>): void;
}

export interface PluginContext {
  /** Router mounted at /api/plugins/<name>. Inherits /api middleware (auth, rate limits). */
  readonly router: Router;
  readonly logger: PluginLogger;
  /** This plugin's entry from QUORUMPROOF_PLUGIN_CONFIG (or {}). Treat as read-only. */
  readonly config: Readonly<Record<string, unknown>>;
  /** Host API version, for plugins that support several. */
  readonly apiVersion: number;
  /** Adds a check reported under /health as `plugin:<name>:<checkName>`. */
  registerHealthCheck(checkName: string, check: () => Promise<PluginHealthResult>): void;
}

export interface QuorumProofPlugin {
  /** Unique, URL-safe: /^[a-z0-9][a-z0-9-]{0,62}$/ */
  readonly name: string;
  /** Plugin's own semver, reported in logs. */
  readonly version: string;
  /** Host API version this plugin targets. Must equal PLUGIN_API_VERSION. */
  readonly apiVersion: number;

  /** Called once at startup. Throwing aborts loading of this plugin only. */
  setup(ctx: PluginContext): void | Promise<void>;

  /**
   * Called for every broadcast event. Runs off the request path, with a
   * timeout; errors are logged and never propagate to the host.
   */
  onEvent?(event: PluginEvent): void | Promise<void>;

  /** Called on graceful shutdown, in reverse load order. */
  teardown?(): void | Promise<void>;
}

/** A module's default export may be the plugin itself or a (possibly async) factory. */
export type PluginModuleExport =
  | QuorumProofPlugin
  | ((config: Readonly<Record<string, unknown>>) => QuorumProofPlugin | Promise<QuorumProofPlugin>);

export type { StructuredLogger };
