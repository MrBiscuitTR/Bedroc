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
 *   9. Listen on HOST:PORT (default 127.0.0.1:3000; Docker sets HOST=0.0.0.0).
 *
 * Environment variables (see .env.example):
 *   HOST                 — bind address (default: 127.0.0.1)
 *   PORT                 — listen port (default: 3000)
 *   NODE_ENV             — 'production' | 'development'
 *   DATABASE_URL         — postgres connection string
 *   REDIS_URL            — redis connection string
 *   JWT_ACCESS_SECRET    — secret for signing access JWTs (min 32 chars)
 *   JWT_REFRESH_SECRET   — secret for signing refresh JWTs (min 32 chars)
 *   JWT_ACCESS_EXPIRY    — e.g. '15m'
 *   JWT_REFRESH_EXPIRY   — e.g. '30d'
 *   CORS_ORIGIN          — REQUIRED. Allowed frontend origins, comma-separated
 *   TRUST_PROXY          — reverse-proxy hops to trust (default 1)
 *   ALLOW_REGISTRATION   — 'false' disables sign-up (default true)
 */

// config.ts MUST be imported first: it validates the environment and exits on
// insecure configuration before anything else is initialised.
import { HOST, PORT, IS_PROD, TRUST_PROXY, isOriginAllowed } from './config.js';
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
import attachmentRoutes from './routes/attachments.js';

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
    // Never log query strings (legacy WebSocket clients put the token there).
    serializers: {
      req: (req: { method: string; url: string }) => ({ method: req.method, url: req.url.split('?')[0] }),
    },
  },
  // How many reverse-proxy hops to trust for X-Forwarded-For (see config.ts).
  // (A hop count n is expressed as "trust the n nearest hops".)
  trustProxy: typeof TRUST_PROXY === 'number'
    ? (_addr: string, hop: number) => hop < (TRUST_PROXY as number)
    : TRUST_PROXY,
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
      connectSrc: ["'self'", 'https:', 'wss:'],          // https: for any self-hosted backend, wss: for WebSocket
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
// Bedroc uses a "public frontend, self-hosted backend" model:
// The frontend is served from any origin (hosted, Vercel, Electron, PWA),
// and users point it at their own backend URL.
//
// CORS_ORIGIN (required) lists the exact frontend origins allowed to talk to
// this backend, comma-separated. '*' is rejected at boot — see config.ts.
//
// CORS alone is not enough: "simple" cross-site requests (e.g. a POST with no
// custom headers) still reach the handler even when CORS blocks the response.
// So we also reject any request whose Origin is not on the allowlist before
// routing (this covers /api/auth/refresh, logout, and WebSocket upgrades).
app.addHook('onRequest', async (req, reply) => {
  const origin = req.headers.origin;
  if (origin && !isOriginAllowed(origin)) {
    // Let the blocked page READ this error (no credentials are ever allowed), so
    // the frontend can show "add this origin to CORS_ORIGIN" instead of a
    // generic "cannot reach server".
    reply.header('Access-Control-Allow-Origin', origin).header('Vary', 'Origin');
    if (req.method === 'OPTIONS') {
      return reply
        .header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE')
        .header('Access-Control-Allow-Headers', 'Content-Type, Authorization')
        .code(204).send();
    }
    return reply.code(403).send({
      error: 'origin_not_allowed',
      message: `This server does not accept requests from ${origin}. Add it to CORS_ORIGIN in the server's .env file.`,
    });
  }
  // Browsers always send Origin on cross-site POSTs, but belt-and-braces:
  if (!origin && req.headers['sec-fetch-site'] === 'cross-site' && req.method !== 'GET') {
    return reply.code(403).send({ error: 'Cross-site request blocked' });
  }
});

await app.register(fastifyCors, {
  origin: (origin, cb) => {
    // No Origin header: same-origin navigation or non-browser client (curl, health checks).
    if (!origin) return cb(null, true);
    cb(null, isOriginAllowed(origin));
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
});

// ---------------------------------------------------------------------------
// Rate limiting
// ---------------------------------------------------------------------------
// Global 500 req/min per-IP fallback. Individual route overrides below.
// With 0.5 s minimum sync interval, sync alone can reach 120 req/min.
// Notes/topics/folders CRUD during rapid reordering adds another ~100/min.
// Auth routes keep their own much stricter per-route limits (see auth.ts).
// To change per-route limits, set config.rateLimit on the route handler.
// To change the global fallback, update the max value below.
await app.register(fastifyRateLimit, {
  global: true,
  max: 500,
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
// maxPayload: clients only ever send tiny JSON control messages.
await app.register(fastifyWebsocket, { options: { maxPayload: 16 * 1024 } });

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
const redis = await getRedis();
await redis.ping(); // throws if Redis is unreachable — fail fast
app.log.info('Redis connected.');

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------
await app.register(authRoutes);
await app.register(noteRoutes);
await app.register(syncRoutes); // registers GET /ws
await app.register(attachmentRoutes);

// ---------------------------------------------------------------------------
// Health check (unauthenticated — used by Docker healthcheck)
// ---------------------------------------------------------------------------
app.get('/health', async () => ({ ok: true }));

// ---------------------------------------------------------------------------
// Error handler — never leak internal error messages (SQL, stack details)
// ---------------------------------------------------------------------------
app.setErrorHandler((err: Error & { statusCode?: number }, req, reply) => {
  const status = err.statusCode && err.statusCode >= 400 ? err.statusCode : 500;
  if (status >= 500) {
    req.log.error(err);
    return reply.code(status).send({ error: 'Internal server error' });
  }
  return reply.code(status).send({ error: err.message });
});

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
