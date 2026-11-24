# =============================================================================
# docker/postgres/Dockerfile — PostgreSQL 16 with Bedroc's first-boot init script
# =============================================================================
#
# init.sh is baked into the image instead of bind-mounted so that host file
# permissions (restrictive umask, other owners) and Windows CRLF line endings
# can never stop the database from initialising.
#
# init.sh only runs when the data volume is EMPTY (first boot). It never
# touches an existing database.
#
# Keep the major version (16) unchanged: PostgreSQL data directories are not
# compatible across major versions without a dump/restore.
# =============================================================================
FROM postgres:16-alpine

COPY init.sh /docker-entrypoint-initdb.d/10-bedroc-init.sh
RUN sed -i 's/\r$//' /docker-entrypoint-initdb.d/10-bedroc-init.sh \
 && chmod 0755 /docker-entrypoint-initdb.d/10-bedroc-init.sh
