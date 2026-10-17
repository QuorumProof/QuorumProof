import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

export class WebhookUrlValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WebhookUrlValidationError';
  }
}

function isBlockedIpv4(address: string): boolean {
  const octets = address.split('.').map(Number);
  const [a, b, c] = octets;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && (b === 0 || b === 168)) ||
    (a === 192 && b === 88 && c === 99) ||
    (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
    (a === 203 && b === 0 && c === 113) ||
    a >= 224
  );
}

function parseIpv6(address: string): number[] | null {
  if (address.includes('%')) return null;

  let normalized = address.toLowerCase();
  const embeddedIpv4 = normalized.match(/(?:^|:)(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (embeddedIpv4) {
    const octets = embeddedIpv4[1].split('.').map(Number);
    if (octets.some((octet) => octet > 255)) return null;
    const hex = `${((octets[0] << 8) | octets[1]).toString(16)}:${((octets[2] << 8) | octets[3]).toString(16)}`;
    normalized = normalized.slice(0, embeddedIpv4.index) + (embeddedIpv4[0].startsWith(':') ? ':' : '') + hex;
  }

  const halves = normalized.split('::');
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(':') : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  if (halves.length === 1 && left.length !== 8) return null;
  const missing = 8 - left.length - right.length;
  if (missing < 0 || (halves.length === 2 && missing < 1)) return null;
  const parts = [...left, ...Array(missing).fill('0'), ...right];
  if (parts.length !== 8 || parts.some((part) => !/^[\da-f]{1,4}$/.test(part))) return null;
  return parts.map((part) => parseInt(part, 16));
}

function isBlockedIpv6(address: string): boolean {
  const groups = parseIpv6(address);
  if (!groups) return true;
  if (groups.every((group) => group === 0)) return true;
  if (groups.slice(0, 7).every((group) => group === 0) && groups[7] === 1) return true;

  const isMappedIpv4 =
    groups.slice(0, 5).every((group) => group === 0) && groups[5] === 0xffff;
  if (isMappedIpv4) {
    const ipv4 = `${groups[6] >> 8}.${groups[6] & 0xff}.${groups[7] >> 8}.${groups[7] & 0xff}`;
    return isBlockedIpv4(ipv4);
  }

  const first = groups[0];
  const isGlobalUnicast = (first & 0xe000) === 0x2000;
  const isDocumentation = groups[0] === 0x2001 && groups[1] === 0x0db8;
  return !isGlobalUnicast || isDocumentation;
}

function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return !isBlockedIpv4(address);
  if (family === 6) return !isBlockedIpv6(address);
  return false;
}

function isLocalHostname(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, '');
  return ['localhost', 'local', 'internal', 'test', 'invalid', 'example'].some(
    (suffix) => host === suffix || host.endsWith(`.${suffix}`),
  );
}

export async function validateWebhookUrl(value: string): Promise<void> {
  let target: URL;
  try {
    target = new URL(value);
  } catch {
    throw new WebhookUrlValidationError('url must be a valid absolute URL');
  }

  if (!['http:', 'https:'].includes(target.protocol) || target.username || target.password) {
    throw new WebhookUrlValidationError('url must use http or https and must not include credentials');
  }

  const hostname = target.hostname.replace(/^\[|\]$/g, '');
  if (!hostname || isLocalHostname(hostname)) {
    throw new WebhookUrlValidationError('url must target a publicly routable host');
  }

  if (isIP(hostname)) {
    if (!isPublicAddress(hostname)) {
      throw new WebhookUrlValidationError('url must not target a private, loopback, link-local, or reserved address');
    }
    return;
  }

  let addresses: Awaited<ReturnType<typeof lookup>>;
  try {
    addresses = await lookup(hostname, { all: true, verbatim: true });
  } catch {
    throw new WebhookUrlValidationError('url hostname must resolve to a public address');
  }

  if (addresses.length === 0 || addresses.some(({ address }) => !isPublicAddress(address))) {
    throw new WebhookUrlValidationError('url hostname must resolve only to public addresses');
  }
}
