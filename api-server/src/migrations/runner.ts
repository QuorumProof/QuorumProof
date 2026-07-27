/**
 * Minimal Liquibase-style migration runner for the API server's Postgres
 * database. API server DB schema changes were applied by hand, which is
 * error-prone (someone forgets a step, environments drift apart). This
 * tracks applied migrations in a `schema_migrations` table and applies
 * pending ones in order, each inside its own transaction.
 *
 * Design intentionally mirrors Liquibase's changelog model without pulling
 * in the JVM toolchain: a directory of paired `NNNN_name.up.sql` /
 * `NNNN_name.down.sql` files, a tracked "already applied" ledger keyed by
 * filename, and a checksum per applied file so a migration that was edited
 * after being applied elsewhere is caught instead of silently desyncing
 * environments.
 */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import type { Pool, PoolClient } from 'pg';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_MIGRATIONS_DIR = path.resolve(__dirname, '../../migrations');

export interface Migration {
  /** Sequence number parsed from the filename, e.g. 2 for "0002_api_keys.up.sql". */
  sequence: number;
  name: string;
  upPath: string;
  downPath: string;
  checksum: string;
}

export interface MigrationRunnerOptions {
  migrationsDir?: string;
}

function loadMigrations(migrationsDir: string): Migration[] {
  if (!fs.existsSync(migrationsDir)) return [];

  const files = fs.readdirSync(migrationsDir).filter((f) => f.endsWith('.up.sql'));
  const migrations: Migration[] = [];

  for (const upFile of files) {
    const match = upFile.match(/^(\d+)_(.+)\.up\.sql$/);
    if (!match) continue;
    const [, seqStr, name] = match;
    const downFile = `${seqStr}_${name}.down.sql`;
    const upPath = path.join(migrationsDir, upFile);
    const downPath = path.join(migrationsDir, downFile);
    if (!fs.existsSync(downPath)) {
      throw new Error(`Migration ${upFile} has no matching down migration (${downFile})`);
    }
    const checksum = crypto.createHash('sha256').update(fs.readFileSync(upPath, 'utf8')).digest('hex');
    migrations.push({ sequence: parseInt(seqStr, 10), name, upPath, downPath, checksum });
  }

  return migrations.sort((a, b) => a.sequence - b.sequence);
}

async function ensureChangelogTable(client: PoolClient): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename    TEXT PRIMARY KEY,
      checksum    TEXT NOT NULL,
      applied_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
}

async function getAppliedFilenames(client: PoolClient): Promise<Map<string, string>> {
  const result = await client.query<{ filename: string; checksum: string }>(
    'SELECT filename, checksum FROM schema_migrations'
  );
  return new Map(result.rows.map((r) => [r.filename, r.checksum]));
}

/**
 * Apply every pending migration in `migrationsDir`, in ascending sequence
 * order, each inside its own transaction. Throws (and stops) on the first
 * failure, leaving already-applied migrations committed — callers should
 * treat a thrown error here as fatal for API startup (see index.ts).
 *
 * Throws if a previously-applied migration file's contents no longer match
 * its recorded checksum, since that means two environments could now be
 * running different schemas under the same "applied" filename.
 */
export async function runMigrations(pool: Pool, options: MigrationRunnerOptions = {}): Promise<string[]> {
  const migrationsDir = options.migrationsDir ?? DEFAULT_MIGRATIONS_DIR;
  const migrations = loadMigrations(migrationsDir);
  const applied: string[] = [];

  const setupClient = await pool.connect();
  let alreadyApplied: Map<string, string>;
  try {
    await ensureChangelogTable(setupClient);
    alreadyApplied = await getAppliedFilenames(setupClient);
  } finally {
    setupClient.release();
  }

  for (const migration of migrations) {
    const filename = path.basename(migration.upPath);
    const priorChecksum = alreadyApplied.get(filename);

    if (priorChecksum !== undefined) {
      if (priorChecksum !== migration.checksum) {
        throw new Error(
          `Migration ${filename} was modified after being applied ` +
          `(recorded checksum ${priorChecksum}, current ${migration.checksum}). ` +
          `Never edit an applied migration — ship a new one instead.`
        );
      }
      continue;
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const sql = fs.readFileSync(migration.upPath, 'utf8');
      await client.query(sql);
      await client.query(
        'INSERT INTO schema_migrations (filename, checksum) VALUES ($1, $2)',
        [filename, migration.checksum]
      );
      await client.query('COMMIT');
      applied.push(filename);
    } catch (err) {
      await client.query('ROLLBACK');
      throw new Error(`Migration ${filename} failed: ${(err as Error).message}`);
    } finally {
      client.release();
    }
  }

  return applied;
}

/**
 * Roll back the `steps` most recently applied migrations (default 1), most
 * recent first, running each one's `.down.sql`. Each rollback runs inside
 * its own transaction and removes the corresponding `schema_migrations` row
 * only on success.
 */
export async function rollbackMigrations(
  pool: Pool,
  steps = 1,
  options: MigrationRunnerOptions = {}
): Promise<string[]> {
  const migrationsDir = options.migrationsDir ?? DEFAULT_MIGRATIONS_DIR;
  const migrations = loadMigrations(migrationsDir);
  const byFilename = new Map(migrations.map((m) => [path.basename(m.upPath), m]));

  const setupClient = await pool.connect();
  let appliedRows: { filename: string }[];
  try {
    await ensureChangelogTable(setupClient);
    const result = await setupClient.query<{ filename: string }>(
      'SELECT filename FROM schema_migrations ORDER BY applied_at DESC LIMIT $1',
      [steps]
    );
    appliedRows = result.rows;
  } finally {
    setupClient.release();
  }

  const rolledBack: string[] = [];

  for (const { filename } of appliedRows) {
    const migration = byFilename.get(filename);
    if (!migration) {
      throw new Error(`Cannot roll back ${filename}: migration file no longer exists on disk`);
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const sql = fs.readFileSync(migration.downPath, 'utf8');
      await client.query(sql);
      await client.query('DELETE FROM schema_migrations WHERE filename = $1', [filename]);
      await client.query('COMMIT');
      rolledBack.push(filename);
    } catch (err) {
      await client.query('ROLLBACK');
      throw new Error(`Rollback of ${filename} failed: ${(err as Error).message}`);
    } finally {
      client.release();
    }
  }

  return rolledBack;
}
