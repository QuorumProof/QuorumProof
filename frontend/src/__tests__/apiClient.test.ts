/**
 * Tests for Issue #1448 — shared typed API client (src/lib/apiClient.ts).
 *
 * Covers: error normalisation, shape guard rejection, cancellation via
 * AbortController, and GET / POST helpers.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { apiGet, apiPost, ApiError, unsafeCast } from '../lib/apiClient';

// ── Mock fetch ────────────────────────────────────────────────────────────────

const mockFetch = vi.fn<typeof fetch>();

beforeEach(() => {
  vi.stubGlobal('fetch', mockFetch);
});

afterEach(() => {
  vi.restoreAllMocks();
});

function makeResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  } as unknown as Response;
}

// ── apiGet ────────────────────────────────────────────────────────────────────

describe('apiGet', () => {
  it('returns parsed body when response is ok', async () => {
    const body = { requestId: 'gdpr_1', credentialId: 42, status: 'pending_consent', attestorConsents: [], requiredConsents: 2, requestedAt: 'now' };
    mockFetch.mockResolvedValue(makeResponse(200, body));

    const result = await apiGet('/api/test', unsafeCast());
    expect(result).toEqual(body);
  });

  it('throws ApiError with server message on non-ok response', async () => {
    mockFetch.mockResolvedValue(makeResponse(404, { error: 'Not found' }));

    await expect(apiGet('/api/test', unsafeCast())).rejects.toMatchObject({
      name: 'ApiError',
      status: 404,
      message: 'Not found',
    });
  });

  it('throws ApiError with HTTP status fallback when body has no error field', async () => {
    mockFetch.mockResolvedValue(makeResponse(500, {}));

    await expect(apiGet('/api/test', unsafeCast())).rejects.toMatchObject({
      name: 'ApiError',
      status: 500,
    });
  });

  it('throws ApiError when shape guard rejects the response', async () => {
    mockFetch.mockResolvedValue(makeResponse(200, { unexpected: true }));

    const strictGuard = (v: unknown): v is { id: string } =>
      typeof v === 'object' && v !== null && 'id' in v;

    await expect(apiGet('/api/test', strictGuard)).rejects.toMatchObject({
      name: 'ApiError',
    });
  });

  it('passes the AbortController signal to fetch', async () => {
    const controller = new AbortController();
    mockFetch.mockResolvedValue(makeResponse(200, {}));

    await apiGet('/api/test', unsafeCast(), { signal: controller.signal });

    expect(mockFetch).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ signal: controller.signal }),
    );
  });
});

// ── apiPost ───────────────────────────────────────────────────────────────────

describe('apiPost', () => {
  it('sends JSON body and returns parsed response', async () => {
    const reqBody = { credentialId: 1, subjectAddress: 'GABC', signature: 'sig' };
    const responseBody = { requestId: 'gdpr_1', credentialId: 1, status: 'pending_consent', attestorConsents: [], requiredConsents: 1, requestedAt: 'now' };
    mockFetch.mockResolvedValue(makeResponse(200, responseBody));

    const result = await apiPost('/api/gdpr/request', reqBody, unsafeCast());
    expect(result).toEqual(responseBody);

    // Verify fetch was called with POST method
    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining('/api/gdpr/request'),
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('throws ApiError on non-ok response', async () => {
    mockFetch.mockResolvedValue(makeResponse(403, { error: 'Forbidden' }));

    await expect(apiPost('/api/gdpr/request', {}, unsafeCast())).rejects.toMatchObject({
      name: 'ApiError',
      status: 403,
      message: 'Forbidden',
    });
  });
});

// ── Cancellation ──────────────────────────────────────────────────────────────

describe('AbortController cancellation', () => {
  it('propagates AbortError when the request is cancelled', async () => {
    const controller = new AbortController();

    // Simulate fetch throwing an AbortError when aborted
    mockFetch.mockImplementation(() => {
      const err = new DOMException('The operation was aborted.', 'AbortError');
      return Promise.reject(err);
    });

    controller.abort();

    await expect(apiGet('/api/test', unsafeCast(), { signal: controller.signal }))
      .rejects.toMatchObject({ name: 'AbortError' });
  });
});
