/**
 * src/lib/apiClient.ts
 *
 * Thin typed API client wrapping the browser fetch API.
 *
 * Features (Issue #1448):
 *  - Single shared API_BASE constant
 *  - Normalised error handling: non-ok responses throw ApiError
 *  - JSON parsing + runtime shape validation via a caller-supplied guard
 *  - AbortController support: callers pass a signal for cancellation
 *  - Typed response helpers: apiGet / apiPost
 */

export const API_BASE: string = (import.meta.env.VITE_API_URL as string | undefined) ?? 'http://localhost:3000';

// ── Error type ────────────────────────────────────────────────────────────────

export class ApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly body: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

// ── Response validation ───────────────────────────────────────────────────────

/** A simple runtime shape guard: returns true if the value matches type T. */
export type ShapeGuard<T> = (value: unknown) => value is T;

/**
 * Noop guard — cast the response as T without any runtime check.
 * Use only when callers have already validated the shape via other means.
 */
export function unsafeCast<T>(): ShapeGuard<T> {
  return (_v): _v is T => true;
}

// ── Core request helper ───────────────────────────────────────────────────────

export interface RequestOptions {
  /** AbortController signal for request cancellation. */
  signal?: AbortSignal;
  headers?: Record<string, string>;
}

async function request<T>(
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
  path: string,
  body: unknown | undefined,
  guard: ShapeGuard<T>,
  opts: RequestOptions = {},
): Promise<T> {
  const url = `${API_BASE}${path}`;
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...opts.headers,
  };

  const response = await fetch(url, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal: opts.signal,
  });

  let data: unknown;
  try {
    data = await response.json();
  } catch {
    data = null;
  }

  if (!response.ok) {
    const message =
      typeof data === 'object' && data !== null && 'error' in data
        ? String((data as Record<string, unknown>).error)
        : `HTTP ${response.status}`;
    throw new ApiError(message, response.status, data);
  }

  if (!guard(data)) {
    throw new ApiError(
      `Unexpected response shape from ${method} ${path}`,
      response.status,
      data,
    );
  }

  return data;
}

// ── Public helpers ────────────────────────────────────────────────────────────

export function apiGet<T>(
  path: string,
  guard: ShapeGuard<T>,
  opts?: RequestOptions,
): Promise<T> {
  return request('GET', path, undefined, guard, opts);
}

export function apiPost<T>(
  path: string,
  body: unknown,
  guard: ShapeGuard<T>,
  opts?: RequestOptions,
): Promise<T> {
  return request('POST', path, body, guard, opts);
}
