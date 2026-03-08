/**
 * server/src/index.ts — Fastify application entry point.
 *
 * Boot sequence:
 *   1. Build Fastify instance with strict logging.
 *   2. Register security plugins (helmet, cors, rate-limit).
 *   3. Register JWT plugin (access token verification).
 *   4. Register cookie plugin (refresh token httpOnly cookie).
 *   5. Register WebSocket plugin.
 *   6. Run DB migrations (idempotent; safe to run every boot).
 *   7. Verify Redis connectivity.
 *   8. Register route plugins.
 *   9. Listen on the WireGuard interface only (default: 10.66.66.1).
 *
 * Environment variables (see .env.example):
 *   HOST                 — bind address (default: 10.66.66.1)
 *   PORT                 — listen port (default: 3000)
 *   NODE_ENV             — 'production' | 'development'
 *   DATABASE_URL         — postgres connection string
 *   REDIS_URL            — redis connection string
 *   JWT_ACCESS_SECRET    — secret for signing access JWTs (min 32 chars)
 *   JWT_REFRESH_SECRET   — secret for signing refresh JWTs (min 32 chars)
 *   JWT_ACCESS_EXPIRY    — e.g. '15m'
 *   JWT_REFRESH_EXPIRY   — e.g. '7d'
 *   CORS_ORIGIN          — allowed origin (e.g. https://notes.example.com)
 */

import Fastify from 'fastify';
import fastifyHelmet from '@fastify/helmet';
import fastifyCors from '@fastify/cors';
import fastifyJwt from '@fastify/jwt';
import fastifyCookie from '@fastify/cookie';
import fastifyRateLimit from '@fastify/rate-limit';
import fastifyWebsocket from '@fastify/websocket';
import { runMigrations } from './db/client.js';
import { getRedis, closeRedis } from './plugins/redis.js';
import authRoutes from './routes/auth.js';
import noteRoutes from './routes/notes.js';
import syncRoutes from './routes/sync.js';

// ---------------------------------------------------------------------------
// Validate required env vars early so failures are obvious
// ---------------------------------------------------------------------------
const REQUIRED_ENV = ['DATABASE_URL', 'JWT_ACCESS_SECRET', 'JWT_REFRESH_SECRET'];
for (const key of REQUIRED_ENV) {
  if (!process.env[key]) {
    console.error(`[fatal] Missing required environment variable: ${key}`);
    process.exit(1);
  }
}

const HOST = process.env.HOST ?? '10.66.66.1'; // WireGuard interface only
const PORT = parseInt(process.env.PORT ?? '3000', 10);
const IS_PROD = process.env.NODE_ENV === 'production';

// ---------------------------------------------------------------------------
// Build app
// ---------------------------------------------------------------------------
const app = Fastify({
  logger: {
    level: IS_PROD ? 'warn' : 'info',
    // In production, structured JSON logs are parsed by log shippers.
    // In dev, pretty-print for readability.
    transport: IS_PROD
      ? undefined
      : { target: 'pino-pretty', options: { colorize: true } },
  },
  // Trust the nginx reverse-proxy's X-Forwarded-For header for real IPs.
  // This matters for rate limiting to work correctly behind a proxy.
  trustProxy: true,
});

// ---------------------------------------------------------------------------
// Security headers (helmet)
// ---------------------------------------------------------------------------
// CSP is intentionally strict: no inline scripts, no external resources.
// The SvelteKit frontend bundles everything at build time.
await app.register(fastifyHelmet, {
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"], // SvelteKit inlines critical CSS
      imgSrc: ["'self'", 'data:'],             // data: for inline SVG favicons
      connectSrc: ["'self'", 'wss:'],          // wss: for WebSocket
      fontSrc: ["'self'"],
      objectSrc: ["'none'"],
      frameAncestors: ["'none'"],
    },
  },
  // HSTS: tell browsers to only use HTTPS for this origin for 1 year.
  // Nginx terminates TLS; we still set this header at the app layer.
  hsts: { maxAge: 31_536_000, includeSubDomains: true },
});

// ---------------------------------------------------------------------------
// CORS
// ---------------------------------------------------------------------------
// Only allow requests from the frontend origin.
// Credentials: true is required so the browser sends the refresh cookie.
await app.register(fastifyCors, {
  origin: process.env.CORS_ORIGIN ?? false,
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
});

// ---------------------------------------------------------------------------
// Rate limiting
// ---------------------------------------------------------------------------
// Global 200 req/min limit; auth routes apply stricter limits themselves.
await app.register(fastifyRateLimit, {
  global: true,
  max: 200,
  timeWindow: '1 minute',
  // Use real IP from X-Forwarded-For (nginx sets this)
  keyGenerator: (req) => req.ip,
});

// ---------------------------------------------------------------------------
// JWT
// ---------------------------------------------------------------------------
// Two secrets: one for short-lived access tokens, one for refresh tokens.
// We only register the access secret here; refresh verification uses
// fastify.jwt.verify() with the refresh secret explicitly in auth routes.
await app.register(fastifyJwt, {
  secret: process.env.JWT_ACCESS_SECRET!,
  sign: {
    expiresIn: process.env.JWT_ACCESS_EXPIRY ?? '15m',
    algorithm: 'HS256',
  },
  verify: {
    algorithms: ['HS256'],
  },
});

// ---------------------------------------------------------------------------
// Cookies (for httpOnly refresh token)
// ---------------------------------------------------------------------------
await app.register(fastifyCookie);

// ---------------------------------------------------------------------------
// WebSocket
// ---------------------------------------------------------------------------
await app.register(fastifyWebsocket);

// ---------------------------------------------------------------------------
// Database migrations (idempotent; safe to run every startup)
// ---------------------------------------------------------------------------
app.log.info('Running database migrations…');
await runMigrations();
app.log.info('Migrations complete.');

// ---------------------------------------------------------------------------
// Redis connectivity check
// ---------------------------------------------------------------------------
app.log.info('Checking Redis connectivity…');
const redis = getRedis();
await redis.ping(); // throws if Redis is unreachable — fail fast
app.log.info('Redis connected.');

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------
await app.register(authRoutes, { prefix: '/api/auth' });
await app.register(noteRoutes, { prefix: '/api' });
await app.register(syncRoutes); // registers GET /ws

// ---------------------------------------------------------------------------
// Health check (unauthenticated — used by Docker healthcheck)
// ---------------------------------------------------------------------------
app.get('/health', async () => ({ ok: true }));

// ---------------------------------------------------------------------------
// Graceful shutdown
// ---------------------------------------------------------------------------
async function shutdown(signal: string): Promise<void> {
  app.log.info(`Received ${signal}, shutting down…`);
  await app.close();
  await closeRedis();
  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// ---------------------------------------------------------------------------
// Start listening
// ---------------------------------------------------------------------------
try {
  await app.listen({ host: HOST, port: PORT });
  app.log.info(`Server listening on ${HOST}:${PORT}`);
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
