# =============================================================================
# server/Dockerfile — Fastify backend
# =============================================================================
#
# Multi-stage build:
#   Stage 1 (builder): compile TypeScript → JavaScript in /app/dist
#   Stage 2 (runner):  minimal Node.js image with only compiled output + prod deps
#
# Hardening:
#   - Reproducible installs from package-lock.json (npm ci), no install scripts
#   - Non-root user (uid 1001); app files are root-owned and read-only to it
#   - npm/npx/corepack removed from the runtime image (nothing to install with)
#   - Explicit file modes, so a restrictive umask on the build host (e.g. 077)
#     cannot produce files the runtime user is unable to read
#   - Compose additionally runs it with a read-only root filesystem,
#     no capabilities and no-new-privileges
# =============================================================================

# ── Stage 1: TypeScript compile ──────────────────────────────────────────────
FROM node:22-alpine AS builder

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# ── Stage 2: Runtime image ───────────────────────────────────────────────────
FROM node:22-alpine AS runner

ENV NODE_ENV=production
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund \
 && npm cache clean --force \
 && rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
           /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack \
           /opt/yarn* /usr/local/bin/yarn /usr/local/bin/yarnpkg /root/.npm

COPY --from=builder /app/dist ./dist
# Migration SQL files are read at runtime by the migrate service
COPY src/db/migrations ./dist/db/migrations

# Non-root runtime user. Application files stay root-owned (the app cannot
# modify its own code); only /app/logs is writable by the app user.
RUN addgroup -g 1001 -S bedroc \
 && adduser -u 1001 -S bedroc -G bedroc \
 && chmod -R u=rwX,go=rX /app \
 && mkdir -p /app/logs && chown bedroc:bedroc /app/logs && chmod 0750 /app/logs

USER bedroc

EXPOSE 3000

HEALTHCHECK --interval=15s --timeout=5s --start-period=30s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3000/health || exit 1

ENTRYPOINT ["node", "dist/index.js"]
