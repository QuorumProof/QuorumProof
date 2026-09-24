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
// Credential query filtering (Issue #1563)
// ---------------------------------------------------------------------------

/**
 * Fields that may be used as server-side credential query filters.  Only these
 * fields are accepted; anything else is rejected to prevent unbounded or
 * injection-prone queries.  `credential_type` and `status` are the common,
 * indexed fields.
 */
export const CREDENTIAL_FILTER_FIELDS = ['credential_type', 'status'] as const;

export type CredentialFilterField = (typeof CREDENTIAL_FILTER_FIELDS)[number];

/**
 * Allowed values per filter field.  Values are validated against this map so
 * that only known, safe values reach the query layer.
 */
export const CREDENTIAL_FILTER_VALUES: Record<CredentialFilterField, readonly string[]> = {
  credential_type: ['PE', 'EX', 'AC', 'DE'],
  status: ['active', 'revoked', 'expired', 'pending'],
};

/**
 * A single parsed credential filter, e.g. `{ field: 'credential_type', value: 'PE' }`.
 */
export interface CredentialFilter {
  field: CredentialFilterField;
  value: string;
}

/**
 * Parses and validates credential query filters from a request query object.
 *
 * Supported syntax: `?credential_type=PE&status=active`.  Unknown fields,
 * non-string values, and values outside the allow-list are rejected.
 *
 * Returns `{ filters }` on success or `{ error }` with a human-readable
 * message on failure.  The returned filters are safe to pass to the query
 * layer (parameterised), never interpolated into SQL.
 */
export function parseCredentialFilters(
  query: unknown,
): { filters: CredentialFilter[] } | { error: string } {
  if (typeof query !== 'object' || query === null) {
    return { filters: [] };
  }

  const filters: CredentialFilter[] = [];
  const record = query as Record<string, unknown>;

  for (const key of Object.keys(record)) {
    if (!(CREDENTIAL_FILTER_FIELDS as readonly string[]).includes(key)) {
      return { error: `Unknown filter field: ${key}` };
    }

    const raw = record[key];
    if (typeof raw !== 'string') {
      return { error: `Filter ${key} must be a single string value` };
    }

    const field = key as CredentialFilterField;
    const allowed = CREDENTIAL_FILTER_VALUES[field];
    if (!allowed.includes(raw)) {
      return { error: `Invalid value for ${key}: ${raw}` };
    }

    filters.push({ field, value: raw });
  }

  return { filters };
}

/**
 * Custom validator for the credential query endpoint.  Rejects unknown filter
 * fields and invalid values before the handler runs.
 */
export const credentialFilterValidator: CustomValidator = (data) => {
  const result = parseCredentialFilters(data);
  return 'error' in result ? result.error : true;
};

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
       

/* … truncated 3359 chars — edit only what you need near the top … */
