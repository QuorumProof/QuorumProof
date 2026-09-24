/**
 * Issue #1312 — Request Validation Middleware
 *
 * Provides a composable, schema-driven validation middleware for Express
 * endpoints.  Uses AJV for JSON Schema validation with coercion and defaults,
 * and supports custom validator functions for complex business-logic checks
 * that cannot be expressed purely in JSON Schema.
 *
 * ## Features
 *
 * 1. **JSON Schema validation** — body, query, and params can each have a
 *    JSON Schema.  Schemas are compiled once at startup and reused across
 *    requests (AJV caches compiled validators internally).
 *
 * 2. **Detailed error responses** — on validation failure the 400 body
 *    includes a `details` array describing every AJV error:
 *    `{ path, keyword, message }`.  This lets API clients surface precise
 *    field-level errors rather than a generic "invalid" message.
 *
 * 3. **Custom validators** — each location (body / query / params) accepts an
 *    optional `custom` function `(data) => true | string | string[]`.
 *    Returning a string (or array of strings) means validation failed; the
 *    string becomes the error message in the 400 response.  This is useful for
 *    cross-field invariants, Stellar address checks, etc.
 *
 * 4. **Field selection** (Issue #1569) — the `?fields=id,status` query
 *    parameter lets clients request only the fields they need, reducing
 *    response size.  See `fieldSelection` / `selectFields` below.
 *
 * ## Usage
 *
 * ```ts
 * import { validate, schemas } from '../middleware/validate.js';
 *
 * router.post(
 *   '/batch',
 *   validate({
 *     body: {
 *       schema: schemas.verifyBatch.body,
 *       custom: (data) => {
 *         const d = data as { credential_ids: number[]; slice_id: number };
 *         if (d.credential_ids.includes(d.slice_id)) {
 *           return 'slice_id must not appear in credential_ids';
 *         }
 *         return true;
 *       },
 *     },
 *   }),
 *   handler,
 * );
 * ```
 *
 * ### Field selection
 *
 * ```ts
 * import { fieldSelection, selectFields } from '../middleware/validate.js';
 *
 * router.get(
 *   '/credentials/:id',
 *   fieldSelection('credential'),
 *   (req, res) => {
 *     const credential = loadCredential(req.params.id);
 *     res.json(selectFields(credential, req, 'credential'));
 *   },
 * );
 * ```
 *
 * The `?fields=` parameter accepts a comma-separated list of field names
 * (e.g. `?fields=id,status`).  Only fields declared in the resource's field
 * schema are selectable; unknown fields produce a 400.  Fields marked
 * `permission` are only selectable when the request carries the matching
 * permission (populated by the RBAC middleware on `req.user.permissions`),
 * otherwise a 403 is returned.  When `?fields=` is omitted the full object is
 * returned unchanged.
 */

import { Request, Response, NextFunction } from 'express';
import { default as AjvLib } from 'ajv';

const Ajv = AjvLib as unknown as new (opts: Record<string, unknown>) => {
  compile: (schema: Record<string, unknown>) => AjvValidatorFn;
};
const ajv = new Ajv({ coerceTypes: true, useDefaults: true, removeAdditional: true });

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

interface AjvError {
  schemaPath: string;
  keyword: string;
  message: string;
  data: unknown;
}

interface AjvValidatorFn {
  (data: unknown): boolean;
  errors?: AjvError[];
}

/**
 * A custom validator that runs *after* the JSON Schema check passes.
 *
 * Return `true` to indicate the value is valid.
 * Return a `string` (or `string[]`) to indicate failure; the string(s) become
 * the error message(s) in the 400 response body.
 */
export type CustomValidator = (data: unknown) => true | string | string[];

/**
 * Per-location validation configuration.  You can supply either a plain JSON
 * Schema object (backward-compatible with the previous API) or a richer
 * `LocationConfig` object that also carries a custom validator.
 */
export type LocationSchema = Record<string, unknown>;

export interface LocationConfig {
  /** AJV-compatible JSON Schema for structural validation. */
  schema?: LocationSchema;
  /**
   * Custom validator for business-logic checks.
   * Runs only when the JSON Schema check passes (or when no schema is
   * provided).
   */
  custom?: CustomValidator;
}

export type LocationInput = LocationSchema | LocationConfig;

