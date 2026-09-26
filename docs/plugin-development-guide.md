# Plugin Development Guide

> Issue #1647. Extend the QuorumProof API server without forking it.
> Runtime: [`api-server/src/plugins/`](../api-server/src/plugins/).
> Example: [`examples/plugins/event-stats/`](../examples/plugins/event-stats/).

---

## 1. Plugin architecture

A plugin is an ES module loaded into the API-server process at startup. It
gets a narrow, versioned context — not the Express `app` or internal services —
so plugins can't accidentally depend on internals that change between releases.

```
                  QUORUMPROOF_PLUGINS=a,b
                            │
   startup ── migrations ── loadPluginsFromEnv() ── listen()
                            │
             PluginRegistry.load(spec)            (src/plugins/registry.ts)
               import(spec) → default export
               factory(config)?  → validatePlugin() → setup(ctx)
                            │
      ┌─────────────────────┼──────────────────────────┐
      ▼                     ▼                          ▼
 ctx.router            onEvent(event)           registerHealthCheck()
 /api/plugins/<name>   fan-out from             /health  →
 (behind /api auth,    broadcastEvent()         plugin:<name>:<check>
  rate limits, etc.)   async, time-boxed
                            │
                 SIGTERM → teardown() (reverse order)
```

### Extension points

| Hook | When | Notes |
|---|---|---|
| `setup(ctx)` | Once, before the server listens. | Register routes and health checks here. Throwing skips this plugin (or aborts startup with `PLUGINS_STRICT=true`). |
| `ctx.router` | Mounted at `/api/plugins/<name>`. | All `/api` middleware applies: CORS, rate limiting, API-key limits, request signing, IP allow-list, concurrency limiter. |
| `onEvent(event)` | Every event broadcast to WebSocket subscribers (`credential_issued`, `credential_attested`, `credential_revoked`, …). | Fire-and-forget off the request path; timed out after `PLUGIN_EVENT_TIMEOUT_MS` (5 s). Errors are logged and counted, never propagated. |
| `ctx.registerHealthCheck(name, fn)` | Polled by `/health`. | Returning `unhealthy` makes `/health` return 503 — use `degraded` for non-critical problems. |
| `teardown()` | Graceful shutdown. | 10 s limit. Close sockets, flush buffers. |
| `ctx.logger` | Anytime. | Logs under module `plugin:<name>`; tune with `MODULE_LOGS=plugin:<name>:debug`. |
| `ctx.config` | Anytime. | Frozen copy of this plugin's entry in `QUORUMPROOF_PLUGIN_CONFIG`. |

### The contract

```ts
// api-server/src/plugins/types.ts
export interface QuorumProofPlugin {
  readonly name: string;        // /^[a-z0-9][a-z0-9-]{0,62}$/, unique
  readonly version: string;     // your semver
  readonly apiVersion: number;  // must equal PLUGIN_API_VERSION (1)
  setup(ctx: PluginContext): void | Promise<void>;
  onEvent?(event: PluginEvent): void | Promise<void>;
  teardown?(): void | Promise<void>;
}
```

The default export may be the plugin object or a factory
`(config) => QuorumProofPlugin | Promise<QuorumProofPlugin>`. Prefer the
factory — it keeps state per instance and makes tests trivial.

### Isolation guarantees

- A plugin whose `setup()` throws is skipped; others still load.
- `onEvent` runs after the host has already broadcast the event; a slow or
  failing plugin cannot delay WebSocket or webhook delivery.
