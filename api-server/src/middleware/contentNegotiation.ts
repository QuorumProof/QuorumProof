/**
 * #1315 — Content Negotiation middleware
 *
 * Parses the Accept header and attaches a `respond` helper to `res.locals`
 * that serialises a payload to JSON, CSV, or XML based on the negotiated
 * media type.
 *
 * Supported types (in preference order):
 *   application/json   → JSON (default)
 *   text/csv           → CSV  (flat object arrays only; nested fields are
 *                              JSON-stringified so the output is always valid CSV)
 *   application/xml    → XML
 *   text/xml           → XML (alias)
 *
 * Usage in a route handler:
 *
 *   import { respondNegotiated } from '../middleware/contentNegotiation.js';
 *
 *   router.get('/list', (req, res) => {
 *     const data = [{ id: 1, name: 'foo' }];
 *     respondNegotiated(req, res, data, { rootElement: 'attestors', itemElement: 'attestor' });
 *   });
 *
 * The middleware itself is optional at the application level — routes call
 * `respondNegotiated` directly instead.
 */

import { Request, Response, NextFunction } from 'express';

// ── Types ────────────────────────────────────────────────────────────────────

export interface NegotiationOptions {
  /**
   * XML root-element name (default: "response").
   * Only used when the negotiated type is XML.
   */
  rootElement?: string;
  /**
   * XML element name for each item in an array (default: "item").
   * Only used when the negotiated type is XML and the payload is an array.
   */
  itemElement?: string;
  /**
   * Override the HTTP status code (default: 200).
   */
  status?: number;
}

type SupportedType = 'json' | 'csv' | 'xml';

// ── Accept-header negotiation ─────────────────────────────────────────────────

const MIME_TO_TYPE: Record<string, SupportedType> = {
  'application/json': 'json',
  'text/json': 'json',
  '*/*': 'json',
  'text/csv': 'csv',
  'application/csv': 'csv',
  'application/xml': 'xml',
  'text/xml': 'xml',
};

/**
 * Parse an Accept header value and return the negotiated internal type.
 *
 * The parser respects `q=` quality factors, picks the highest-q supported
 * type, and falls back to JSON when no acceptable match is found (rather than
 * returning 406 — changing that policy is left to individual routes).
 */
export function negotiateType(acceptHeader: string | undefined): SupportedType {
  if (!acceptHeader || acceptHeader.trim() === '') return 'json';

  // Split by comma, parse each entry: "type/subtype; q=0.9"
  const entries = acceptHeader
    .split(',')
    .map((part) => {
      const [mediaType, ...params] = part.trim().split(';');
      const qParam = params.find((p) => p.trim().startsWith('q='));
      const q = qParam ? parseFloat(qParam.split('=')[1] ?? '1') : 1;
      return { mediaType: (mediaType ?? '').trim().toLowerCase(), q: isNaN(q) ? 1 : q };
    })
    .filter((e) => e.q > 0)
    .sort((a, b) => b.q - a.q); // highest quality first

  for (const { mediaType } of entries) {
    const mapped = MIME_TO_TYPE[mediaType];
    if (mapped) return mapped;
  }

  return 'json'; // default
}

// ── CSV serialiser ────────────────────────────────────────────────────────────

/**
 * Escape a single CSV field: wrap in quotes and double any interior quotes.
 */
