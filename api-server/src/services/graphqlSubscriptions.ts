import { randomBytes } from 'crypto';
import { Redis } from 'ioredis';
import { getPool } from '../db.js';
import { instanceId } from '../ws/instanceId.js';
import { getPubSubBackend, type PubSubBackend } from '../ws/pubsub.js';
import { logger } from './logger.js';

export type GraphQLVariables = Record<string, unknown>;

export interface GraphQLSubscriptionRecord {
  id: string;
  query: string;
  variables: GraphQLVariables;
  created_at: string;
}

export interface GraphQLSubscriptionStore {
  create(query: string, variables: GraphQLVariables): Promise<GraphQLSubscriptionRecord>;
  get(id: string): Promise<GraphQLSubscriptionRecord | null>;
  delete(id: string): Promise<boolean>;
  list(): Promise<GraphQLSubscriptionRecord[]>;
}

export const GRAPHQL_SUBSCRIPTIONS_CHANNEL = 'graphql:subscriptions';
const REDIS_SUBSCRIPTIONS_KEY = 'graphql:subscriptions';

interface SubscriptionSyncEvent {
  type: 'created' | 'deleted';
  id: string;
  subscription?: GraphQLSubscriptionRecord;
  publishedBy: string;
}

function generateSubscriptionId(): string {
  return `gqlsub_${Date.now().toString(36)}_${randomBytes(4).toString('hex')}`;
}

function buildRecord(query: string, variables: GraphQLVariables): GraphQLSubscriptionRecord {
  return {
    id: generateSubscriptionId(),
    query,
    variables,
    created_at: new Date().toISOString(),
  };
}

/**
 * Pub/sub-synchronized subscription store for cross-replica coordination when
 * neither Postgres nor Redis storage is available.
 */
export class PubSubGraphQLSubscriptionStore implements GraphQLSubscriptionStore {
  private readonly subscriptions = new Map<string, GraphQLSubscriptionRecord>();
  private readonly replicaId: string;

  constructor(
    private readonly pubsub: PubSubBackend = getPubSubBackend(),
    replicaId: string = `${instanceId}-${randomBytes(3).toString('hex')}`,
  ) {
    this.replicaId = replicaId;
    this.pubsub.subscribe(GRAPHQL_SUBSCRIPTIONS_CHANNEL, (raw) => {
      let event: SubscriptionSyncEvent;
      try {
        event = JSON.parse(raw) as SubscriptionSyncEvent;
      } catch {
        return;
      }
      if (event.publishedBy === this.replicaId) return;
      if (event.type === 'created' && event.subscription) {
        this.subscriptions.set(event.id, event.subscription);
      } else if (event.type === 'deleted') {
        this.subscriptions.delete(event.id);
      }
    });
  }

  async create(query: string, variables: GraphQLVariables): Promise<GraphQLSubscriptionRecord> {
    const record = buildRecord(query, variables);
    this.subscriptions.set(record.id, record);
    this.pubsub.publish(
      GRAPHQL_SUBSCRIPTIONS_CHANNEL,
      JSON.stringify({
        type: 'created',
        id: record.id,
        subscription: record,
        publishedBy: this.replicaId,
      } satisfies SubscriptionSyncEvent),
    );
    return record;
  }

  async get(id: string): Promise<GraphQLSubscriptionRecord | null> {
    return this.subscriptions.get(id) ?? null;
  }

  async delete(id: string): Promise<boolean> {
    const deleted = this.subscriptions.delete(id);
    if (deleted) {
      this.pubsub.publish(
        GRAPHQL_SUBSCRIPTIONS_CHANNEL,
        JSON.stringify({
          type: 'deleted',
          id,
          publishedBy: this.replicaId,
        } satisfies SubscriptionSyncEvent),
      );
    }
    return deleted;
  }

  async list(): Promise<GraphQLSubscriptionRecord[]> {
    return Array.from(this.subscriptions.values());
  }
}

/**
 * Redis-backed durable shared store for GraphQL subscriptions.
 */
export class RedisGraphQLSubscriptionStore implements GraphQLSubscriptionStore {
  private readonly client: Redis;

  constructor(url: string, private readonly pubsub: PubSubBackend = getPubSubBackend()) {
    this.client = new Redis(url, { maxRetriesPerRequest: 2 });
    this.client.on('error', (err) => {
      logger.error('Redis GraphQL subscription store error', 'graphql', { error: err.message });
    });
  }

  async create(query: string, variables: GraphQLVariables): Promise<GraphQLSubscriptionRecord> {
    const record = buildRecord(query, variables);
    await this.client.hset(REDIS_SUBSCRIPTIONS_KEY, record.id, JSON.stringify(record));
    this.pubsub.publish(
      GRAPHQL_SUBSCRIPTIONS_CHANNEL,
      JSON.stringify({
        type: 'created',
        id: record.id,
        subscription: record,
        publishedBy: instanceId,
      } satisfies SubscriptionSyncEvent),
    );
    return record;
  }

  async get(id: string): Promise<GraphQLSubscriptionRecord | null> {
    const raw = await this.client.hget(REDIS_SUBSCRIPTIONS_KEY, id);
    if (!raw) return null;
    try {
      return JSON.parse(raw) as GraphQLSubscriptionRecord;
    } catch {
      return null;
    }
  }

  async delete(id: string): Promise<boolean> {
    const removed = await this.client.hdel(REDIS_SUBSCRIPTIONS_KEY, id);
    if (removed > 0) {
      this.pubsub.publish(
        GRAPHQL_SUBSCRIPTIONS_CHANNEL,
        JSON.stringify({
          type: 'deleted',
          id,
          publishedBy: instanceId,
        } satisfies SubscriptionSyncEvent),
      );
      return true;
    }
    return false;
  }

