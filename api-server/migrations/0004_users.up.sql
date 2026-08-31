-- Persistent user store (Issue #1426).
-- Replaces the in-memory USER_CREDENTIALS env-var stub in src/routes/auth.ts.
-- Passwords are stored as argon2id hashes; SHA-256 is never used.
-- Back-compat: operators who used USER_CREDENTIALS can migrate via the
-- provision-user.ts CLI script (see api-server/scripts/provision-user.ts).

CREATE TABLE IF NOT EXISTS users (
  id           BIGSERIAL PRIMARY KEY,
  user_id      TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,            -- argon2id hash produced by provision-user.ts
  role         TEXT NOT NULL DEFAULT 'user',
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_users_user_id ON users (user_id);

-- Automatically update `updated_at` on every row change.
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

CREATE TRIGGER users_updated_at
  BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
