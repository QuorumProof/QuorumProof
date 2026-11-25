# fix(api-server): route server logging through the structured logger and lint against `console.log`

Closes #1980

---

## 1. Summary

`api-server/src/notifications.ts` and `api-server/src/db.ts` were the last two
server modules writing directly to the console. Their output bypassed the
pino-based structured logger (`src/services/logger.ts`), so it carried no
service/module metadata, no consistent level, and — critically — none of the
logger's redaction rules. Notification recipients (email addresses and phone
numbers) were printed in plain text to stdout and to the on-disk log that
promtail ships to Loki.

This PR:

1. replaces every `console.log` in those two modules with `logger.info` /
   `logger.error` / `logger.debug`;
2. passes notification recipients through a field name already covered by the
   logger's redact list, so PII is censored rather than persisted;
3. adds a minimal ESLint flat config for `api-server` (which previously had no
   linter at all) that makes `console.log` an error in `src/`, with a narrow
   exemption for the operator-facing migration CLI; and
4. runs that lint in CI so the regression cannot silently return.

No functional behaviour, public API, database schema, or response shape is
changed.

---

## 2. Problem

Repo-wide audit of `api-server/src` (excluding tests) before this change found
nine files still using the console. Two of them were in the scope of this
issue:

| File | Line | Old statement |
| --- | --- | --- |
| `src/notifications.ts` | 137 | ``console.log(`[EMAIL] To: ${to} \| ${message}`)`` |
| `src/notifications.ts` | 145 | ``console.log(`[SMS] To: ${phone} \| ${message}`)`` |
| `src/db.ts` | 66–72 | `console.error(JSON.stringify({ ts, level, service, msg, error }))` |
| `src/db.ts` | 76–81 | `console.log(JSON.stringify({ ts, level, service, msg }))` |

Consequences:

- **No correlation.** Lines did not share the `{ service, module, ... }` shape
  used by every other module, and the hand-built JSON in `db.ts` duplicated a
  subset of the logger's base fields while omitting the rest.
- **No redaction.** `logger.ts` declares a pino `redact` policy
  (`password`, `token`, `authorization`, `otp`, `code`, `secret`,
  `privateKey`, `private_key`, `contact_value`, `contactValue`, censor
  `[REDACTED]`). Bypassing the logger disabled all of it. Notification
  destinations are PII and were written verbatim.
- **Inconsistent levels.** `db.ts` hard-coded `"level": "debug"` for a routine
  connection event in a raw string, so `LOG_LEVEL` had no effect on it.
- **Unstructured stdout.** Loki/promtail ingestion relies on JSON lines with a
  stable field set; the notification lines were plain text and broke label
  extraction.

The existing structured logger is already the norm: `index.ts`, all
`routes/*` handlers, `middleware/ipWhitelist.ts`, `middleware/structuredLogging.ts`,
`services/healthCheck.ts`, `services/gracefulShutdown.ts`, and the plugin
registry all use it.

---

## 3. Changes in detail

### 3.1 `api-server/src/notifications.ts`

Added the logger import alongside the existing pool import:

```ts
import { getPool } from './db.js';
import { logger } from './services/logger.js';
import type { Pool as PgPool } from 'pg';
```

The two simulated delivery stubs now emit structured records:

```ts
async function sendEmail(to: string, message: string): Promise<void> {
  logger.info('Notification email dispatched', 'notifications', {
    channel: 'email',
    contact_value: to,
    message,
  });
}

async function sendSms(phone: string, message: string): Promise<void> {
  logger.info('Notification SMS dispatched', 'notifications', {
    channel: 'sms',
    contact_value: phone,
    message,
  });
}
```

Key decisions:

- **`module: 'notifications'`** matches the tag convention used by every other
  call site (e.g. `'http'`, `'dashboard'`, `'recovery'`), so the existing
  `MODULE_LOGS=notifications:debug` override works without extra wiring.
