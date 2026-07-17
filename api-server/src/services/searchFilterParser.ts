import type { FilterNode, FilterOp } from '../searchIndex.js';

const OPERATORS: ReadonlySet<string> = new Set(['gte', 'lte', 'gt', 'lt', 'regex']);
const MAX_FILTER_DEPTH = 6;

/**
 * Parses the bracket-operator / and-or-not query syntax the advanced search
 * filters use (e.g. `attestation_count[gte]=2`, `filter[or][0][and][...]`)
 * into a tree of FilterNode for SearchIndex.search() to evaluate.
 *
 * Depth is capped at MAX_FILTER_DEPTH — conditions past that depth are
 * dropped rather than erroring, bounding worst-case parse/eval cost for a
 * maliciously deep query string instead of rejecting the whole request.
 */

function parseFieldFilter(field: string, value: unknown, depth: number): FilterNode[] {
  if (depth > MAX_FILTER_DEPTH || value == null) return [];
  if (typeof value !== 'object') {
    return [{ field, op: 'eq', value: String(value) }];
  }
  const nodes: FilterNode[] = [];
  for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
    if (OPERATORS.has(key)) {
      nodes.push({ field, op: key as FilterOp, value: val });
    } else {
      // Nested field path, e.g. metadata[name][regex] -> "metadata.name"
      nodes.push(...parseFieldFilter(`${field}.${key}`, val, depth + 1));
    }
  }
  return nodes;
}

function parseGroupOrArray(value: unknown, depth: number): FilterNode[] {
  if (depth > MAX_FILTER_DEPTH || value == null) return [];
  if (Array.isArray(value)) {
    return value.map(entry => {
      const inner = parseGroup(entry, depth + 1);
      return inner.length === 1 ? inner[0] : { and: inner };
    });
  }
  return parseGroup(value, depth);
}

function parseGroup(raw: unknown, depth: number): FilterNode[] {
  if (depth > MAX_FILTER_DEPTH || raw == null || typeof raw !== 'object') return [];
  const nodes: FilterNode[] = [];
  for (const [key, val] of Object.entries(raw as Record<string, unknown>)) {
    if (key === 'and') {
      nodes.push({ and: parseGroupOrArray(val, depth + 1) });
    } else if (key === 'or') {
      nodes.push({ or: parseGroupOrArray(val, depth + 1) });
    } else if (key === 'not') {
      const inner = parseGroupOrArray(val, depth + 1);
      if (inner.length > 0) nodes.push({ not: inner.length === 1 ? inner[0] : { and: inner } });
    } else {
      nodes.push(...parseFieldFilter(key, val, depth + 1));
    }
  }
  return nodes;
}

/**
 * Reserved top-level query params that are never treated as bracket-operator
 * field filters even if their value happens to parse as an object.
 */
export const RESERVED_SEARCH_QUERY_KEYS = new Set([
  'q',
  'cursor',
  'limit',
  'sort_by',
  'sort_order',
  'facets',
  'type',
  'issuer',
  'issuer_type',
  'subject',
  'status',
  'attestation_count_min',
  'attestation_count_max',
  'created_after',
  'created_before',
  'expires_after',
  'expires_before',
  'filter',
  'owner',
  'deduplicate',
  'show_all',
  'include_versions',
  'include_score',
]);

/**
 * Builds the full filter tree from an Express `req.query` object: the
 * `filter[...]` and-or-not tree plus any top-level bracket-operator fields
 * like `attestation_count[gte]=2`.
 */
export function parseFilterTree(query: Record<string, unknown>): FilterNode[] {
  const nodes: FilterNode[] = [];

  if (query.filter !== undefined) {
    nodes.push(...parseGroup(query.filter, 0));
  }

  for (const [key, value] of Object.entries(query)) {
    if (RESERVED_SEARCH_QUERY_KEYS.has(key)) continue;
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      nodes.push(...parseFieldFilter(key, value, 0));
    }
  }

  return nodes;
}
