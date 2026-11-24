# =============================================================================
# bedroc/Dockerfile — SvelteKit frontend (static adapter → nginx serves it)
# =============================================================================
#
# Multi-stage build:
#   Stage 1 (builder): `npm run build` produces a static site in /app/build
#   Stage 2 (runner):  unprivileged nginx (runs as uid 101, never root) serves it
#
# Used only by docker-compose.yml (the WireGuard/self-contained stack). The
# public stack uses the hosted frontend instead.
# =============================================================================

# ── Stage 1: Build ───────────────────────────────────────────────────────────
FROM node:22-alpine AS builder

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund

COPY . .
RUN npm run build

# ── Stage 2: Serve with unprivileged nginx ───────────────────────────────────
FROM nginxinc/nginx-unprivileged:1.28-alpine AS runner

USER root
RUN rm -f /etc/nginx/conf.d/default.conf
COPY --from=builder /app/build /usr/share/nginx/html
# nginx-static.conf lives in bedroc/ (same build context as this Dockerfile)
COPY nginx-static.conf /etc/nginx/conf.d/app.conf
# Explicit modes: a restrictive umask on the build host must not make the
# site unreadable to the nginx user (that shows up as 403s).
RUN chmod -R u=rwX,go=rX /usr/share/nginx/html /etc/nginx/conf.d
USER 101

EXPOSE 8080

HEALTHCHECK --interval=15s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8080/ >/dev/null || exit 1