function csvEscape(value: unknown): string {
  const str =
    value === null || value === undefined
      ? ''
      : typeof value === 'object'
      ? JSON.stringify(value)
      : String(value);
  // Wrap in double-quotes if the value contains commas, newlines, or quotes
  if (str.includes('"') || str.includes(',') || str.includes('\n') || str.includes('\r')) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

/**
 * Serialise an array of objects to RFC 4180 CSV.
 * If `data` is a plain object, it is wrapped in a one-element array.
 * Non-array / non-object values are returned as a plain text line.
 */
export function toCSV(data: unknown): string {
  const rows: Record<string, unknown>[] = [];

  if (Array.isArray(data)) {
    for (const item of data) {
      rows.push(typeof item === 'object' && item !== null ? (item as Record<string, unknown>) : { value: item });
    }
  } else if (data !== null && typeof data === 'object') {
    rows.push(data as Record<string, unknown>);
  } else {
    return String(data ?? '');
  }

  if (rows.length === 0) return '';

  // Collect all column headers from all rows (union of keys in order of first appearance)
  const headers: string[] = [];
  const headerSet = new Set<string>();
  for (const row of rows) {
    for (const key of Object.keys(row)) {
      if (!headerSet.has(key)) {
        headerSet.add(key);
        headers.push(key);
      }
    }
  }

  const lines: string[] = [headers.map(csvEscape).join(',')];
  for (const row of rows) {
    lines.push(headers.map((h) => csvEscape(row[h])).join(','));
  }

  return lines.join('\r\n');
}

// ── XML serialiser ────────────────────────────────────────────────────────────

/**
 * Escape XML special characters in a text node.
 */
function xmlEscape(value: unknown): string {
  const str =
    value === null || value === undefined
      ? ''
      : typeof value === 'object'
      ? JSON.stringify(value)
      : String(value);
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * Recursively serialise a JavaScript value to XML.
 *
 * - Objects  → child elements named after their keys
 * - Arrays   → repeated elements named `itemTag`
 * - Scalars  → text node
 */
function valueToXml(value: unknown, tag: string, itemTag: string, depth: number): string {
  const indent = '  '.repeat(depth);
  if (Array.isArray(value)) {
    const children = value
      .map((item) => valueToXml(item, itemTag, 'item', depth + 1))
      .join('\n');
    return `${indent}<${tag}>\n${children}\n${indent}</${tag}>`;
  }
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length === 0) return `${indent}<${tag}/>`;
    const children = entries
      .map(([k, v]) => valueToXml(v, sanitizeXmlTag(k), 'item', depth + 1))
      .join('\n');
    return `${indent}<${tag}>\n${children}\n${indent}</${tag}>`;
  }
  return `${indent}<${tag}>${xmlEscape(value)}</${tag}>`;
}

/** Replace characters not allowed in XML element names with underscores. */
function sanitizeXmlTag(name: string): string {
  // XML names must start with a letter or underscore
  let safe = name.replace(/[^a-zA-Z0-9_.\-]/g, '_');
  if (/^[^a-zA-Z_]/.test(safe)) safe = `_${safe}`;
  return safe || '_';
}

/**
 * Serialise `data` to an XML string.
 */
export function toXML(
  data: unknown,
  rootElement = 'response',
  itemElement = 'item',
): string {
  const body = valueToXml(data, rootElement, itemElement, 0);
  return `<?xml version="1.0" encoding="UTF-8"?>\n${body}`;
}

// ── Content-type map ──────────────────────────────────────────────────────────

const CONTENT_TYPES: Record<SupportedType, string> = {
  json: 'application/json; charset=utf-8',
  csv: 'text/csv; charset=utf-8',
  xml: 'application/xml; charset=utf-8',
};

// ── Public helper used by route handlers ──────────────────────────────────────

/**
 * Negotiate the response format and send the payload.
 *
 * Routes call this instead of `res.json()` to support multiple formats.
 */
export function respondNegotiated(
  req: Request,
  res: Response,
  data: unknown,
  options: NegotiationOptions = {},
): void {
  const { rootElement = 'response', itemElement = 'item', status = 200 } = options;
  const type = negotiateType(req.headers['accept']);

  res.status(status);
  res.setHeader('Content-Type', CONTENT_TYPES[type]);
  // Expose negotiated type for downstream middleware (e.g. ETag)
  res.locals.negotiatedType = type;

  switch (type) {
    case 'csv':
      res.send(toCSV(data));
      break;
    case 'xml':
      res.send(toXML(data, rootElement, itemElement));
      break;
    default:
      res.json(data);
  }
}

// ── Express middleware (optional — wires negotiateType onto req for logging) ──

/**
 * Optional middleware that adds `req.negotiatedType` for logging/metrics.
 * Routes still call `respondNegotiated()` directly.
 */
export function contentNegotiationMiddleware(
  req: Request,
  _res: Response,
  next: NextFunction,
): void {
  (req as Request & { negotiatedType: SupportedType }).negotiatedType = negotiateType(
    req.headers['accept'],
  );
  next();
}
