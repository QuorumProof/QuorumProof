# API Server Database Migrations

API server schema changes used to be applied by hand against each
environment, which is error-prone — a step gets skipped, environments drift
apart, nobody remembers which migration a given deployment is on. This
document covers the Liquibase-style migration framework in
`api-server/src/migrations/`.

## How it works

- Migrations live in `api-server/migrations/` as paired
  `NNNN_name.up.sql` / `NNNN_name.down.sql` files (see
  [`api-server/migrations/README.md`](../api-server/migrations/README.md) for
  the authoring convention).
- `api-server/src/migrations/runner.ts` tracks applied migrations in a
  `schema_migrations` table (filename, checksum, applied_at) and applies
  pending `.up.sql` files in ascending sequence order, each inside its own
  transaction.
- If a previously-applied migration file's contents no longer match the
  checksum recorded when it was applied, the runner throws instead of
  silently proceeding — this catches the "someone edited an already-shipped
  migration" mistake instead of letting environments silently diverge.

## Auto-migration on startup

`api-server/src/index.ts` runs `runMigrations()` before the HTTP server
starts listening, **only when `DATABASE_URL` is set**. If it isn't set, this
is a complete no-op — the API server's other stores (`DurableLog`, in-memory
caches) don't require Postgres. If a migration fails during startup, the
process logs the error and exits non-zero rather than serving traffic against
a partially-migrated schema.

## Running migrations manually

```bash
cd api-server
export DATABASE_URL=postgres://user:pass@host:5432/dbname
npm run migrate            # apply all pending migrations
npm run migrate:rollback   # roll back the most recently applied migration
npm run migrate:rollback -- 3   # roll back the 3 most recent
```

(`migrate:rollback` accepts a step count as an extra CLI argument; see
`api-server/src/migrations/cli.ts`.)

## Rollback semantics

Rollback runs the matching `.down.sql` for each migration being undone, most
recently applied first, in its own transaction, and removes its
`schema_migrations` row only after the down-migration succeeds. A migration
that is genuinely irreversible without data loss still ships a `.down.sql` —
see the authoring convention in `api-server/migrations/README.md` — so
rollback never silently no-ops on a migration that was actually applied.

## CI

`.github/workflows/db-migrations.yml` spins up a throwaway Postgres 16
container and, on every change under `api-server/migrations/` or
`api-server/src/migrations/`, runs the full cycle: apply → re-apply
(idempotency check) → roll back one step → re-apply → verify
`schema_migrations` reflects what's expected. This is what catches a
migration that doesn't actually roll back cleanly before it reaches a real
environment.

## Adding a new table/column

1. Add `NNNN_description.up.sql` and `NNNN_description.down.sql` to
   `api-server/migrations/` (see that directory's README for the exact
   convention and idempotency requirements).
2. Run `npm run migrate` locally against a scratch Postgres instance to
   confirm it applies, then `npm run migrate:rollback` to confirm the down
   migration is correct.
3. Open the PR — `db-migrations.yml` re-verifies both directions in CI.
