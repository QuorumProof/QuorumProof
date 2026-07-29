# API Documentation Auto-Generation — QuorumProof API Server

Issue #1309. Hand-maintained API docs go stale the moment a route changes.
This replaces them with an OpenAPI 3.1 document generated from typed
definitions that live next to the code, served as interactive Swagger UI
and ReDoc pages, plus a TypeScript client generated from that same
document.

## Contents

1. [How it's generated](#how-its-generated)
2. [Endpoints](#endpoints)
3. [Adding or changing a documented endpoint](#adding-or-changing-a-documented-endpoint)
4. [TypeScript client library](#typescript-client-library)
5. [What's intentionally not documented](#whats-intentionally-not-documented)

---

## How it's generated

The spec is assembled by [`src/openapi/index.ts`](../src/openapi/index.ts)
from:

- **`src/openapi/components.ts`** — shared schemas, security schemes
  (`bearerAuth` for session JWTs, `apiKeyAuth` for the `x-api-key` header),
  and tags. A handful of request schemas (`VerifyBatchClaimsRequest`,
  `NotificationSendRequest`, etc.) are imported directly from
  [`src/middleware/validate.ts`](../src/middleware/validate.ts) — the
  actual AJV JSON Schema objects the server validates requests against —
  so the documented request shape can never drift from what's enforced at
  runtime.
- **`src/openapi/paths/*.ts`** — one file per route module (mirroring
  `src/routes/*.ts`), each exporting a typed `PathsFragment` of operation
  definitions (summary, parameters, request/response schemas).

`buildOpenApiSpec()` is called fresh on every request to
`/api-docs/openapi.json`, not read from a static file — the served spec is
always in sync with what's checked into `src/openapi/`.

Only routers that are actually `app.use()`'d in
[`src/index.ts`](../src/index.ts) are represented. A few route modules
(`auth.ts`, `passwordlessAuth.ts`, `bridge.ts`, `graphql.ts`, `reports.ts`,
`costs.ts`, `verification.ts`, `audit.ts`, `authAudit.ts`) exist in the
codebase but aren't currently wired into the running app — only exercised
directly by their own unit tests — so documenting them would describe
endpoints that 404 in practice. `tests/docs.test.ts` asserts they stay
excluded; once one of those routers is actually mounted, add its path
file and delete the corresponding assertion.

## Endpoints

| Path                     | What                                                    |
|---------------------------|---------------------------------------------------------|
| `GET /api-docs/openapi.json` | The generated OpenAPI 3.1 document (JSON)             |
| `GET /api-docs/`             | Swagger UI — interactive, supports "try it out"       |
| `GET /api-docs/redoc`        | ReDoc — three-pane reference viewer, better for reading |

None of these are gated behind auth — they describe the API's shape, not
its data.

## Adding or changing a documented endpoint

1. Find (or create) the matching file in `src/openapi/paths/` — e.g. a
   change to `src/routes/webhooks.ts` belongs in
   `src/openapi/paths/webhooks.ts`.
2. Update the operation's parameters / request body / responses. Reuse a
   `$ref` to an existing `components.schemas` entry where one already
   fits; add a new one to `src/openapi/components.ts` if not. If the route
   uses `validate(schemas.xyz)` from `middleware/validate.ts`, reference
   that schema directly (see `components.ts` for the existing examples)
   instead of re-describing it by hand.
3. If you newly mount a previously-unmounted router in `src/index.ts`,
   add its path file to the `mergePaths(...)` call in
   `src/openapi/index.ts` and delete the matching assertion in
   `tests/docs.test.ts`'s "does not document routers that are not
   actually mounted" test.
4. Run `npm test -- docs.test.ts` — it checks the spec is valid OpenAPI
   3.1 shape, every `$ref` resolves, and the mounted-routers-only
   invariant above.
5. Run `npm run generate:client` to refresh the on-disk spec snapshot
   (`openapi/openapi.json`, committed) and the generated TypeScript
   client (`generated/`, gitignored — regenerated on demand, see below).

## TypeScript client library

`generated/client/` is produced by [`@hey-api/openapi-ts`](https://heyapi.dev/)
from `openapi/openapi.json`, configured in
[`openapi-ts.config.ts`](../openapi-ts.config.ts). It's a `fetch`-based
client: one typed function per operation (`getHealth`, `postApiVerifyBatch`,
...), plus the request/response TypeScript types.

```bash
npm run generate:client   # regenerates openapi/openapi.json, then generated/client/
```

`generated/` is gitignored (like `dist/`) since it's fully derived from
`openapi/openapi.json`, which *is* committed. Consumers (the `frontend/`
or `dashboard/` packages, or an external service) run the command above
after pulling, or point their own `openapi-ts` config at
`api-server/openapi/openapi.json` / the live `/api-docs/openapi.json`
endpoint.

Usage once generated:

```ts
import { client, getHealth, postApiVerifyBatch } from '../api-server/generated/client';

client.setConfig({ baseUrl: 'https://api.quorumproof.io' });

const { data } = await postApiVerifyBatch({
  body: { items: [{ credential_id: 42, claim_type: 'degree' }] },
});
```

## What's intentionally not documented

See [How it's generated](#how-its-generated) above — routers not mounted
in `src/index.ts` are excluded on purpose. Everything else that's live
under `/api`, `/auth`, `/health`, `/metrics`, `/rpc`, `/events`, or
`/ws/metrics` is covered.
