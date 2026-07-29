# API Versioning — QuorumProof API Server

This document describes the versioning strategy for the QuorumProof API server,
the deprecation schedule for v1, and the migration path to v2.

## Contents

1. [URL Path Versioning](#url-path-versioning)
2. [Version Catalogue](#version-catalogue)
3. [Deprecation Schedule](#deprecation-schedule)
4. [v1 Response Envelope](#v1-response-envelope)
5. [v2 Changes](#v2-changes)
6. [Backward-Compatible Unversioned Routes](#backward-compatible-unversioned-routes)
7. [Response Headers](#response-headers)
8. [Error Responses](#error-responses)
9. [Client Migration Guide](#client-migration-guide)
10. [Architecture Notes](#architecture-notes)

---

## URL Path Versioning

All versioned endpoints follow the pattern:

```
/api/{version}/{resource}
```

Examples:

```
GET /api/v1/credentials/:id
GET /api/v2/credentials/:id
POST /api/v1/slices
GET /api/v1/verify/:id
```

The version segment is always a lowercase `v` followed by an integer (`v1`, `v2`, …).

Requests to an unknown version receive `404 Not Found`:

```json
{
  "error": "Unknown API version",
  "message": "Version \"v99\" is not supported. Supported versions: v1, v2.",
  "supported_versions": ["v1", "v2"],
  "docs": "https://docs.quorumproof.io/api/versioning"
}
```

---

## Version Catalogue

| Version | Status      | Stable Since | Maintenance Date | Sunset Date  |
|---------|-------------|--------------|-----------------|--------------|
| v1      | Stable      | 2025-01-01   | 2026-09-01      | 2027-03-01   |
| v2      | Development | —            | GA: 2026-09-01  | —            |

**Status definitions:**

- **Stable** — production-ready, no breaking changes, all bug fixes applied.
- **Development** — active feature work, may have breaking changes between minor versions.
- **Maintenance** — security and critical bug fixes only; no new features.
- **Deprecated** — EOL announced; breaking-change header emitted on every response.
- **Sunset** — removed; returns `410 Gone`.

---

## Deprecation Schedule

### v1 Timeline

| Date           | Event                                                        |
|----------------|--------------------------------------------------------------|
| 2026-09-01     | v1 enters **maintenance** mode; `Deprecation` header emitted |
| 2026-09-01     | v2 reaches **GA / Stable**                                   |
| 2027-01-01     | v1 status changes to **deprecated**; migration warnings added to logs |
| 2027-03-01     | v1 **sunset** — all requests return `410 Gone`               |

### What happens at each stage

**Maintenance (2026-09-01):**
Every v1 response will include:
```
Deprecation: 2026-09-01
Sunset: 2027-03-01
Link: <https://docs.quorumproof.io/api/migration/v1-to-v2>; rel="successor-version"
X-API-Deprecation-Info: v1 enters maintenance on 2026-09-01 and will be sunset on 2027-03-01.
```

**Sunset (2027-03-01):**
All `/api/v1/*` requests return:
```http
HTTP/1.1 410 Gone
Content-Type: application/json

{
  "error": "API version sunset",
  "message": "Version \"v1\" has been retired and is no longer available.",
  "docs": "https://docs.quorumproof.io/api/versioning"
}
```

---

## v1 Response Envelope

All v1 responses are wrapped in a standard envelope to ease client-side error
handling. The `ok` flag allows clients to check success without inspecting the
HTTP status code.

### Success (2xx)

```json
{
  "ok": true,
  "version": "v1",
  "data": { ... }
}
```

Example — `GET /api/v1/slices/1`:

```json
{
  "ok": true,
  "version": "v1",
  "data": {
    "id": "1",
    "creator": "GABC…",
    "attestors": ["GATT1", "GATT2"],
    "threshold": 2,
    "metadata_hash": "abc123",
    "metadata": "abc123"
  }
}
```

### Error (4xx / 5xx)

```json
{
  "ok": false,
  "version": "v1",
  "error": "<human-readable message>",
  "details": { ... }
}
```

### v1 Field Aliases

v2 renames several fields for consistency. v1 responses include **both** the
canonical v2 name and the v1 alias so migration can be done incrementally.

| v2 field name    | v1 alias       |
|------------------|----------------|
| `metadata_hash`  | `metadata`     |
| `stellar_address`| `address`      |

---

## v2 Changes

v2 is in active development. Planned breaking changes vs v1:

### No response envelope

v2 returns resource objects directly:

```json
{
  "id": "1",
  "creator": "GABC…",
  "attestors": ["GATT1"],
  "threshold": 1
}
```

### Field renames

| v1 name          | v2 name          |
|------------------|------------------|
| `metadata`       | `metadata_hash`  |
| `address`        | `stellar_address`|

### RFC 9457 error format

Errors use the [Problem Details](https://www.rfc-editor.org/rfc/rfc9457) schema:

```json
{
  "type": "https://docs.quorumproof.io/errors/not-found",
  "title": "Resource not found",
  "status": 404,
  "detail": "Credential 99 does not exist"
}
```

### New endpoints (v2-only)

| Path                             | Description                                |
|----------------------------------|--------------------------------------------|
| `GET /api/v2/proof-requests`     | Managed ZK proof-request lifecycle         |
| `POST /api/v2/proof-requests`    | Create a new proof request                 |
| `GET /api/v2/revocation-registry`| Batch revocation with time-locks           |
| `GET /api/v2/bbs-credentials`    | BBS+ selective-disclosure credential list  |

---

## Backward-Compatible Unversioned Routes

The original `/api/*` paths remain available for backward compatibility. They
behave identically to v2 (raw responses, no envelope).

These paths will be **sunset together with v1 on 2027-03-01**. Clients on
unversioned paths should migrate to `/api/v1` or `/api/v2`.

```
GET /api/credentials  →  GET /api/v1/credentials  (with envelope)
GET /api/credentials  →  GET /api/v2/credentials  (without envelope)
```

---

## Response Headers

Every versioned request receives an `API-Version` header confirming which
version was matched:

```
API-Version: v1
```

When a version is in maintenance or deprecated state:

```
Deprecation: 2026-09-01
Sunset: 2027-03-01
Link: <https://docs.quorumproof.io/api/migration/v1-to-v2>; rel="successor-version"
X-API-Deprecation-Info: v1 enters maintenance on 2026-09-01 and will be sunset on 2027-03-01.
```

v1 responses also include:

```
X-API-Compat-Layer: v1
```

---

## Error Responses

### Unknown version

```http
HTTP/1.1 404 Not Found

{
  "error": "Unknown API version",
  "message": "Version \"v99\" is not supported. Supported versions: v1, v2.",
  "supported_versions": ["v1", "v2"],
  "docs": "https://docs.quorumproof.io/api/versioning"
}
```

### Sunset version

```http
HTTP/1.1 410 Gone

{
  "error": "API version sunset",
  "message": "Version \"v1\" has been retired and is no longer available.",
  "docs": "https://docs.quorumproof.io/api/versioning"
}
```

---

## Client Migration Guide

### From unversioned `/api/*` to `/api/v1`

1. **Add `/v1` to your base URL:**

   ```diff
   - const BASE = 'https://api.quorumproof.io/api';
   + const BASE = 'https://api.quorumproof.io/api/v1';
   ```

2. **Unwrap the response envelope:**

   ```typescript
   const raw = await fetch(`${BASE}/credentials/${id}`).then(r => r.json());
   const credential = raw.data; // was: raw directly
   ```

3. **Update error handling:**

   ```typescript
   if (!raw.ok) {
     throw new Error(raw.error);
   }
   ```

4. **Field aliases:** `metadata_hash` is now also available as `metadata`,
   `stellar_address` as `address`. Both are present in v1 responses so no
   rename is strictly required — but prefer the canonical v2 names for
   forward compatibility.

### From `/api/v1` to `/api/v2`

1. **Change your base URL:**

   ```diff
   - const BASE = 'https://api.quorumproof.io/api/v1';
   + const BASE = 'https://api.quorumproof.io/api/v2';
   ```

2. **Remove envelope unwrapping** — v2 returns the resource directly:

   ```diff
   - const credential = response.data;
   + const credential = response;
   ```

3. **Remove `ok` checks** — use HTTP status codes instead:

   ```diff
   - if (!raw.ok) throw new Error(raw.error);
   + if (!response.ok) throw new Error(data.detail ?? data.title);
   ```

4. **Rename fields** if you switched to v2 canonical names:
   - `metadata` → `metadata_hash`
   - `address` → `stellar_address`

5. **Update error handling** to [RFC 9457 Problem Details](https://www.rfc-editor.org/rfc/rfc9457).

---

## Architecture Notes

### Middleware stack

```
CORS → DDoS protection → json body → rate limiter
  → apiVersionMiddleware       # parses /api/vN segment, sets req.apiVersion
      ├─ /api/v1/*  →  v1Compat middleware  →  v1Router
      ├─ /api/v2/*  →  (no compat)          →  v2Router
      └─ /api/*     →  (no versioning)      →  legacy routers (backward compat)
```

### Route handler reuse

Route handlers (`createCredentialsRouter`, `createSlicesRouter`, etc.) are
**not duplicated**. Both v1 and v2 routers import the same factory-created
router instances. The `v1Compat` middleware intercepts `res.json()` after the
handler runs to apply the envelope transform, leaving handler code untouched.

### Adding a v2-only or breaking change

1. Create a new router in `src/routes/v2/`:
   ```typescript
   // src/routes/v2/credentials.ts
   export function createCredentialsRouterV2(...) { ... }
   ```

2. Import and mount it in `src/routes/v2/index.ts`, overriding the shared handler:
   ```typescript
   import { createCredentialsRouterV2 } from './credentials.js';
   router.use('/credentials', createCredentialsRouterV2(soroban));
   ```

3. Leave `src/routes/v1/index.ts` unchanged — v1 clients are unaffected.

### Version catalogue updates

The single source of truth for version lifecycle dates is the
`VERSION_CATALOGUE` constant in `src/middleware/apiVersion.ts`. Updating
the `status` field automatically changes the headers emitted on every
response — no other code changes are required to enter maintenance mode.

```typescript
// src/middleware/apiVersion.ts
v1: {
  status: 'maintenance',   // ← change this when entering maintenance
  maintenanceDate: '2026-09-01',
  sunsetDate: '2027-03-01',
  ...
},
```
