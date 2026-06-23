const HORIZON_BY_NETWORK: Record<string, string> = {
  testnet: 'https://horizon-testnet.stellar.org',
  mainnet: 'https://horizon.stellar.org',
  futurenet: 'https://horizon-futurenet.stellar.org',
};

type HorizonAccount = {
  balances: Array<{ asset_type: string; balance: string }>;
};

export function horizonUrlForNetwork(network: string, override?: string): string {
  if (override) return override.replace(/\/$/, '');
  return (HORIZON_BY_NETWORK[network] ?? HORIZON_BY_NETWORK.testnet).replace(/\/$/, '');
}

/** Native XLM balance in stroops (1 XLM = 10_000_000 stroops). */
export async function getNativeXlmBalance(horizonUrl: string, address: string): Promise<bigint> {
  const base = horizonUrl.replace(/\/$/, '');
  const res = await fetch(`${base}/accounts/${address}`);
  if (res.status === 404) return 0n;
  if (!res.ok) throw new Error(`Failed to load XLM balance (${res.status})`);
  const data = (await res.json()) as HorizonAccount;
  const native = data.balances.find((b) => b.asset_type === 'native');
  if (!native) return 0n;
  const [whole, frac = ''] = native.balance.split('.');
  const padded = frac.padEnd(7, '0').slice(0, 7);
  return BigInt(whole) * 10_000_000n + BigInt(padded || '0');
}

export function formatXlmBalance(raw: bigint): string {
  const whole = raw / 10_000_000n;
  const frac = (raw % 10_000_000n).toString().padStart(7, '0').replace(/0+$/, '');
  return frac ? `${whole}.${frac} XLM` : `${whole} XLM`;
}

/** Shorter balance label for the navbar pill. */
export function compactXlmLabel(full: string | null): string {
  if (!full) return '0 XLM';
  const match = full.match(/^([\d,]+(?:\.\d+)?)\s*XLM$/i);
  if (!match) return full;
  const num = Number.parseFloat(match[1].replace(/,/g, ''));
  if (Number.isNaN(num)) return full;
  if (num >= 1000) {
    return `${num.toLocaleString('en-US', { maximumFractionDigits: 2 })} XLM`;
  }
  if (num >= 1) {
    return `${num.toLocaleString('en-US', { maximumFractionDigits: 4 })} XLM`;
  }
  return full;
}

let cachedXlmUsd: { price: number; fetchedAt: number } | null = null;

export async function getXlmUsdPrice(): Promise<number | null> {
  const now = Date.now();
  if (cachedXlmUsd && now - cachedXlmUsd.fetchedAt < 60_000) {
    return cachedXlmUsd.price;
  }
  try {
    const res = await fetch(
      'https://api.coingecko.com/api/v3/simple/price?ids=stellar&vs_currencies=usd'
    );
    if (!res.ok) return cachedXlmUsd?.price ?? null;
    const data = (await res.json()) as { stellar?: { usd?: number } };
    const price = data.stellar?.usd;
    if (typeof price !== 'number') return cachedXlmUsd?.price ?? null;
    cachedXlmUsd = { price, fetchedAt: now };
    return price;
  } catch {
    return cachedXlmUsd?.price ?? null;
  }
}

export function xlmToUsd(raw: bigint, usdPerXlm: number): string {
  const xlm = Number(raw) / 10_000_000;
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(xlm * usdPerXlm);
}
