/**
 * Shared address/ID truncation helpers for the dashboard.
 *
 * JavaScript's `String.prototype.substring` clamps negative arguments to 0,
 * so `substring(-8)` returns the entire string instead of the last 8 chars.
 * Use `.slice()` which correctly handles negative indices.
 */

/**
 * Truncate a credential ID: first 8 chars … last 8 chars.
 * Strings of 16 chars or fewer are returned unchanged.
 */
export function truncateId(id: string): string {
  if (id.length <= 16) return id
  return `${id.slice(0, 8)}...${id.slice(-8)}`
}

/**
 * Truncate an address: first 6 chars … last 4 chars.
 * Strings of 10 chars or fewer are returned unchanged.
 */
export function truncateAddress(address: string): string {
  if (address.length <= 10) return address
  return `${address.slice(0, 6)}...${address.slice(-4)}`
}
