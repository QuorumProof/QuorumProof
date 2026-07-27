-- Rolling back the bootstrap migration would drop the table the runner uses
-- to track every other migration, including itself. There is nothing
-- meaningful to undo here.
DO $$ BEGIN
  RAISE NOTICE 'schema_migrations bootstrap has no down migration; it is foundational.';
END $$;
