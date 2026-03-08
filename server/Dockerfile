# =============================================================================
# server/Dockerfile — Fastify backend
# =============================================================================
#
# Multi-stage build:
#   Stage 1 (builder): compile TypeScript → JavaScript in /app/dist
#   Stage 2 (runner):  minimal Node.js image with only compiled output
#
# Security hardening:
#   - Non-root user (uid 1001) in runner stage
#   - No build tools in final image (tsc, tsx, etc. are dev-only)
#   - No shell in runner (ENTRYPOINT uses exec form — no /bin/sh needed)
#   - node:22-alpine for minimal attack surface
# =============================================================================

# ── Stage 1: TypeScript compile ──────────────────────────────────────────────
FROM node:22-alpine AS builder

WORKDIR /app

# Copy dependency manifests first for better layer caching.
# Rebuilds node_modules only when package.json changes.
# package-lock.json is optional — copy it if present, fall back to npm install.
COPY package.json ./
COPY package-lock.jso[n] ./

# Install ALL deps (including devDeps like typescript, tsx) for the build
RUN npm install --prefer-offline 2>/dev/null || npm install

# Copy source
COPY tsconfig.json ./
COPY src ./src

# Compile TypeScript → dist/
RUN npm run build

# ── Stage 2: Runtime image ───────────────────────────────────────────────────
FROM node:22-alpine AS runner

WORKDIR /app

# Only production deps in the final image
COPY package.json ./
COPY package-lock.jso[n] ./
RUN npm install --omit=dev --prefer-offline 2>/dev/null || npm install --omit=dev

# Copy compiled output from builder stage
COPY --from=builder /app/dist ./dist

# Copy migration SQL files (needed at runtime by runMigrations())
COPY src/db/migrations ./dist/db/migrations

# Create a non-root user to run the server
# UID/GID 1001 — standard convention for app users
RUN addgroup -g 1001 -S bedroc && \
    adduser -u 1001 -S bedroc -G bedroc

USER bedroc

# Expose the internal port (nginx proxies to this; not exposed publicly)
EXPOSE 3000

# Health check — used by Docker Compose to gate dependent service startup
HEALTHCHECK --interval=15s --timeout=5s --start-period=30s --retries=3 \
  CMD wget -qO- http://localhost:3000/health || exit 1

# Use exec form (no /bin/sh) — signals go directly to the Node process
ENTRYPOINT ["node", "dist/index.js"]
