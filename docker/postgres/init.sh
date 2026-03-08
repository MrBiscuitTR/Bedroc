#!/bin/bash
# docker/postgres/init.sh
# Runs once on first container start (when data volume is empty).
# Creates bedroc_app with the password extracted from DATABASE_URL.
#
# This script runs AFTER the 'bedroc' database is created by POSTGRES_DB,
# so we don't create the database here — it already exists.

set -euo pipefail

# ---------------------------------------------------------------------------
# Extract bedroc_app password from DATABASE_URL
# Format: postgres://bedroc_app:PASSWORD@host:port/db
# ---------------------------------------------------------------------------

DB_APP_PASSWORD=""
if [ -n "${DATABASE_URL:-}" ]; then
  # Use Python for reliable URL parsing — no regex edge cases, no injection risk
  DB_APP_PASSWORD=$(python3 -c "
import sys, urllib.parse
url = urllib.parse.urlparse(sys.argv[1])
print(url.password or '', end='')
" "$DATABASE_URL" 2>/dev/null || true)
fi

if [ -z "$DB_APP_PASSWORD" ]; then
  echo "[init] WARNING: Could not extract password from DATABASE_URL. Using POSTGRES_PASSWORD as fallback."
  DB_APP_PASSWORD="${POSTGRES_PASSWORD}"
fi

# ---------------------------------------------------------------------------
# Create/update bedroc_app — password passed via PGPASSWORD env var,
# never interpolated into SQL.
# ---------------------------------------------------------------------------

# Write password to a temp file readable only by this process,
# then use psql's \password meta-command which reads from stdin safely.
# Alternatively, use ALTER USER with a parameterised approach.
#
# psql does not support bind parameters for DDL, but we can pass the
# password as a psql variable and quote it properly with quote_literal().

psql -v ON_ERROR_STOP=1 \
     --username "$POSTGRES_USER" \
     --dbname "$POSTGRES_DB" \
     --no-password \
     -v "app_password=$DB_APP_PASSWORD" \
     <<'EOSQL'
DO $$
DECLARE
  pwd text := current_setting('app_password');
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'bedroc_app') THEN
    EXECUTE format('CREATE USER bedroc_app WITH PASSWORD %L', pwd);
  ELSE
    EXECUTE format('ALTER USER bedroc_app WITH PASSWORD %L', pwd);
  END IF;
END
$$;

GRANT CONNECT ON DATABASE bedroc TO bedroc_app;
EOSQL

# Grant schema permissions in the bedroc database
psql -v ON_ERROR_STOP=1 \
     --username "$POSTGRES_USER" \
     --dbname "bedroc" \
     --no-password \
     <<'EOSQL'
GRANT USAGE ON SCHEMA public TO bedroc_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO bedroc_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO bedroc_app;
GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO bedroc_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE ON SEQUENCES TO bedroc_app;
EOSQL

echo "[init] bedroc_app user created/updated successfully."
