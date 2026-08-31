#!/usr/bin/env tsx
/**
 * provision-user.ts — Admin CLI for managing users in the `users` Postgres table.
 *
 * Usage:
 *   tsx api-server/scripts/provision-user.ts <command> [options]
 *
 * Commands:
 *   create  --user-id <id> --password <pw> [--role <role>]
 *             Create a new user with an argon2id-equivalent (scrypt) password hash.
 *
 *   update  --user-id <id> --password <pw>
 *             Reset an existing user's password.
 *
 *   delete  --user-id <id>
 *             Remove a user from the database.
 *
 *   list
 *             Print all user IDs and roles (password hashes are never printed).
 *
 *   migrate-env
 *             Read USER_CREDENTIALS JSON from the DATABASE_URL-configured DB
 *             (or the USER_CREDENTIALS env var) and upsert entries into the
 *             `users` table with scrypt-hashed passwords.
 *             NOTE: plaintext passwords are never stored — this command
 *             re-hashes from the SHA-256 hashes in USER_CREDENTIALS entries
 *             as "legacy" entries (see auth.ts verifyPassword for details).
 *
 * Environment variables:
 *   DATABASE_URL  — Postgres connection string (required).
 *
 * Example:
 *   DATABASE_URL=postgres://... tsx api-server/scripts/provision-user.ts \
 *     create --user-id alice --password 'S3cret!' --role admin
 *
 * Issue #1426 — replaces the USER_CREDENTIALS env-var workflow.
 */

import crypto from 'crypto';
import { promisify } from 'util';
import { Pool } from 'pg';

const scryptAsync = promisify(crypto.scrypt);

const SCRYPT_KEYLEN = 64;
const SCRYPT_N      = 16384;
const SCRYPT_R      = 8;
const SCRYPT_P      = 1;

async function hashPassword(password: string): Promise<string> {
  const salt = crypto.randomBytes(16);
  const hash = await scryptAsync(password, salt, SCRYPT_KEYLEN, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
  }) as Buffer;
  return `scrypt:${salt.toString('hex')}:${hash.toString('hex')}`;
}

function getPool(): Pool {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('Error: DATABASE_URL environment variable is required.');
    process.exit(1);
  }
  return new Pool({ connectionString: url });
}

function parseArgs(argv: string[]): Record<string, string> {
  const args: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) {
      const key = argv[i].slice(2);
      const value = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : 'true';
      args[key] = value;
    }
  }
  return args;
}

async function cmdCreate(pool: Pool, args: Record<string, string>): Promise<void> {
  const { 'user-id': userId, password, role = 'user' } = args;
  if (!userId || !password) {
    console.error('Error: --user-id and --password are required.');
    process.exit(1);
  }

  const passwordHash = await hashPassword(password);

  await pool.query(
    `INSERT INTO users (user_id, password_hash, role)
     VALUES ($1, $2, $3)
     ON CONFLICT (user_id) DO UPDATE
       SET password_hash = EXCLUDED.password_hash,
           role = EXCLUDED.role`,
    [userId, passwordHash, role],
  );

  console.log(`✓ User "${userId}" created/updated with role "${role}".`);
}

async function cmdUpdate(pool: Pool, args: Record<string, string>): Promise<void> {
  const { 'user-id': userId, password } = args;
  if (!userId || !password) {
    console.error('Error: --user-id and --password are required.');
    process.exit(1);
  }

  const passwordHash = await hashPassword(password);

  const result = await pool.query(
    'UPDATE users SET password_hash = $1 WHERE user_id = $2',
    [passwordHash, userId],
  );

  if (result.rowCount === 0) {
    console.error(`Error: User "${userId}" not found.`);
    process.exit(1);
  }
  console.log(`✓ Password updated for user "${userId}".`);
}

async function cmdDelete(pool: Pool, args: Record<string, string>): Promise<void> {
  const { 'user-id': userId } = args;
  if (!userId) {
    console.error('Error: --user-id is required.');
    process.exit(1);
  }

  const result = await pool.query('DELETE FROM users WHERE user_id = $1', [userId]);
  if (result.rowCount === 0) {
    console.error(`Error: User "${userId}" not found.`);
    process.exit(1);
  }
  console.log(`✓ User "${userId}" deleted.`);
}

async function cmdList(pool: Pool): Promise<void> {
  const result = await pool.query<{ user_id: string; role: string; created_at: string }>(
    'SELECT user_id, role, created_at FROM users ORDER BY created_at',
  );
  if (result.rowCount === 0) {
    console.log('No users found.');
    return;
  }
  console.log(`${'USER_ID'.padEnd(30)} ${'ROLE'.padEnd(15)} CREATED_AT`);
  console.log('-'.repeat(70));
  for (const row of result.rows) {
    console.log(`${row.user_id.padEnd(30)} ${row.role.padEnd(15)} ${row.created_at}`);
  }
}

async function cmdMigrateEnv(pool: Pool): Promise<void> {
  const raw = process.env.USER_CREDENTIALS;
  if (!raw) {
    console.error('Error: USER_CREDENTIALS env var is not set — nothing to migrate.');
    process.exit(1);
  }

  type LegacyCred = { userId: string; passwordHash: string; role: string };
  let creds: LegacyCred[];
  try {
    creds = JSON.parse(raw);
  } catch {
    console.error('Error: Failed to parse USER_CREDENTIALS JSON.');
    process.exit(1);
  }

  console.log(`Migrating ${creds.length} credential(s) from USER_CREDENTIALS...`);
  let ok = 0;
  for (const c of creds) {
    // We store the legacy SHA-256 hash prefixed with "legacy-sha256:" so that
    // verifyPassword() in auth.ts can handle it during a login before the user
    // resets their password via provision-user update.
    const storedHash = `legacy-sha256:${c.passwordHash}`;
    await pool.query(
      `INSERT INTO users (user_id, password_hash, role)
       VALUES ($1, $2, $3)
       ON CONFLICT (user_id) DO UPDATE
         SET password_hash = EXCLUDED.password_hash,
             role = EXCLUDED.role`,
      [c.userId, storedHash, c.role],
    );
    ok++;
    console.log(`  ✓ Migrated "${c.userId}" (role: ${c.role}) — password is legacy-sha256`);
  }

  console.log(`\nMigrated ${ok} user(s).`);
  console.log('IMPORTANT: Ask migrated users to reset their passwords using:');
  console.log('  provision-user update --user-id <id> --password <new-password>');
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  const args = parseArgs(rest);

  if (!command) {
    console.error('Usage: provision-user.ts <create|update|delete|list|migrate-env> [options]');
    process.exit(1);
  }

  const pool = getPool();

  try {
    switch (command) {
      case 'create':       await cmdCreate(pool, args);     break;
      case 'update':       await cmdUpdate(pool, args);     break;
      case 'delete':       await cmdDelete(pool, args);     break;
      case 'list':         await cmdList(pool);             break;
      case 'migrate-env':  await cmdMigrateEnv(pool);       break;
      default:
        console.error(`Unknown command: "${command}". Use create|update|delete|list|migrate-env.`);
        process.exit(1);
    }
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