  async list(): Promise<GraphQLSubscriptionRecord[]> {
    const all = await this.client.hgetall(REDIS_SUBSCRIPTIONS_KEY);
    const records: GraphQLSubscriptionRecord[] = [];
    for (const raw of Object.values(all)) {
      try {
        records.push(JSON.parse(raw) as GraphQLSubscriptionRecord);
      } catch {
        // Ignore malformed entries
      }
    }
    return records;
  }

  async close(): Promise<void> {
    await this.client.quit();
  }
}

/**
 * PostgreSQL-backed durable shared store for GraphQL subscriptions.
 */
export class PostgresGraphQLSubscriptionStore implements GraphQLSubscriptionStore {
  private schemaReady: Promise<void> | null = null;

  constructor(private readonly pubsub: PubSubBackend = getPubSubBackend()) {}

  private ensureSchema(): Promise<void> {
    if (!this.schemaReady) {
      this.schemaReady = getPool()
        .query(
          `CREATE TABLE IF NOT EXISTS graphql_subscriptions (
            id TEXT PRIMARY KEY,
            query TEXT NOT NULL,
            variables JSONB NOT NULL DEFAULT '{}'::jsonb,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
          )`,
        )
        .then(() => undefined)
        .catch((err) => {
          this.schemaReady = null;
          throw err;
        });
    }
    return this.schemaReady;
  }

  async create(query: string, variables: GraphQLVariables): Promise<GraphQLSubscriptionRecord> {
    await this.ensureSchema();
    const record = buildRecord(query, variables);
    await getPool().query(
      `INSERT INTO graphql_subscriptions (id, query, variables, created_at)
       VALUES ($1, $2, $3::jsonb, $4::timestamptz)`,
      [record.id, record.query, JSON.stringify(record.variables), record.created_at],
    );
    this.pubsub.publish(
      GRAPHQL_SUBSCRIPTIONS_CHANNEL,
      JSON.stringify({
        type: 'created',
        id: record.id,
        subscription: record,
        publishedBy: instanceId,
      } satisfies SubscriptionSyncEvent),
    );
    return record;
  }

  async get(id: string): Promise<GraphQLSubscriptionRecord | null> {
    await this.ensureSchema();
    const result = await getPool().query(
      `SELECT id, query, variables, created_at FROM graphql_subscriptions WHERE id = $1`,
      [id],
    );
    const row = result.rows[0];
    if (!row) return null;
    return {
      id: String(row.id),
      query: String(row.query),
      variables: (row.variables && typeof row.variables === 'object' ? row.variables : {}) as GraphQLVariables,
      created_at: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
    };
  }

  async delete(id: string): Promise<boolean> {
    await this.ensureSchema();
    const result = await getPool().query(
      `DELETE FROM graphql_subscriptions WHERE id = $1 RETURNING id`,
      [id],
    );
    const deleted = (result.rowCount ?? result.rows.length) > 0;
    if (deleted) {
      this.pubsub.publish(
        GRAPHQL_SUBSCRIPTIONS_CHANNEL,
        JSON.stringify({
          type: 'deleted',
          id,
          publishedBy: instanceId,
        } satisfies SubscriptionSyncEvent),
      );
    }
    return deleted;
  }

  async list(): Promise<GraphQLSubscriptionRecord[]> {
    await this.ensureSchema();
    const result = await getPool().query(
      `SELECT id, query, variables, created_at FROM graphql_subscriptions ORDER BY created_at DESC`,
    );
    return result.rows.map((row) => ({
      id: String(row.id),
      query: String(row.query),
      variables: (row.variables && typeof row.variables === 'object' ? row.variables : {}) as GraphQLVariables,
      created_at: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
    }));
  }
}

let cachedRedisStore: { url: string; store: RedisGraphQLSubscriptionStore } | null = null;
let cachedPostgresStore: PostgresGraphQLSubscriptionStore | null = null;
let cachedPubSubStore: PubSubGraphQLSubscriptionStore | null = null;

function isPoolInitialized(): boolean {
  try {
    getPool();
    return true;
  } catch {
    return false;
  }
}

function resolveDefaultStore(): GraphQLSubscriptionStore {
  const redisUrl = process.env.REDIS_URL;
  if (redisUrl) {
    if (!cachedRedisStore || cachedRedisStore.url !== redisUrl) {
      cachedRedisStore = { url: redisUrl, store: new RedisGraphQLSubscriptionStore(redisUrl) };
    }
    return cachedRedisStore.store;
  }

  if (isPoolInitialized()) {
    if (!cachedPostgresStore) {
      cachedPostgresStore = new PostgresGraphQLSubscriptionStore();
    }
    return cachedPostgresStore;
  }

  if (!cachedPubSubStore) {
    cachedPubSubStore = new PubSubGraphQLSubscriptionStore();
  }
  return cachedPubSubStore;
}

/**
 * Lazy-resolving shared store used by the GraphQL router by default.
 * Resolves dynamically at request time so startup initialization of Redis/Postgres
 * takes effect even when the router is imported at module load time.
 */
export function createDefaultGraphqlSubscriptionStore(): GraphQLSubscriptionStore {
  return {
    create: (query, variables) => resolveDefaultStore().create(query, variables),
    get: (id) => resolveDefaultStore().get(id),
    delete: (id) => resolveDefaultStore().delete(id),
    list: () => resolveDefaultStore().list(),
  };
}
