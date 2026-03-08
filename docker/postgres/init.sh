#!/bin/bash
# docker/postgres/init.sh
# Runs once on first container start (when data volume is empty).
# Creates bedroc_app with the password extracted from DATABASE_URL.
#
# This script runs AFTER the 'bedroc' database is created by POSTGRES_DB,
# so we don't create the database here — it already exists.

set -e

# Extract the bedroc_app password from DATABASE_URL
# Format: postgres://bedroc_app:PASSWORD@host:port/db
DB_APP_PASSWORD=""
if [ -n "$DATABASE_URL" ]; then
  # Extract password between the first ':' after '//' and the '@'
  DB_APP_PASSWORD=$(echo "$DATABASE_URL" | sed -n 's|.*://[^:]*:\([^@]*\)@.*|\1|p')
fi

# Fall back to POSTGRES_PASSWORD if DATABASE_URL not set or password not found
if [ -z "$DB_APP_PASSWORD" ]; then
  DB_APP_PASSWORD="${POSTGRES_PASSWORD:-changeme}"
fi

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<-EOSQL
  DO \$\$
  BEGIN
    IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'bedroc_app') THEN
      CREATE USER bedroc_app WITH PASSWORD '$DB_APP_PASSWORD';
    ELSE
      ALTER USER bedroc_app WITH PASSWORD '$DB_APP_PASSWORD';
    END IF;
  END
  \$\$;

  GRANT CONNECT ON DATABASE bedroc TO bedroc_app;
EOSQL

# Run the rest in the bedroc database context
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "bedroc" <<-EOSQL
  GRANT USAGE ON SCHEMA public TO bedroc_app;
  GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO bedroc_app;
  ALTER DEFAULT PRIVILEGES IN SCHEMA public
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO bedroc_app;
  GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO bedroc_app;
  ALTER DEFAULT PRIVILEGES IN SCHEMA public
    GRANT USAGE ON SEQUENCES TO bedroc_app;
EOSQL

echo "[init] bedroc_app user created/updated successfully."
