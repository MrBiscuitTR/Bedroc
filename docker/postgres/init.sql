-- docker/postgres/init.sql
-- Runs once on first container start (when data volume is empty).
-- Creates the bedroc_app user with least-privilege access.
--
-- Note: the 'bedroc' database is already created by the POSTGRES_DB
-- environment variable before this script runs — do NOT create it here.
--
-- The application user (bedroc_app) has:
--   - SELECT, INSERT, UPDATE, DELETE on all tables
--   - USAGE on sequences
-- It does NOT have:
--   - CREATE TABLE (prevents schema changes from app layer)
--   - DROP TABLE / TRUNCATE (defence in depth)
--   - Superuser access
--
-- IMPORTANT: after running this, set the bedroc_app password to match
-- the password in DATABASE_URL by running:
--   docker compose exec postgres psql -U postgres -c \
--     "ALTER USER bedroc_app PASSWORD 'your-db-password';"
-- Or use the init.sh script instead of this file for automatic password setup.

-- Create application user (password will be set by init.sh if used)
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'bedroc_app') THEN
    CREATE USER bedroc_app WITH PASSWORD 'changeme';
  END IF;
END
$$;

-- Grant connection to the already-existing bedroc database
GRANT CONNECT ON DATABASE bedroc TO bedroc_app;

-- Schema permissions
\c bedroc

GRANT USAGE ON SCHEMA public TO bedroc_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO bedroc_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO bedroc_app;
GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO bedroc_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE ON SEQUENCES TO bedroc_app;
