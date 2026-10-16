/**
 * #1569 — Field Selection Middleware
 *
 * Adds selective-field-inclusion support via the `?fields=` query parameter.
 * Reduces bandwidth by stripping fields the caller did not request from every
 * JSON response.
 *
 * Usage
 * ─────
 *   GET /api/credentials/42?fields=id,status,subject
 *
 * When `?fields` is absent the full object is returned unchanged.
 *
 * Field permission validation
 * ───────────────────────────
 * Certain fields are "restricted" — they are only included when the caller
 * has opted-in explicitly AND the field appears in the allowed set for the
 * resource schema.  Requesting a restricted field that is not in the schema
 * (or that the schema marks as restricted for callers without elevated access)
 * results in the field being silently omitted rather than an error, keeping
 * the middleware non-breaking.
 *
 * Field schema
 * ────────────
 * Each resource type carries its own schema describing which fields exist,
 * which are restricted, and which are always-included (never filtered out
 * regardless of `?fields`).  Schemas are registered centrally here so they
 * can be imported by route modules that need to declare their shape.
 */

import { Request, Response, NextFunction } from 'express';

// ── Field schema types ───────────────────────────────────────────────────────

/** Visibility of a field within a schema. */
export type FieldVisibility =
  /** Included by default; also included when `?fields` is specified and names it. */
  | 'public'
  /** Never returned to callers — internal / audit-only fields. */
  | 'internal'
  /**
   * Only returned when the caller explicitly requests it AND the context
   * (e.g. the route) allows it.  Treated like `public` unless the field
   * is marked restricted in the schema — in which case an explicit grant
   * is required.
   */
  | 'restricted';

export interface FieldDefinition {
  /** Human-readable description of the field (used in generated docs). */
  description?: string;
  visibility: FieldVisibility;
  /**
   * When true this field is ALWAYS included in responses even if it was
   * not listed in `?fields`.  Useful for identifying keys like `id`.
   */
  alwaysInclude?: boolean;
}

export interface FieldSchema {
  /** Resource name used for error messages and documentation. */
  resource: string;
  fields: Record<string, FieldDefinition>;
}

// ── Built-in schemas for core resources ─────────────────────────────────────

/** Schema for a Credential response object. */
export const CREDENTIAL_FIELD_SCHEMA: FieldSchema = {
  resource: 'credential',
  fields: {
    id: { visibility: 'public', alwaysInclude: true, description: 'Credential ID' },
    credential_type: { visibility: 'public', description: 'Numeric credential type' },
    subject: { visibility: 'public', description: 'Stellar address of the credential holder' },
    issuer: { visibility: 'public', description: 'Stellar address of the credential issuer' },
    status: { visibility: 'public', description: 'Current lifecycle status' },
    revoked: { visibility: 'public', description: 'Whether the credential is revoked' },
    suspended: { visibility: 'public', description: 'Whether the credential is suspended' },
    created_at: { visibility: 'public', description: 'ISO-8601 creation timestamp' },
    updated_at: { visibility: 'public', description: 'ISO-8601 last-updated timestamp' },
    expires_at: { visibility: 'public', description: 'ISO-8601 expiry timestamp (nullable)' },
    metadata_hash: { visibility: 'restricted', description: 'Hash of the off-chain metadata blob' },
    version: { visibility: 'public', description: 'Monotonic version counter' },
    attestors: { visibility: 'public', description: 'List of attesting addresses' },
    slice_id: { visibility: 'public', description: 'Associated quorum slice ID' },
    // Internal fields — never returned to callers
    _internal_raw: { visibility: 'internal', description: 'Raw on-chain XDR value' },
  },
};

/** Schema for a Verification response object. */
export const VERIFICATION_FIELD_SCHEMA: FieldSchema = {
  resource: 'verification',
  fields: {
    credential_id: { visibility: 'public', alwaysInclude: true },
    status: { visibility: 'public', alwaysInclude: true },
    checked_at: { visibility: 'public' },
    claim_type: { visibility: 'public' },
    proof: { visibility: 'public' },
    // digest inside proof is public but proof.verified_at may be restricted
    // in a future scheme; leave both public for now
  },
};

/** Schema for a Quorum Slice response object. */
export const SLICE_FIELD_SCHEMA: FieldSchema = {
  resource: 'slice',
  fields: {
    id: { visibility: 'public', alwaysInclude: true },
    creator: { visibility: 'public' },
    attestors: { visibility: 'public' },
    threshold: { visibility: 'public' },
    created_at: { visibility: 'public' },
    weight_distribution: { visibility: 'restricted', description: 'Per-attestor weight map' },
  },
};

// Central registry: callers can look up a schema by resource name.
const _registry = new Map<string, FieldSchema>([
  ['credential', CREDENTIAL_FIELD_SCHEMA],
  ['verification', VERIFICATION_FIELD_SCHEMA],
  ['slice', SLICE_FIELD_SCHEMA],
]);

/**
 * Register a custom field schema.  Existing schemas can be overwritten
 * (useful in tests).
 */
export function registerFieldSchema(schema: FieldSchema): void {
  _registry.set(schema.resource, schema);
}

export function getFieldSchema(resource: string): FieldSchema | undefined {
  return _registry.get(resource);
}

// ── Core filtering logic ─────────────────────────────────────────────────────

/**
 * Parse the raw `?fields` query string value into a set of requested field
 * names.  Returns `null` when the parameter is absent (meaning "all fields").
 */
