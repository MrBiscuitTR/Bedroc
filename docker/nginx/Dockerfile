# =============================================================================
# docker/nginx/Dockerfile — TLS reverse proxy for docker-compose.yml
# =============================================================================
#
# nginx.conf is baked in (instead of bind-mounted) so host permissions/umask
# cannot break it. Only the TLS certificate directory is mounted at runtime.
#
# The nginx master process starts as root only to read the certificate and
# bind ports 80/443 inside the container, then workers run as `nginx`.
# Compose drops every capability except the few this needs.
# =============================================================================
FROM nginx:1.28-alpine

COPY nginx.conf /etc/nginx/nginx.conf
RUN rm -f /etc/nginx/conf.d/default.conf \
 && chmod 0644 /etc/nginx/nginx.conf
