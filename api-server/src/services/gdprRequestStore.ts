import path from 'path';
import { DurableLog } from './durableLog.js';

export type GdprRequestStatus = 'pending_consent' | 'anonymized' | 'rejected';

export interface AttestorConsent {
  attestor: string;
  consentedAt: string;
}

export interface GdprRequest {
  requestId: string;
  credentialId: number;
  subject: string;
  requestedAt: string;
  status: GdprRequestStatus;
  attestorConsents: AttestorConsent[];
  requiredConsents: number;
  /** Attestor addresses recorded at request time, for audit — live membership is re-checked on each consent. */
  eligibleAttestors: string[];
  commitment?: string;
  erasedAt?: string;
}

export interface GdprRequestStoreOptions {
  dataDir?: string;
}

const REQUEST_ID_PATTERN = /^gdpr_(\d+)$/;

/** Durable store for GDPR requests — state survives process restarts via an append-only WAL. */
export class GdprRequestStore {
  private readonly log: DurableLog<GdprRequest>;
  private counter: number;

  constructor(options: GdprRequestStoreOptions = {}) {
    const dataDir = options.dataDir ?? process.env.GDPR_REQUEST_STORE_DATA_DIR ?? path.join(process.cwd(), '.data', 'gdpr-requests');
    this.log = new DurableLog<GdprRequest>(path.join(dataDir, 'requests.jsonl'));
    this.counter = this.recoverCounter();
  }

  private recoverCounter(): number {
    let max = 0;
    for (const key of this.log.keys()) {
      const match = REQUEST_ID_PATTERN.exec(key);
      if (match) max = Math.max(max, parseInt(match[1], 10));
    }
    return max;
  }

  nextRequestId(): string {
    this.counter += 1;
    return `gdpr_${this.counter}`;
  }

  set(request: GdprRequest): void {
    this.log.set(request.requestId, request);
  }

  get(requestId: string): GdprRequest | undefined {
    return this.log.get(requestId);
  }

  has(requestId: string): boolean {
    return this.log.has(requestId);
  }

  all(): GdprRequest[] {
    return this.log.values();
  }
}

let defaultStore: GdprRequestStore | undefined;

/** Lazily-constructed process-wide store, used by the default GDPR router export. */
export function getDefaultRequestStore(): GdprRequestStore {
  if (!defaultStore) defaultStore = new GdprRequestStore();
  return defaultStore;
}