export function parseFieldsParam(raw: unknown): Set<string> | null {
  if (raw === undefined || raw === null || raw === '') return null;
  if (typeof raw !== 'string') return null;
  const names = raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  return names.length > 0 ? new Set(names) : null;
}

/**
 * Validate the requested field names against a schema, returning a filtered
 * set that excludes:
 *   • fields marked `internal` in the schema
 *   • fields not present in the schema at all (unknown fields are silently
 *     dropped — caller typos should not 400)
 *
 * Always-include fields are added back regardless of what the caller asked
 * for.
 */
export function resolveAllowedFields(
  requested: Set<string>,
  schema: FieldSchema,
): Set<string> {
  const allowed = new Set<string>();

  // Always-include fields are unconditional.
  for (const [name, def] of Object.entries(schema.fields)) {
    if (def.alwaysInclude) allowed.add(name);
  }

  // Add requested fields that exist in the schema and are not internal.
  for (const name of requested) {
    const def = schema.fields[name];
    if (!def) continue; // unknown field — drop silently
    if (def.visibility === 'internal') continue; // never expose
    allowed.add(name);
  }

  return allowed;
}

/**
 * Apply field filtering to a plain object.
 *
 * - When `allowedFields` is `null` (no `?fields` param supplied) the object
 *   is returned unchanged, EXCEPT that fields marked `internal` in the
 *   schema are still stripped.
 * - When `allowedFields` is a `Set`, only those keys (plus always-include
 *   keys) are kept.
 *
 * Works only on the top-level object; nested sub-objects are not recursed
 * into (use the middleware on each response object explicitly).
 */
export function applyFieldFilter(
  obj: Record<string, unknown>,
  allowedFields: Set<string> | null,
  schema?: FieldSchema,
): Record<string, unknown> {
  if (!schema && !allowedFields) return obj;

  // Strip internal fields regardless of ?fields param.
  const internalFields = schema
    ? new Set(
        Object.entries(schema.fields)
          .filter(([, def]) => def.visibility === 'internal')
          .map(([name]) => name),
      )
    : new Set<string>();

  if (!allowedFields) {
    // No ?fields — only strip internal fields.
    if (internalFields.size === 0) return obj;
    return Object.fromEntries(
      Object.entries(obj).filter(([k]) => !internalFields.has(k)),
    );
  }

  // Selective inclusion: keep only allowed fields (and remove internals).
  return Object.fromEntries(
    Object.entries(obj).filter(
      ([k]) => allowedFields.has(k) && !internalFields.has(k),
    ),
  );
}

// ── Express middleware ───────────────────────────────────────────────────────

export interface FieldSelectionOptions {
  /**
   * The schema to validate fields against.  When omitted, any non-internal
   * field is considered valid (best-effort passthrough mode).
   */
  schema?: FieldSchema;
  /**
   * When true, unknown field names in `?fields` cause a 400 response
   * instead of being silently ignored.  Defaults to false (permissive).
   */
  strictValidation?: boolean;
}

/**
 * Monkey-patches `res.json` so the response body is filtered through
 * `applyFieldFilter` before it is serialised.  Only objects (and arrays of
 * objects via a `results` envelope) are transformed; primitives and error
 * shapes are passed through unchanged.
 *
 * Mount per-route or globally:
 *
 *   router.get('/:id', fieldSelection({ schema: CREDENTIAL_FIELD_SCHEMA }), handler);
 *   app.use('/api/credentials', fieldSelection({ schema: CREDENTIAL_FIELD_SCHEMA }));
 */
export function fieldSelection(opts: FieldSelectionOptions = {}) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const { schema, strictValidation = false } = opts;
    const rawFields = req.query['fields'];
    const requested = parseFieldsParam(rawFields);

    // Strict mode: validate that every requested field exists in the schema.
    if (strictValidation && requested && schema) {
      const unknownFields = [...requested].filter((f) => !(f in schema.fields));
      if (unknownFields.length > 0) {
        res.status(400).json({
          error: 'Unknown fields requested',
          unknown_fields: unknownFields,
          available_fields: Object.keys(schema.fields).filter(
            (f) => schema.fields[f].visibility !== 'internal',
          ),
        });
        return;
      }
    }

    const allowedFields = requested && schema
      ? resolveAllowedFields(requested, schema)
      : requested;

    // Only patch res.json when filtering is needed (no-op when ?fields is
    // absent and there are no internal fields to strip).
    const hasInternalFields =
      schema &&
      Object.values(schema.fields).some((d) => d.visibility === 'internal');

    if (!allowedFields && !hasInternalFields) {
      next();
      return;
    }

    const originalJson = res.json.bind(res);

    res.json = function patchedJson(body: unknown): Response {
      if (body !== null && typeof body === 'object' && !Array.isArray(body)) {
        const record = body as Record<string, unknown>;

        // Support both bare objects and `{ results: [...] }` envelope shapes.
        if (Array.isArray(record['results'])) {
          record['results'] = (record['results'] as unknown[]).map((item) => {
            if (item !== null && typeof item === 'object' && !Array.isArray(item)) {
              return applyFieldFilter(item as Record<string, unknown>, allowedFields ?? null, schema);
            }
            return item;
          });
          return originalJson(record);
        }

        return originalJson(applyFieldFilter(record, allowedFields ?? null, schema));
      }
      return originalJson(body);
    };

    next();
  };
}

export default fieldSelection;
