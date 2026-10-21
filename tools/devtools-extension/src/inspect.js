// tools/devtools-extension/src/inspect.js — pure helpers for the QuorumProof DevTools panel (#1674).
//
// Nothing in this file touches the Chrome APIs, so it can be unit-tested with `node --test`.
// The panel (panel.js) feeds it HAR-style entries from chrome.devtools.network.

/** Soroban RPC methods the panel records. Other JSON-RPC traffic is ignored. */
export const SOROBAN_METHODS = Object.freeze([
  'simulateTransaction',
  'sendTransaction',
  'getTransaction',
  'getEvents',
  'getLedgerEntries',
  'getLatestLedger',
]);

/** Methods that represent a contract invocation or its outcome (shown as "contract" calls). */
export const CONTRACT_METHODS = new Set(['simulateTransaction', 'sendTransaction', 'getTransaction', 'getEvents']);

/**
 * Parse a request body. Returns { method, params } for a recorded Soroban RPC call, or null.
 * @param {string | undefined | null} postText
 */
export function parseRpcRequest(postText) {
  if (!postText) return null;
  let body;
  try {
    body = JSON.parse(postText);
  } catch {
    return null;
  }
  if (!body || typeof body.method !== 'string') return null;
  if (!SOROBAN_METHODS.includes(body.method)) return null;
  return { method: body.method, params: body.params ?? {} };
}

/**
 * Parse a JSON-RPC response body. Returns { result, error } with whichever is present.
 * @param {string | undefined | null} text
 */
export function parseRpcResponse(text) {
  if (!text) return { result: undefined, error: undefined };
  try {
    const body = JSON.parse(text);
    return { result: body.result, error: body.error };
  } catch {
    return { result: undefined, error: { message: 'Response is not valid JSON' } };
  }
}

/**
 * Summarise the outcome of a call so the panel can show it at a glance.
 * Only fields the RPC documents are read; XDR payloads are passed through untouched because
 * decoding them needs the Stellar SDK, which the extension does not bundle yet.
 */
export function summarizeResult(method, result) {
  if (!result || typeof result !== 'object') return {};
  switch (method) {
    case 'sendTransaction':
      return {
        hash: result.hash,
        status: result.status,
        errorResultXdr: result.errorResultXdr,
      };
    case 'getTransaction':
      return {
        status: result.status,
        ledger: result.ledger,
        createdAt: result.createdAt,
        resultXdr: result.resultXdr,
      };
    case 'simulateTransaction':
      return {
        latestLedger: result.latestLedger,
        minResourceFee: result.minResourceFee,
        cost: result.cost,
        resultCount: Array.isArray(result.results) ? result.results.length : 0,
        eventCount: Array.isArray(result.events) ? result.events.length : 0,
        restorePreamble: Boolean(result.restorePreamble),
        error: result.error,
      };
    case 'getEvents':
      return { eventCount: Array.isArray(result.events) ? result.events.length : 0, latestLedger: result.latestLedger };
    case 'getLedgerEntries':
      return { entryCount: Array.isArray(result.entries) ? result.entries.length : 0 };
    default:
      return {};
  }
}

/**
 * Classify a finished call as ok, failed or pending for colour-coding.
 * @returns {"ok" | "failed" | "pending" | "error"}
 */
export function classify(method, summary, error) {
  if (error) return 'error';
  if (method === 'simulateTransaction' && summary.error) return 'failed';
  if (method === 'sendTransaction') {
    if (summary.status === 'ERROR') return 'failed';
    if (summary.status === 'PENDING' || summary.status === 'DUPLICATE' || summary.status === 'TRY_AGAIN_LATER') {
      return 'pending';
    }
    return 'ok';
  }
  if (method === 'getTransaction') {
    if (summary.status === 'FAILED') return 'failed';
    if (summary.status === 'NOT_FOUND') return 'pending';
    return 'ok';
  }
  return 'ok';
}

/**
 * Build one display row from a HAR-style network entry.
 * @param {{ request: { postData?: { text?: string } }, time?: number, startedDateTime?: string }} harEntry
 * @param {string} responseText  body returned by request.getContent()
 * @returns {null | {method, kind, status, durationMs, startedAt, summary, error, params, raw}}
 */
export function buildRow(harEntry, responseText) {
  const req = parseRpcRequest(harEntry?.request?.postData?.text);
  if (!req) return null;
  const { result, error } = parseRpcResponse(responseText);
  const summary = summarizeResult(req.method, result);
  return {
    method: req.method,
    kind: CONTRACT_METHODS.has(req.method) ? 'contract' : 'read',
    status: classify(req.method, summary, error),
    durationMs: Math.round(harEntry.time ?? 0),
    startedAt: harEntry.startedDateTime ?? '',
    summary,
    error: error ?? null,
    params: req.params,
    raw: { request: req, response: result ?? error ?? null },
  };
}
