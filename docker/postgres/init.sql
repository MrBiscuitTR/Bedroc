-- docker/postgres/init.sql
-- Runs once on first container start (when data volume is empty).
-- Creates the bedroc database and user with least-privilege access.
--
-- The application user (bedroc_app) has:
--   - SELECT, INSERT, UPDATE, DELETE on all tables
--   - USAGE on sequences (for UUID generation via pgcrypto)
-- It does NOT have:
--   - CREATE TABLE (prevents schema changes from app layer)
--   - DROP TABLE / TRUNCATE (defence in depth)
--   - Superuser access

-- Create dedicated database
CREATE DATABASE bedroc;

-- Create application user
CREATE USER bedroc_app WITH PASSWORD 'REPLACE_IN_ENV';

-- Grant connection
GRANT CONNECT ON DATABASE bedroc TO bedroc_app;

-- Schema permissions (run after connecting to bedroc database)
\c bedroc

GRANT USAGE ON SCHEMA public TO bedroc_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO bedroc_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO bedroc_app;
GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO bedroc_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE ON SEQUENCES TO bedroc_app;