- Events are frozen copies — plugins cannot mutate what other plugins see.
- Plugins run **in-process** with full Node privileges. Isolation protects
  availability, not security: only install plugins you would merge into the
  codebase (see [§6](#6-security-review-checklist)).

### Versioning

`PLUGIN_API_VERSION` is bumped only for breaking changes to `types.ts`.
Additive changes (new optional hooks, new context fields) keep the version.
A plugin targeting a different version is rejected at load time with a clear
error rather than failing at runtime.

---

## 2. Creating a plugin

The walkthrough builds the example in
[`examples/plugins/event-stats/`](../examples/plugins/event-stats/index.js):
per-type event counters, a stats endpoint, an optional forwarder, and a
health check.

### Layout

```
my-plugin/
  package.json     "type": "module", keyword "quorumproof-plugin",
                   "quorumproof": { "apiVersion": 1 }
  index.js         default export: factory
  test/
  README.md        config keys, routes, health checks
```

Plain JavaScript with `// @ts-check` and JSDoc typedefs pointing at
`api-server/src/plugins/types.ts` gives type checking with no build step.
TypeScript is fine too — publish the compiled `.js`.

### Minimal plugin

```js
// @ts-check
/** @returns {import('quorumproof-api-server/src/plugins/types.js').QuorumProofPlugin} */
export default function createPlugin(config = {}) {
  return {
    name: 'hello',
    version: '0.1.0',
    apiVersion: 1,
    setup(ctx) {
      ctx.router.get('/', (_req, res) => res.json({ hello: config.who ?? 'world' }));
      ctx.logger.info('hello plugin ready');
    },
  };
}
```

### Adding behaviour

```js
setup(ctx) {
  ctx.router.get('/stats', (_req, res) => res.json(Object.fromEntries(counts)));
  ctx.registerHealthCheck('forwarder', async () =>
    failures >= threshold ? { status: 'degraded', message: `${failures} failures` }
                          : { status: 'healthy' });
},
async onEvent(event) {
  counts.set(event.type, (counts.get(event.type) ?? 0) + 1);
  if (forwardUrl) await forward(event);   // throw on failure → counted by host
},
teardown() { counts.clear(); },
```

### Running it locally

From `api-server/`:

```bash
QUORUMPROOF_PLUGINS=../examples/plugins/event-stats/index.js \
QUORUMPROOF_PLUGIN_CONFIG='{"../examples/plugins/event-stats/index.js":{"forwardUrl":"http://localhost:9999"}}' \
MODULE_LOGS=plugin:event-stats:debug \
npm run dev

curl localhost:3000/api/plugins/event-stats/stats
curl localhost:3000/health     # includes plugin:event-stats:forwarder
```

### Configuration reference

| Variable | Default | |
|---|---|---|
| `QUORUMPROOF_PLUGINS` | — | Comma-separated specifiers, loaded in order. Package names resolve from `node_modules`; `./`, `../` and absolute paths resolve from the working directory. |
| `QUORUMPROOF_PLUGIN_CONFIG` | `{}` | JSON object keyed by the exact specifier used in `QUORUMPROOF_PLUGINS`. Invalid JSON aborts startup. |
| `PLUGINS_STRICT` | `false` | `true` refuses to start if any plugin fails to load. Recommended in production. |
| `PLUGIN_EVENT_TIMEOUT_MS` | `5000` | Per-call `onEvent` timeout. |

Secrets belong in environment variables or a secret store the plugin reads
itself, not in `QUORUMPROOF_PLUGIN_CONFIG` (which is often logged by
deployment tooling).

### Do / don't

| Do | Don't |
|---|---|
| Keep `onEvent` fast; queue heavy work. | Block the event loop (sync crypto, large JSON on the hot path). |
| Validate all request input on your routes. | Assume `/api` auth means callers are trusted for *your* operation. |
| Use `degraded` for optional dependencies. | Return `unhealthy` for something that shouldn't take the pod out of rotation. |
| Clean up timers and sockets in `teardown`. | Leave intervals running — they keep the process alive past shutdown. |
| Import only from `plugins/types.ts`. | Import other `api-server/src/**` modules; they are not a stable API. |

---

## 3. Testing plugins

Test in three layers. The example's
[`test/event-stats.test.js`](../examples/plugins/event-stats/test/event-stats.test.js)
shows all three.

### 3.1 Contract

Check what the host's `validatePlugin()` checks, so a bad manifest fails in
your CI rather than at startup:

```js
const p = createPlugin();
expect(p.name).toMatch(/^[a-z0-9][a-z0-9-]{0,62}$/);
expect(p.apiVersion).toBe(1);
```

When developing inside this repo you can call the real validator:

```ts
import { validatePlugin } from '../api-server/src/plugins/index.js';
validatePlugin(createPlugin());
```

### 3.2 Unit — fake context

Build a `PluginContext` with a real `express.Router()`, spy loggers and an
in-memory health-check map. Inject network dependencies (e.g. `fetch`) through
the factory so they can be stubbed:

```js
const healthChecks = new Map();
const ctx = {
  router: Router(), config: {}, apiVersion: 1,
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  registerHealthCheck: (n, fn) => healthChecks.set(n, fn),
};
const p = createEventStatsPlugin({ forwardUrl: 'https://x.test' }, { fetch: vi.fn() });
await p.setup(ctx);
await p.onEvent({ type: 'credential_issued', timestamp: new Date().toISOString() });
```

Call `onEvent` directly and `await` it — in the host it is fire-and-forget,
but in tests you want deterministic ordering.

### 3.3 HTTP — supertest

Mount `ctx.router` on a bare Express app at the same path the host uses:

```js
const app = express().use('/api/plugins/event-stats', ctx.router);
const res = await request(app).get('/api/plugins/event-stats/stats');
expect(res.status).toBe(200);
```

### 3.4 Integration with the real registry (in-repo)

```ts
import { PluginRegistry } from '../src/plugins/registry.js';

const registry = new PluginRegistry({ strict: true, eventTimeoutMs: 100 });
await registry.register(createPlugin({}), {});
registry.emit({ type: 'credential_issued', timestamp: new Date().toISOString() });
await new Promise((r) => setTimeout(r, 10));
expect(registry.list()[0].eventsDelivered).toBe(1);
await registry.teardownAll();
```

Also worth covering: `setup()` throwing (plugin skipped), `onEvent` exceeding
the timeout (counted in `eventErrors`), and `teardown()` releasing resources.

### 3.5 Checklist before release

- [ ] Contract test passes against the current `PLUGIN_API_VERSION`.
- [ ] Every route validates input and has a supertest case for bad input.
- [ ] `onEvent` tested for success, thrown error and slow dependency.
- [ ] `teardown` leaves no open handles (`vitest --run` exits cleanly).
- [ ] Loaded once in a local API server with `PLUGINS_STRICT=true`.

---

## 4. Distributing plugins

### npm (recommended)

1. Name it `quorumproof-plugin-<name>` or `@scope/quorumproof-plugin-<name>`.
2. Add the `quorumproof-plugin` keyword and
   `"quorumproof": { "apiVersion": 1 }` to `package.json` so compatibility
   is visible before install.
3. List `express` as a **peerDependency**, not a dependency, so routes share
   the host's Express instance.
4. Ship only runtime files (`"files": [...]`).
5. Follow semver: bump **major** when your routes/config change incompatibly
   *or* when you move to a new `apiVersion`.

Operators install and enable it:

```bash
cd api-server
npm install @acme/quorumproof-plugin-audit@1.2.0
export QUORUMPROOF_PLUGINS=@acme/quorumproof-plugin-audit
```

### Container images

The API-server image doesn't include third-party plugins. Build a derived
image so the plugin set is pinned and reviewed like any other change:

```dockerfile
FROM quorumproof/api-server:1.4.0
RUN npm install --omit=dev @acme/quorumproof-plugin-audit@1.2.0
ENV QUORUMPROOF_PLUGINS=@acme/quorumproof-plugin-audit \
    PLUGINS_STRICT=true
```

Roll it out like any api-server release (see
[blue-green-deployment.md](./blue-green-deployment.md)).

### In-repo / private plugins

For organisation-internal plugins, a path specifier is fine:
`QUORUMPROOF_PLUGINS=/opt/quorumproof/plugins/internal-audit/index.js`. Mount
the directory read-only.

### Listing in the ecosystem

Open a PR adding your plugin to the table below with its name, npm
package, supported `apiVersion`, and a one-line description.

| Plugin | Package | apiVersion | Description |
|---|---|---|---|
| event-stats | `examples/plugins/event-stats` (in-repo) | 1 | Per-type event counters with optional forwarder. Reference example. |

---

## 5. Troubleshooting

| Symptom | Cause |
|---|---|
| `Plugin failed to load: … targets apiVersion 2, host provides 1` | Plugin built for a newer host; upgrade the API server or pin an older plugin. |
| `invalid plugin name` | Name must be lowercase alphanumerics and dashes, ≤ 63 chars. |
| `plugin X is already registered` | Same plugin listed twice, or two plugins share a name. |
| Routes 404 | Plugin failed to load (check `plugins` logs) or path missing the `/api/plugins/<name>` prefix. |
| Routes 401/429 | `/api` middleware (auth, rate limiting) applies to plugin routes too. |
| `onEvent timed out` in logs | Handler exceeds `PLUGIN_EVENT_TIMEOUT_MS`; queue work instead of awaiting it. |
| Process doesn't exit on SIGTERM | A timer/socket not closed in `teardown`. |

---

## 6. Security review checklist

Plugins run with the server's privileges and environment (contract ids,
database URL, RPC keys). Before enabling one in production:

- [ ] Source reviewed; version pinned exactly (no `^`/`~`).
- [ ] Dependencies scanned (`npm audit`, and `deny.toml` policy for any
      native code).
- [ ] Outbound hosts known and allowed by network policy.
- [ ] Routes don't expose PII without the same authorisation checks as
      core routes (see [gdpr-compliance.md](./gdpr-compliance.md)).
- [ ] `PLUGINS_STRICT=true` so a missing plugin fails fast instead of
      silently running without it.
