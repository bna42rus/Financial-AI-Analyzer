-- Per-workspace one-time starter addition. Runtime authorization/RLS is unchanged.
-- A user's later rename, hide, deletion or full financial reset must not resurrect it.
ALTER TABLE finance.workspace ADD marketplace_catalog_initialized boolean NOT NULL DEFAULT false;
