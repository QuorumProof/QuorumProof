# Migrations

Liquibase-style versioned SQL migrations for the API server's Postgres
database, applied and tracked by `src/migrations/runner.ts`.

## Layout

Each migration is a pair of files sharing a numeric prefix:

```
NNNN_description.up.sql     — forward migration
NNNN_description.down.sql   — exact inverse, used by rollback
```

`NNNN` is a zero-padded, strictly increasing sequence number (`0001`, `0002`,
...). The runner applies `.up.sql` files in ascending numeric order and has
never seen `.down.sql` files applied automatically — those only run via
explicit rollback (`npm run migrate:rollback`).

## Adding a migration

1. Pick the next sequence number.
2. Write `NNNN_description.up.sql` — must be idempotent-safe to re-run inside
   a transaction (the runner wraps each migration in `BEGIN`/`COMMIT`).
3. Write `NNNN_description.down.sql` that exactly undoes it. If a migration
   is genuinely irreversible (e.g. it drops a column with data loss), the down
   file should still exist and either restore the prior shape as best-effort
   or `RAISE EXCEPTION` with a clear message — never omit the file, since the
   runner's rollback step expects one file per applied migration.
4. Never edit an already-applied migration file. Ship a new migration
   instead — the runner tracks applied migrations by filename in
   `schema_migrations`, so editing history after the fact desyncs the
   changelog from what other environments already ran.

See [`docs/database-migrations.md`](../../docs/database-migrations.md) for
how this integrates with API server startup and CI.
