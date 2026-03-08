# =============================================================================
# bedroc/Dockerfile — SvelteKit frontend (static adapter → nginx serves it)
# =============================================================================
#
# Multi-stage build:
#   Stage 1 (builder): `npm run build` produces a static site in /app/build
#   Stage 2 (runner):  nginx:alpine serves the static files
#
# The SvelteKit app must use @sveltejs/adapter-static for this to work.
# A prerendered SPA (with fallback: 'index.html') handles client-side routing.
#
# Note: if you switch to adapter-node for SSR, replace Stage 2 with a Node
# image similar to server/Dockerfile.
# =============================================================================

# ── Stage 1: Build ───────────────────────────────────────────────────────────
FROM node:22-alpine AS builder

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY . .
RUN npm run build

# ── Stage 2: Serve with nginx ─────────────────────────────────────────────────
FROM nginx:1.27-alpine AS runner

# Remove default nginx site
RUN rm /etc/nginx/conf.d/default.conf

# Copy static build output from builder
COPY --from=builder /app/build /usr/share/nginx/html

# Simple nginx config: serve static files, SPA fallback to index.html
# nginx-static.conf lives in bedroc/ (same build context as this Dockerfile)
COPY nginx-static.conf /etc/nginx/conf.d/app.conf

EXPOSE 8080

HEALTHCHECK --interval=15s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://localhost:8080/ || exit 1
