/**
 * API Key Management Service — Issue #999
 * Provides self-service API key generation, rotation, and management.
 * Tracks creation date and last used timestamp for each key.
 */

import crypto from 'crypto';
import path from 'path';
import { DurableLog } from './durableLog.js';

export interface ApiKey {
  id: string;
  keyHash: string; // SHA256 hash of the actual key for security
  issuer: string;
  createdAt: string;
  lastUsedAt?: string;
  name: string;
  active: boolean;
  /** Set when this key has been rotated: the id of the key that replaces it. */
  rotatedTo?: string;
  /**
   * Set when this key has been rotated: the key keeps verifying until this
   * timestamp, after which it is rejected even though `active` stays true.
   * This is what gives callers a grace window to switch to the new key
   * instead of every in-flight client breaking the instant rotation happens.
   */
  graceExpiresAt?: string;
}

export interface ApiKeySecret {
  id: string;
  key: string; // The actual key (only returned on creation)
  issuer: string;
  name: string;
  createdAt: string;
}

export interface ApiKeyUsageRecord {
  keyId: string;
  issuer: string;
  usedAt: string;
  endpoint: string;
}

const KEY_ID_PATTERN = /^key_([a-zA-Z0-9]{32})$/;

/** Default rotation grace window: 24 hours for the old key to keep working. */
const DEFAULT_GRACE_PERIOD_MS = 24 * 60 * 60 * 1000;

export interface ApiKeyManagerOptions {
  dataDir?: string;
}

export class ApiKeyManager {
  readonly dataDir: string;
  private readonly keys: DurableLog<ApiKey>;
  private readonly usage: DurableLog<ApiKeyUsageRecord>;
  private readonly keyCounter = new Map<string, number>(); // issuer -> count

  constructor(options: ApiKeyManagerOptions = {}) {
    const dataDir = options.dataDir ?? process.env.API_KEY_STORE_DATA_DIR ?? path.join(process.cwd(), '.data', 'api-keys');
    this.dataDir = dataDir;
    this.keys = new DurableLog<ApiKey>(path.join(dataDir, 'keys.jsonl'));
    this.usage = new DurableLog<ApiKeyUsageRecord>(path.join(dataDir, 'usage.jsonl'));

    // Initialize counter from existing keys
    for (const key of this.keys.values()) {
      const count = this.keyCounter.get(key.issuer) ?? 0;
      this.keyCounter.set(key.issuer, count + 1);
    }
  }

  /**
   * Generate a new API key for an issuer.
   * Returns both the key (only visible once) and the stored key info.
   */
  generateKey(issuer: string, name: string): ApiKeySecret {
    // Generate a cryptographically random key
    const keyBytes = crypto.randomBytes(32);
    const key = `qp_${keyBytes.toString('hex')}`;

    // Store only the hash for security
    const keyHash = crypto.createHash('sha256').update(key).digest('hex');

    const id = `key_${crypto.randomBytes(16).toString('hex')}`;
    const now = new Date().toISOString();

    const apiKey: ApiKey = {
      id,
      keyHash,
      issuer,
      createdAt: now,
      name,
      active: true,
    };

    this.keys.set(id, apiKey);

    // Increment counter
    const count = this.keyCounter.get(issuer) ?? 0;
    this.keyCounter.set(issuer, count + 1);

    return {
      id,
      key,
      issuer,
      name,
      createdAt: now,
    };
  }

  /**
   * Get all active keys for an issuer.
   */
  listKeys(issuer: string): ApiKey[] {
    return this.keys
      .values()
      .filter(k => k.issuer === issuer && k.active);
  }

  /**
   * Get a specific key by ID.
   */
  getKey(id: string): ApiKey | undefined {
    return this.keys.get(id);
  }

  /**
   * Revoke a key by ID immediately (no grace period).
   */
  revokeKey(id: string): boolean {
    const key = this.keys.get(id);
    if (!key) return false;

    key.active = false;
    this.keys.set(id, key);
    return true;
  }