- **Recipient field is `contact_value`, not `to`/`phone`.** `contact_value` is
  already in the logger's `redact.paths`, so the value is emitted as
  `[REDACTED]`. This deliberately avoids adding new PII-bearing field names and
  avoids widening the redact list. The trade-off is that operators cannot see
  the destination in logs; the batch key (address + issuer) and the persisted
  `notification_history` row remain available for operational debugging. The
  rationale is captured in a doc comment above each stub.
- **`channel` and `message` stay visible.** The channel is needed to debug
  provider selection, and the message is a template that contains only
  credential IDs — no recipient data.
- Both stubs remain `async` and still resolve, so batching, history insertion,
  success/error accounting, and the `NotificationRecord` shape are untouched.
  Because `error` is still derived from a thrown provider error, a real
  provider integration will continue to mark `success: false` correctly.

The Supabase/Postgres-backed preference CRUD, history queries, batch timers,
and test reset helpers are unchanged.

### 3.2 `api-server/src/db.ts`

Added `import { logger } from './services/logger.js';` and replaced the two
hand-rolled JSON blocks in `initPool`:

```ts
pool.on('error', (err: Error) => {
  logger.error('Idle database client error', 'db', { error: err.message });
});

pool.on('connect', () => {
  logger.debug('New database connection established', 'db');
});
```

- **`module: 'db'`** names the pool as a subsystem.
- The `error` handler keeps its original guarantee: connection-level failures
  are logged instead of surfacing as unhandled promise rejections that would
  crash the process.
- The logger now supplies `ts`, `level`, and `service`, removing the duplicated
  timestamp/serialisation work and guaranteeing the same field set as the rest
  of the process.

Behavioural note (intentional): `connect` is a `debug` record, so with the
default `LOG_LEVEL=info` it is no longer printed. Previously the raw
`console.log` fired unconditionally even at `info`. This aligns the pool with
the rest of the codebase and makes verbosity controllable via `LOG_LEVEL` /
`MODULE_LOGS=db:debug`; the `error` path is unchanged in visibility.

No pool lifecycle, configuration, metrics, or export signature changed. The
`getPoolMetrics` / Prometheus helpers added in #1559 are untouched.

### 3.3 `api-server/eslint.config.js` (new)

`api-server` had no ESLint configuration, so nothing prevented new
`console.log` calls. This PR adds the smallest config that enforces the policy
without adopting a general style ruleset that would flag the existing codebase:

```js
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist/**', 'node_modules/**', 'coverage/**'] },
  {
    files: ['src/**/*.ts'],
    languageOptions: {
      parser: tseslint.parser,
      ecmaVersion: 2022,
      sourceType: 'module',
    },
    rules: {
      'no-console': ['error', { allow: ['warn', 'error'] }],
    },
  },
  {
    // Operator-facing migration CLI: terminal output is its user interface.
    files: ['src/migrations/cli.ts'],
    rules: { 'no-console': 'off' },
  },
);
```

Design rationale:

- **Only `no-console` is enabled.** Extending `js.configs.recommended` or
  `tseslint.configs.recommended` would surface a large backlog of unrelated
  findings and make this PR unmergeable. The rule is the deliverable; broader
  lint adoption can be sequenced separately.
- **`warn` / `error` are temporarily allowed.** Six modules outside this
  issue's scope still use `console.warn`/`console.error`
  (`routes/auth.ts`, `routes/credentials.ts`, `ws/pubsub.ts`,
  `services/webhooks.ts`, `services/sessionManager.ts`, `services/mfa.ts`).
  Failing on them would either block CI or force unrelated changes into this
  PR. `console.log` — the unstructured logging path this issue is about — is
  now an error. Once the remaining call sites are migrated, the allow-list can
  be dropped and the rule becomes a hard ban.
- **`src/migrations/cli.ts` is exempt.** It is a CLI entry point whose stdout
  *is* the operator interface; structured file logging would be wrong there.
  The exemption is file-scoped, not a global escape hatch, so a new
  `console.log` in any other `src/` file still fails.