export type ValidationSchemas = {
  body?: LocationInput;
  query?: LocationInput;
  params?: LocationInput;
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Normalise a `LocationInput` to a `LocationConfig`.
 * A plain schema object is wrapped in `{ schema }`.
 */
function normalise(input: LocationInput): LocationConfig {
  if ('schema' in input || 'custom' in input) {
    return input as LocationConfig;
  }
  // Plain JSON Schema object — treat as `{ schema: input }`.
  return { schema: input as LocationSchema };
}

// ---------------------------------------------------------------------------
// Middleware factory
// ---------------------------------------------------------------------------

export function validate(schemas: ValidationSchemas) {
  type Entry = {
    location: 'body' | 'query' | 'params';
    validator: AjvValidatorFn | null;
    custom: CustomValidator | null;
  };

  const entries: Entry[] = [];

  for (const location of ['body', 'query', 'params'] as const) {
    const input = schemas[location];
    if (!input) continue;

    const cfg = normalise(input);

    const validator = cfg.schema
      ? (ajv.compile(cfg.schema) as AjvValidatorFn)
      : null;

    entries.push({
      location,
      validator,
      custom: cfg.custom ?? null,
    });
  }

  return (req: Request, res: Response, next: NextFunction): void => {
    for (const { location, validator, custom } of entries) {
      let data: unknown;
      if (location === 'body') data = req.body;
      else if (location === 'query') data = req.query;
      else data = req.params;

      // 1. JSON Schema validation
      if (validator !== null && !validator(data)) {
        const errors = validator.errors ?? [];
        res.status(400).json({
          error: 'Validation failed',
          location,
          details: errors.map((err) => ({
            path: err.schemaPath,
            keyword: err.keyword,
            message: err.message,
          })),
        });
        return;
      }

      // 2. Custom validation (only reached when schema check passes or absent)
      if (custom !== null) {
        const result = custom(data);
        if (result !== true) {
          const messages = Array.isArray(result) ? result : [result];
          res.status(400).json({
            error: 'Validation failed',
            location,
            details: messages.map((message) => ({ path: '#', keyword: 'custom', message })),
          });
          return;
        }
      }
    }

    next();
  };
}

// ---------------------------------------------------------------------------
// Field selection (Issue #1569 — Response Size Optimization)
// ---------------------------------------------------------------------------

/**
 * A single selectable field in a resource's field schema.
 *
 * - `name`       — the response property name.
 * - `permission` — optional permission required to select this field.  When
 *                  set, the request must carry the permission (via the RBAC
 *                  middleware populating `req.user.permissions`) or a 403 is
 *                  returned.
 */
export interface FieldDefinition {
  name: string;
  permission?: string;
}

/**
 * Field schema for a resource: the set of fields that may be selected via
 * `?fields=`.  Fields not listed here are never selectable.
 */
export type FieldSchema = FieldDefinition[];

/**
 * Built-in field schemas, keyed by resource name.  Extend this map as new
 * resources gain field-selection support.
 */
export const fieldSchemas: Record<string, FieldSchema> = {
  credential: [
    { name: 'id' },
    { name: 'status' },
    { name: 'issued_at' },
    { name: 'expires_at' },
    { name: 'subject' },
    { name: 'issuer' },
    { name: 'metadata', permission: 'credentials:read:metadata' },
  ],
  verification: [
    { name: 'id' },
    { name: 'status' },
    { name: 'verified_at' },
    { name: 'credential_id' },
    { name: 'details', permission: 'verifications:read:details' },
  ],
};

/**
 * Parse the `?fields=` query parameter into a list of requested field names.
 * Returns `null` when the parameter is absent (meaning: return all fields).
 */
export function parseFields(raw: unknown): string[] | null {
  if (raw === undefined || raw === null || raw === '') return null;
  const value = Array.isArray(raw) ? raw.join(',') : String(raw);
  const fields = value
    .split(',')
    .map((f) => f.trim())
    .filter((f) => f.length > 0);
  return fields.length > 0 ? fields : null;
}

/**
 * Extract the permissions granted to the current request.  The RBAC
 * middleware is expected to populate `req.user.permissions` (array of
 * strings).  Absent user/permissions means no permissions.
 */
function requestPermissions(req: Request): string[] {
  const user = (req as Request & { user?: { permissions?: unknown } }).user;
  const perms = user?.permissions;
  return Array.isArray(perms) ? perms.filter((p): p is string => typeof p === 'string') : [];
}

/**
 * Express middleware that validates the `?fields=` query parameter against a
 * resource's field schema and enforces per-field permissions.
 *
 * - Unknown fields → 400.
 * - Fields requiring a permission the request lacks → 403.
 * - Valid selections are stored on `req.selectedFields` for `selectFields`.
 */
export function fieldSelection(resource: string) {
  const schema = fieldSchemas[resource];
  const byName = new Map<string, FieldDefinition>();
  if (schema) {
    for (const field of schema) byName.set(field.name, field);
  }

  return (req: Request, res: Response, next: NextFunction): void => {
    const requested = parseFields(req.query.fields);
    if (requested === null) {
      next();
      return;
    }

    if (!schema) {
      res.status(400).json({
        error: 'Validation failed',
        location: 'query',
        details: [{ path: '#/fields', keyword: 'unknownResource', message: `unknown resource '${resource}'` }],
      });
      return;
    }

    const unknown = requested.filter((f) => !byName.has(f));
    if (unknown.length > 0) {
      res.status(400).json({
        error: 'Validation failed',
        location: 'query',
        details: unknown.map((f) => ({
          path: '#/fields',
          keyword: 'unknownField',
          message: `unknown field '${f}' for resource '${resource}'`,
        })),
      });
      return;
    }

    const permissions = requestPermissions(req);
    const forbidden = requested.filter((f) => {
      const perm = byName.get(f)?.permission;
      return perm !== undefined && !permissions.includes(perm);
    });
    if (forbidden.length > 0) {
      res.status(403).json({
        error: 'Forbidden',
        location: 'query',
        details: forbidden.map((f) => ({
          path: '#/fields',
          keyword: 'permission',
          message: `missing permission to select field '${f}'`,
        })),
      });
      return;
    }

    (req as Request & { selectedFields?: string[] }).selectedFields = requested;
    next();
  };
}

/**
 * Filter a response object down to the fields selected on the request.
 *
 * When no `?fields=` selection was made (or `fieldSelection` was not run),
 * the object is returned unchanged.  Only top-level fields are filtered;
 * nested objects are returned whole when their parent field is selected.
 */
export function selectFields<T extends Record<string, unknown>>(
  obj: T,
  req: Request,
  _resource?: string,
): Partial<T> {
  const selected = (req as Request & { selectedFields?: string[] }).selectedFields;
  if (!selected || selected.length === 0) return obj;
  const result: Partial<T> = {};
  for (const field of selected) {
    if (Object.prototype.hasOwnProperty.call(obj, field)) {
      result[field as keyof T] = obj[field as keyof T];
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Built-in custom validators
// ---------------------------------------------------------------------------

/**
 * Checks that a string value looks like a valid Stellar account address
 * (G-address, 56 characters, base32 alphabet).
 *
 * This is a lightweight format check — it does not verify the checksum.
 * Use `@stellar/stellar-sdk`'s `StrKey.isValidEd25519PublicKey` for a
 * rigorous check when the SDK is already in scope.
 */
export function stellarAddressValidator(fieldName: string): CustomValidator {
  const STELLAR_G_ADDRESS = /^G[A-Z2-7]{55}$/;
  return (data) => {
    if (typeof data !== 'object' || data === null) return true;
    const value = (data as Record<string, unknown>)[fieldName];
    if (value === undefined || value === null) return true; // required-ness enforced by schema
    if (typeof value !== 'string' || !STELLAR_G_ADDRESS.test(value)) {
      return `${fieldName} must be a valid Stellar G-address`;
    }
    return true;
  };
}

/**
 * Ensures that an array field has no duplicate values.
 */
export function noDuplicatesValidator(fieldName: string): CustomValidator {
  return (data) => {
    if (typeof data !== 'object' || data === null) return true;
    const arr = (data as Record<string, unknown>)[fieldName];
    if (!Array.isArray(arr)) return true;
    const seen = new Set();
    for (const item of arr) {
      const key = JSON.stringify(item);
      if (seen.has(key)) return `${fieldName} must not contain duplicate values`;
      seen.add(key);
    }
    return true;
  };
}

// ---------------------------------------------------------------------------
// Shared schemas
// ---------------------------------------------------------------------------

export const schemas = {
  verifyBatch: {
    body: {
      type: 'object',
      properties: {
        credential_ids: {
          type: 'array',
        },
      },
    },
  },
};
