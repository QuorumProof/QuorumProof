# User Credentials Migration Guide

**Addresses:** Issue #1426 — Replace auth.ts Stub Credential Store With a Persistent User Store

---

## What Changed

Prior to this change, `src/routes/auth.ts` loaded user accounts from the `USER_CREDENTIALS`
environment variable (a JSON array of `{ userId, passwordHash, role }` objects) or fell back
to a hard-coded `admin/changeme` account outside of `NODE_ENV=production`.

Passwords were hashed with **SHA-256** — a fast general-purpose hash that is unsuitable for
password storage because it can be brute-forced quickly on commodity hardware.

As of this change:

| Aspect | Before (#1426) | After (#1426) |
|--------|----------------|---------------|
| Storage | `USER_CREDENTIALS` env var | `users` Postgres table |
| Password hash | SHA-256 (insecure) | scrypt (N=16384, r=8, p=1) — equivalent security to argon2id |
| Account management | Re-deploy with new env var | `provision-user.ts` CLI |
| Production safety | Hard-coded fallback skipped by `NODE_ENV` check | No hard-coded accounts |

---

## Migration Steps for Operators

### 1. Apply the database migration

```bash
npm --prefix api-server run migrate
```

This creates the `users` table (migration `0004_users.up.sql`).

### 2. Migrate existing USER_CREDENTIALS accounts

If you currently rely on the `USER_CREDENTIALS` environment variable, run:

```bash
USER_CREDENTIALS='[{"userId":"alice","passwordHash":"<sha256>","role":"admin"}]' \
DATABASE_URL=postgres://... \
  tsx api-server/scripts/provision-user.ts migrate-env
```

This inserts each account into the `users` table with its legacy SHA-256 hash prefixed as
`legacy-sha256:<hash>`. The server will accept logins for these accounts until the user
resets their password.

> **Important:** Ask every migrated user to reset their password immediately after migration.
> Legacy SHA-256 hashes are accepted only in `NODE_ENV !== production`.

### 3. Reset passwords (strongly recommended)

```bash
DATABASE_URL=postgres://... \
  tsx api-server/scripts/provision-user.ts update \
    --user-id alice \
    --password 'NewSecretPassword!'
```

### 4. Create new accounts

```bash
DATABASE_URL=postgres://... \
  tsx api-server/scripts/provision-user.ts create \
    --user-id bob \
    --password 'B0bSecret!' \
    --role user
```

### 5. Remove the deprecated env var

Once all accounts are in Postgres and passwords reset, remove `USER_CREDENTIALS` from your
deployment configuration. The env var is no longer needed or read in production.

---

## provision-user.ts Reference

```
tsx api-server/scripts/provision-user.ts <command> [options]

Commands:
  create  --user-id <id> --password <pw> [--role <role>]
  update  --user-id <id> --password <pw>
  delete  --user-id <id>
  list
  migrate-env
```

---

## Rollback

To roll back migration `0004_users` (drops the `users` table):

```bash
npm --prefix api-server run migrate:rollback
```

After rollback, re-add `USER_CREDENTIALS` to your environment if needed. The SHA-256
fallback path in auth.ts is only available in `NODE_ENV !== production`.

---

## Password Hashing Details

Passwords are stored as: `scrypt:<hex-salt>:<hex-hash>`

- Algorithm: Node.js `crypto.scrypt`
- Parameters: N=16384, r=8, p=1, keylen=64 bytes (equivalent to OWASP recommended argon2id settings)
- Salt: 16 random bytes per hash
- Comparison uses `crypto.timingSafeEqual` to prevent timing attacks

SHA-256 is accepted **only** in `NODE_ENV !== production` for the migration window.
It will be removed in a future release.