- The config uses `typescript-eslint`'s parser so `.ts` syntax parses without
  enabling type-aware linting (which would require project references and
  materially slow CI).

### 3.4 `api-server/package.json`

- New script: `"lint": "eslint src"`.
- New dev dependencies: `eslint@^9.39.5`, `typescript-eslint@^8.74.0`
  (`package-lock.json` updated accordingly; the lockfile diff is large because
  ESLint's transitive tree is added to a project that had none).

No runtime dependencies changed, so the production image is unaffected.

### 3.5 `.github/workflows/ci.yml`

The existing `api-contract-tests` job already checks out the repo, sets up
Node 20 with npm caching, and runs `npm ci` in `api-server`. A lint step is
inserted before the tests:

```yaml
      - run: npm ci
      # Issue #1980: server logging must go through the structured logger so
      # output carries request IDs and redaction (enforced by no-console).
      - run: npm run lint
      - run: npm test -- contract-tests.test.ts
```

This makes the rule enforceable on every PR rather than a file nobody runs.
(If reviewers prefer job granularity, the step can be lifted into a dedicated
`api-server-lint` job; the command is identical.)

### 3.6 `PR_DESCRIPTION.md`

Replaced with this document.

---

## 4. Before / after

Before (notification dispatch):

```text
[EMAIL] To: alice@example.com | 1 credential updates for credentials #42.
```

After:

```json
{"level":"info","time":"2026-11-25T02:00:42.539Z","service":"quorumproof-api","module":"notifications","channel":"email","contact_value":"[REDACTED]","message":"1 credential updates for credentials #42.","msg":"Notification email dispatched"}
```

Before (pool connect):

```json
{"ts":"2026-11-25T02:00:42.500Z","level":"debug","service":"quorumproof-api","msg":"New database connection established"}
```

After (visible with `LOG_LEVEL=debug` or `MODULE_LOGS=db:debug`):

```json
{"level":"debug","time":"2026-11-25T02:00:42.500Z","service":"quorumproof-api","module":"db","msg":"New database connection established"}
```

---

## 5. Request-ID coverage — scope note

The structured logger does not attach a request ID automatically; call sites in
HTTP handlers pass `req.requestId` explicitly (see `routes/dashboard.ts`,
`routes/admin.ts`, `middleware/ipWhitelist.ts`). The two modules changed here
are **not** in a request scope:

- pool `connect`/`error` are process-lifecycle events with no associated
  request; and
- `sendEmail`/`sendSms` run from `flushBatch`, which is invoked by a
  `setTimeout` after the originating request has completed.

Threading `req.requestId` through `dispatchNotification` → batch entry →
flush would change a public function signature and its tests, and is not
required by the issue's task list. Correlation for these records is provided by
`module`, `channel`, and the batch's address/issuer key instead. If request
correlation for notification delivery is wanted, the follow-up is to add an
optional `requestId` to `dispatchNotification` and store it on `BatchEntry`; the
logger already accepts arbitrary metadata, so no logger change is needed.

---

## 6. Risk assessment

| Risk | Likelihood | Mitigation / evidence |
| --- | --- | --- |
| Notification tests assert on console output | Low | `tests/notifications.test.ts` only asserts on persisted history and resolved promises; 22/22 still pass. |
| Recipient no longer visible in logs | Medium (intentional) | PII must not be logged; full recipient remains in `notification_history` and is retrievable via `getHistory`. |
| Pool `connect` lines disappear at default log level | Medium (intentional) | `LOG_LEVEL=debug` or `MODULE_LOGS=db:debug` restores them; documented above. |
| Logger file destination unavailable (tests/CI) | Low | `services/logger.ts` already falls back to stdout-only when the log directory cannot be created. |
| ESLint dependency weight / lockfile churn | Low | Dev-only, `npm ci` in CI already runs; no runtime impact. |
| New lint rule blocks unrelated future PRs | Low | Rule is `console.log`-only with a documented allow-list and CLI exemption. |
| Import cycle `db.ts` → `logger.ts` | None | `logger.ts` imports only `pino`, `fs`, `path`; it does not import `db.ts`. |

---

## 7. Validation

All commands run from `api-server/`.

### 7.1 Targeted lint

```console
$ npx eslint src/db.ts src/notifications.ts
(no output)
exit: 0
```

### 7.2 Prove the rule actually fires (and the exemption holds)

```console
$ printf 'console.log("x");\n' | npx eslint --stdin --stdin-filename src/probe.ts

/.../api-server/src/probe.ts
  1:1  error  Unexpected console statement. Only these console methods are allowed: warn, error  no-console

✖ 1 problem (1 error, 0 warnings)

$ printf 'console.log("x");\n' | npx eslint --stdin --stdin-filename src/migrations/cli.ts
exit: 0
```

### 7.3 Affected test suite

```console
$ npx vitest --run tests/notifications.test.ts

 ✓ tests/notifications.test.ts  (22 tests) 245ms

 Test Files  1 passed (1)
      Tests  22 passed (22)
```

Observed log lines during the run confirm the new shape and redaction:

```json
{"level":"info","time":"...","service":"quorumproof-api","module":"notifications","channel":"email","contact_value":"[REDACTED]","message":"1 credential updates for credentials #1749001.","msg":"Notification email dispatched"}
```

### 7.4 Type check — pre-existing blocker

```console
$ npx tsc --noEmit
src/routes/credentials.ts(328,1): error TS1005: '}' expected.
```

This is **not caused by this PR**. `src/routes/credentials.ts` is unchanged and
clean in `git status`; its file in `HEAD` ends at line 327 with a literal
`/* … truncated 13614 chars … */` placeholder, so the file has never parsed in
this checkout. Because parsing that file fails, a full-project `npm run lint`
also stops at the same file. No diagnostic points at `db.ts`,
`notifications.ts`, or any other file touched here. Restoring that file is a
separate task; until then the api-server lint/type CI steps cannot be fully
green regardless of this PR.

### 7.5 Commands a reviewer can rerun

```bash
cd api-server
npm ci
npx eslint src/db.ts src/notifications.ts
npx vitest --run tests/notifications.test.ts
npx tsc --noEmit          # expect only the credentials.ts TS1005 above
```

---

## 8. Reviewer guide

Suggested reading order (small diff, ~40 lines of source):

1. `api-server/src/db.ts` — two hunks, confirms the error handler still logs and
   the connect event is now level-controlled.
2. `api-server/src/notifications.ts` — two stubs plus a doc comment; confirm the
   `contact_value` naming rationale and unchanged async contract.
3. `api-server/eslint.config.js` — check the scope (`src/**/*.ts`), the
   `warn`/`error` allow-list, and the single-file CLI exemption.
4. `.github/workflows/ci.yml` — confirm the lint step precedes the tests in the
   api-server job.

Checklist:

- [ ] No `console.log` remains in `src/notifications.ts` or `src/db.ts`.
- [ ] No recipient address is emitted in cleartext.
- [ ] `success`/`error` accounting and history persistence unchanged.
- [ ] Lint rule fails on `console.log` but passes the migration CLI.
- [ ] No runtime dependency added.

---

## 9. Follow-ups (out of scope)

1. Migrate the remaining `console.warn`/`console.error` sites
   (`routes/auth.ts`, `routes/credentials.ts`, `ws/pubsub.ts`,
   `services/webhooks.ts`, `services/sessionManager.ts`, `services/mfa.ts`)
   and then drop the allow-list so `no-console` is a hard error.
2. Restore the truncated `api-server/src/routes/credentials.ts` so api-server
   lint and type checks can pass end-to-end.
3. Optionally thread `requestId` into notification batching for request-level
   correlation (see §5).

---

## 10. Issue

Closes #1980 — "Server Code Logs Directly With `console.log`".
Filed from the QuorumProof gap review (`sbom/QuorumProof_125.md`).