  /**
   * Rotate a key: generates a brand-new key/hash for the same issuer+name,
   * and lets the old key keep verifying for `gracePeriodMs` longer so
   * in-flight clients have time to switch over, instead of breaking the
   * instant rotation happens. Returns the new key's one-time secret, or
   * undefined if `id` doesn't exist or is already inactive.
   */
  rotateKey(id: string, gracePeriodMs: number = DEFAULT_GRACE_PERIOD_MS): ApiKeySecret | undefined {
    const oldKey = this.keys.get(id);
    if (!oldKey || !oldKey.active) return undefined;

    const newSecret = this.generateKey(oldKey.issuer, oldKey.name);

    oldKey.rotatedTo = newSecret.id;
    oldKey.graceExpiresAt = new Date(Date.now() + gracePeriodMs).toISOString();
    this.keys.set(oldKey.id, oldKey);

    return newSecret;
  }

  /**
   * Verify an API key and return the key info if valid.
   * Updates the lastUsedAt timestamp. A rotated key still verifies until
   * its grace period elapses, after which it is rejected even though
   * `active` remains true.
   */
  verifyKey(rawKey: string): ApiKey | undefined {
    const keyHash = crypto.createHash('sha256').update(rawKey).digest('hex');

    for (const key of this.keys.values()) {
      if (!key.active || key.keyHash !== keyHash) continue;

      if (key.graceExpiresAt && Date.now() > new Date(key.graceExpiresAt).getTime()) {
        continue; // grace period elapsed; this key no longer verifies
      }

      // Update last used timestamp
      key.lastUsedAt = new Date().toISOString();
      this.keys.set(key.id, key);

      // Log usage with unique key
      const uniqueId = `${key.id}_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
      this.usage.set(
        uniqueId,
        {
          keyId: key.id,
          issuer: key.issuer,
          usedAt: key.lastUsedAt,
          endpoint: 'unspecified',
        }
      );

      return key;
    }

    return undefined;
  }

  /**
   * Record a key usage with optional endpoint information.
   */
  recordUsage(keyId: string, endpoint: string): void {
    const key = this.keys.get(keyId);
    if (!key) return;

    // Use a unique key with millisecond + random suffix to avoid collisions
    const uniqueId = `${keyId}_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
    this.usage.set(
      uniqueId,
      {
        keyId,
        issuer: key.issuer,
        usedAt: new Date().toISOString(),
        endpoint,
      }
    );
  }

  /**
   * Get usage history for a key.
   */
  getUsageHistory(keyId: string, limit: number = 100): ApiKeyUsageRecord[] {
    return this.usage
      .values()
      .filter(u => u.keyId === keyId)
      .sort((a, b) => new Date(b.usedAt).getTime() - new Date(a.usedAt).getTime())
      .slice(0, limit);
  }

  /**
   * Get issuer's key statistics.
   */
  getKeyStats(issuer: string): {
    totalKeys: number;
    activeKeys: number;
    revokedKeys: number;
  } {
    const issuerKeys = Array.from(this.keys.values()).filter(k => k.issuer === issuer);
    return {
      totalKeys: issuerKeys.length,
      activeKeys: issuerKeys.filter(k => k.active).length,
      revokedKeys: issuerKeys.filter(k => !k.active).length,
    };
  }

  /**
   * Reset state — for testing only.
   */
  _resetForTest(): void {
    for (const key of this.keys.keys()) this.keys.delete(key);
    for (const key of this.usage.keys()) this.usage.delete(key);
    this.keyCounter.clear();
  }
}

let defaultManager: ApiKeyManager | undefined;

export function getDefaultApiKeyManager(): ApiKeyManager {
  if (!defaultManager) defaultManager = new ApiKeyManager();
  return defaultManager;
}

/**
 * Test-only: force the module to construct a fresh default manager.
 */
export function _setDefaultApiKeyManagerForTest(manager: ApiKeyManager | undefined): void {
  defaultManager = manager;
}
