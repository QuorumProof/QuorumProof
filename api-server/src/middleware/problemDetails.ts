/**
 * RFC 9457 Problem Details middleware (Issue #1428).
 *
 * Provides a shared formatter and Express error-handler for consistent,
 * machine-readable error responses across v1 and v2.
 *
 * Response shape:
 * {
 *   "type":   "https://quorumproof.io/errors/not-found",   // URI (unique per error class)
 *   "title":  "Not Found",                                 // short, human-readable summary
 *   "status": 404,                                         // HTTP status code (mirrored)
 *   "detail": "Recovery request not found",               // instance-specific explanation
 *   "error":  "Recovery request not found"                // v1 backward-compat alias for "detail"
 * }
 *
 * Content-Type is set to "application/problem+json" as required by RFC 9457.
 *
 * v1 backward-compatibility:
 *   The `error` field mirrors `detail` so existing clients that read
 *   `body.error` continue to work without modification.
 *
 * Usage — send a ProblemDetails response from a route handler:
 *
 *   import { problemJson } from '../middleware/problemDetails.js';
 *
 *   res.status(404).json(problemJson(404, 'not-found', 'Recovery request not found'));
 *
 * Usage — register the error handler in Express (after all routes):
 *
 *   import { problemDetailsErrorHandler } from '../middleware/problemDetails.js';
 *   app.use(problemDetailsErrorHandler);
 */

import { Request, Response, NextFunction } from 'express';

const BASE_TYPE_URI = 'https://quorumproof.io/errors';

/** Default titles for common HTTP status codes. */
const DEFAULT_TITLES: Record<number, string> = {
  400: 'Bad Request',
  401: 'Unauthorized',
  403: 'Forbidden',
  404: 'Not Found',
  405: 'Method Not Allowed',
  409: 'Conflict',
  410: 'Gone',
  422: 'Unprocessable Entity',
  429: 'Too Many Requests',
  500: 'Internal Server Error',
  501: 'Not Implemented',
  503: 'Service Unavailable',
};

export interface ProblemDetails {
  /** Absolute URI that identifies the problem type. */
  type: string;
  /** Short, human-readable summary of the problem type (does not change between occurrences). */
  title: string;
  /** HTTP status code. */
  status: number;
  /** Human-readable explanation specific to this occurrence of the problem. */
  detail: string;
  /** v1 backward-compatibility alias for `detail`. */
  error: string;
  /** Optional: URI that identifies the specific occurrence of the problem. */
  instance?: string;
  /** Optional: any additional extension members. */
  [key: string]: unknown;
}

/**
 * Build a ProblemDetails object.
 *
 * @param status  - HTTP status code (e.g. 404)
 * @param slug    - kebab-case error slug used to construct the `type` URI
 *                  (e.g. "not-found" → "https://quorumproof.io/errors/not-found")
 * @param detail  - Instance-specific error detail (shown to the client)
 * @param extras  - Optional additional fields merged into the object
 */
export function problemJson(
  status: number,
  slug: string,
  detail: string,
  extras?: Record<string, unknown>,
): ProblemDetails {
  return {
    type: `${BASE_TYPE_URI}/${slug}`,
    title: DEFAULT_TITLES[status] ?? 'Error',
    status,
    detail,
    // v1 backward-compat: keep `error` as an alias for `detail`
    error: detail,
    ...extras,
  };
}

/**
 * Express middleware that writes a problem+json response.
 *
 * Use this to centralise the Content-Type header:
 *
 *   res.status(400);
 *   sendProblem(res, problemJson(400, 'validation-failed', 'credentialId is required'));
 */
export function sendProblem(res: Response, problem: ProblemDetails): void {
  res.setHeader('Content-Type', 'application/problem+json');
  res.status(problem.status).json(problem);
}

/**
 * Express global error handler (4-argument signature).
 *
 * Catches any error thrown (or passed via `next(err)`) and formats it as
 * Problem Details.  Mount this AFTER all route handlers:
 *
 *   app.use(problemDetailsErrorHandler);
 */
export function problemDetailsErrorHandler(
  err: Error & { status?: number; statusCode?: number; slug?: string },
  _req: Request,
  res: Response,
  _next: NextFunction,
): void {
  const status = err.status ?? err.statusCode ?? 500;
  const slug   = err.slug ?? (status === 500 ? 'internal-server-error' : 'error');
  const detail = err.message || 'An unexpected error occurred';

  res.setHeader('Content-Type', 'application/problem+json');
  res.status(status).json(problemJson(status, slug, detail));
}
