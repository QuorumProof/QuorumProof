/**
 * v1 Compatibility Layer (Issue #1310)
 *
 * Normalises responses produced by the existing route handlers into the
 * envelope shape that v1 clients expect, and backfills field aliases that
 * v2 will rename.
 *
 * Design:
 *  - The existing handler code is NOT modified — it stays the canonical
 *    implementation for both versions.
 *  - This middleware intercepts `res.json()` after the handler runs and
 *    applies a deterministic transform *only* when `req.apiVersion === 'v1'`.
 *  - v2 (and unversioned /api/*) routes are completely unaffected.
 *
 * v1 envelope contract
 * ─────────────────────
 * Every successful (2xx) response is wrapped in:
 *   { ok: true, version: "v1", data: <original body> }
 *
 * Every error (4xx / 5xx) response is wrapped in:
 *   { ok: false, version: "v1", error: <string>, details?: <original body> }
 *
 * Field aliases (applied inside `data` for object and array-of-object responses)
 * ────────────────────────────────────────────────────────────────────────────
 * v2 name          → v1 alias (kept alongside for forward compat)
 * metadata_hash    → metadata
 * stellar_address  → address
 */

import { Request, Response, NextFunction } from 'express';

// ─── Type helpers ─────────────────────────────────────────────────────────────

type JsonValue = string | number | boolean | null | JsonObject | JsonArray;
type JsonObject = { [key: string]: JsonValue };
type JsonArray = JsonValue[];

// ─── Field alias map ──────────────────────────────────────────────────────────

/**
 * Pairs of [v2_field_name, v1_alias].
 * The alias is *added* alongside the canonical name so code that already
 * uses the canonical name keeps working.
 */
const FIELD_ALIASES: Array<[string, string]> = [
  ['metadata_hash', 'metadata'],
  ['stellar_address', 'address'],
];

// ─── Transform helpers ────────────────────────────────────────────────────────

function applyAliases(obj: JsonObject): JsonObject {
  const result: JsonObject = { ...obj };
  for (const [canonical, alias] of FIELD_ALIASES) {
    if (canonical in result && !(alias in result)) {
      result[alias] = result[canonical];
    }
  }
  return result;
}

function transformValue(value: JsonValue): JsonValue {
  if (Array.isArray(value)) {
    return value.map((item) =>
      item !== null && typeof item === 'object' && !Array.isArray(item)
        ? applyAliases(item as JsonObject)
        : item
    );
  }
  if (value !== null && typeof value === 'object') {
    return applyAliases(value as JsonObject);
  }
  return value;
}

function wrapSuccessEnvelope(body: JsonValue): JsonObject {
  return {
    ok: true,
    version: 'v1',
    data: transformValue(body),
  };
}

function wrapErrorEnvelope(body: JsonValue): JsonObject {
  const errMsg =
    body !== null && typeof body === 'object' && !Array.isArray(body)
      ? ((body as JsonObject).error as string | undefined) ?? 'An error occurred'
      : String(body);

  return {
    ok: false,
    version: 'v1',
    error: errMsg,
    details: body,
  };
}

// ─── Middleware ───────────────────────────────────────────────────────────────

/**
 * Intercepts `res.json()` for v1 requests only.
 *
 * This middleware must be mounted *before* the route handlers so that the
 * patched `res.json` is in place when the handler calls it.
 */
export function v1Compat(req: Request, res: Response, next: NextFunction): void {
  if (req.apiVersion !== 'v1') {
    next();
    return;
  }

  const originalJson = res.json.bind(res);

  // Override res.json to apply the envelope transform
  res.json = function wrappedJson(body?: JsonValue): Response {
    const statusCode = res.statusCode;
    const isError = statusCode >= 400;

    const envelope = isError
      ? wrapErrorEnvelope(body ?? null)
      : wrapSuccessEnvelope(body ?? null);

    return originalJson(envelope);
  };

  // Emit a header so clients can detect the compat layer is active
  res.setHeader('X-API-Compat-Layer', 'v1');

  next();
}
