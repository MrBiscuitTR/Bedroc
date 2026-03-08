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
  # Pure sed — works on postgres:16-alpine which has no python3.
  # Matches: postgres[ql]://user:PASSWORD@host.../db
  DB_APP_PASSWORD=$(printf '%s' "$DATABASE_URL" | sed -E 's|^[^:]+://[^:]*:([^@]*)@.*$|\1|')
fi

if [ -z "$DB_APP_PASSWORD" ]; then
  echo "[init] WARNING: Could not extract password from DATABASE_URL. Using POSTGRES_PASSWORD as fallback."
  DB_APP_PASSWORD="${POSTGRES_PASSWORD}"
else
  echo "[init] Extracted bedroc_app password from DATABASE_URL."
fi

# ---------------------------------------------------------------------------
# Create/update bedroc_app.
#
# Avoid passing the password via psql variables inside dollar-quoted blocks —
# psql does not substitute :varname inside $$ ... $$ strings.
# Instead: escape the password for SQL at the shell level (double single-quotes),
# then use plain -c statements so psql sends them as-is.
# ---------------------------------------------------------------------------

# Escape single-quotes for SQL string literals (foo'bar → foo''bar)
SQL_SAFE_PASSWORD=$(printf '%s' "$DB_APP_PASSWORD" | sed "s/'/''/g")

ROLE_EXISTS=$(psql -v ON_ERROR_STOP=1 \
     --username "$POSTGRES_USER" \
     --dbname "$POSTGRES_DB" \
     --no-password \
     -tAc "SELECT 1 FROM pg_roles WHERE rolname='bedroc_app'")

if [ "$ROLE_EXISTS" = "1" ]; then
  psql -v ON_ERROR_STOP=1 \
       --username "$POSTGRES_USER" \
       --dbname "$POSTGRES_DB" \
       --no-password \
       -c "ALTER USER bedroc_app WITH PASSWORD '${SQL_SAFE_PASSWORD}'"
else
  psql -v ON_ERROR_STOP=1 \
       --username "$POSTGRES_USER" \
       --dbname "$POSTGRES_DB" \
       --no-password \
       -c "CREATE USER bedroc_app WITH LOGIN PASSWORD '${SQL_SAFE_PASSWORD}'"
fi

psql -v ON_ERROR_STOP=1 \
     --username "$POSTGRES_USER" \
     --dbname "$POSTGRES_DB" \
     --no-password \
     -c "GRANT CONNECT ON DATABASE bedroc TO bedroc_app"

# Create pgcrypto extension as superuser — bedroc_app lacks the CREATE privilege
# needed to create extensions, so this must run here rather than in migrations.
psql -v ON_ERROR_STOP=1 \
     --username "$POSTGRES_USER" \
     --dbname "bedroc" \
     --no-password \
     -c "CREATE EXTENSION IF NOT EXISTS pgcrypto"

# Grant schema permissions in the bedroc database
# Using individual -c calls to avoid any heredoc parsing issues.
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "bedroc" --no-password \
     -c "GRANT USAGE, CREATE ON SCHEMA public TO bedroc_app"
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "bedroc" --no-password \
     -c "GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO bedroc_app"
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "bedroc" --no-password \
     -c "ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO bedroc_app"
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "bedroc" --no-password \
     -c "GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO bedroc_app"
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "bedroc" --no-password \
     -c "ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE ON SEQUENCES TO bedroc_app"

echo "[init] bedroc_app user created/updated successfully."
