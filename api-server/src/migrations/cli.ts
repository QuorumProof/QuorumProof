#!/usr/bin/env node
/**
 * CLI entry point for the migration runner — `npm run migrate` /
 * `npm run migrate:rollback`. See docs/database-migrations.md.
 */

import { Pool } from 'pg';
import { runMigrations, rollbackMigrations } from './runner.js';

async function main(): Promise<void> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    console.error('DATABASE_URL environment variable is required to run migrations.');
    process.exit(1);
  }

  const command = process.argv[2] ?? 'up';
  const pool = new Pool({ connectionString });

  try {
    if (command === 'up') {
      const applied = await runMigrations(pool);
      if (applied.length === 0) {
        console.log('No pending migrations.');
      } else {
        console.log(`Applied ${applied.length} migration(s):`);
        applied.forEach((f) => console.log(`  - ${f}`));
      }
    } else if (command === 'down') {
      const steps = parseInt(process.argv[3] ?? '1', 10);
      const rolledBack = await rollbackMigrations(pool, steps);
      if (rolledBack.length === 0) {
        console.log('Nothing to roll back.');
      } else {
        console.log(`Rolled back ${rolledBack.length} migration(s):`);
        rolledBack.forEach((f) => console.log(`  - ${f}`));
      }
    } else {
      console.error(`Unknown migration command: ${command} (expected "up" or "down")`);
      process.exit(1);
    }
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
