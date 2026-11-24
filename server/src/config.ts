/**
 * config.ts — Environment parsing and validation (fail fast, fail loudly).
 *
 * Imported first by index.ts. Any misconfiguration that would leave the server
 * insecure (missing/weak secrets, wildcard CORS with credentials) aborts boot
 * with a message that says exactly what to change.
 */

function fatal(msg: string): never {
  console.error(`\n[fatal] ${msg}\n`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Required variables
// ---------------------------------------------------------------------------

for (const key of ['DATABASE_URL', 'JWT_ACCESS_SECRET', 'JWT_REFRESH_SECRET', 'CORS_ORIGIN']) {
  if (!process.env[key] || !process.env[key]!.trim()) {
    fatal(
      `Missing required environment variable: ${key}\n` +
      `        See .env.example for what to put here.`
    );
  }
}

const accessSecret = process.env.JWT_ACCESS_SECRET!;
const refreshSecret = process.env.JWT_REFRESH_SECRET!;
for (const [name, value] of [['JWT_ACCESS_SECRET', accessSecret], ['JWT_REFRESH_SECRET', refreshSecret]] as const) {
  if (value.length < 32) fatal(`${name} must be at least 32 characters. Generate one with: openssl rand -hex 32`);
  if (/CHANGE_THIS/i.test(value)) fatal(`${name} still has the placeholder value from .env.example. Generate one with: openssl rand -hex 32`);
}
if (accessSecret === refreshSecret) {
  fatal('JWT_ACCESS_SECRET and JWT_REFRESH_SECRET must be different values.');
}

// ---------------------------------------------------------------------------
// CORS / Origin allowlist
// ---------------------------------------------------------------------------
//
// The refresh token is an ambient httpOnly cookie (SameSite=None, because the
// frontend and backend are usually on different sites). If ANY origin were
// allowed with credentials, any web page the user visits could call
// /api/auth/refresh and read a fresh access token. So:
//   - CORS_ORIGIN is required and must list exact origins.
//   - '*' is rejected.
//   - A port wildcard is allowed for loopback only (http://localhost:*),
//     for the desktop app, which serves the UI from a local port.

export interface OriginRule { scheme: string; host: string; port: string | '*' }

function parseOriginRule(raw: string): OriginRule {
  const m = /^(https?):\/\/([^/:]+)(?::(\d+|\*))?\/?$/i.exec(raw);
  if (!m) fatal(`CORS_ORIGIN entry "${raw}" is not a valid origin (expected e.g. https://notes.example.com)`);
  const scheme = m[1].toLowerCase();
  const host = m[2].toLowerCase();
  if (host.includes('*')) fatal(`CORS_ORIGIN entry "${raw}": wildcard hostnames are not supported — list each origin explicitly.`);
  const port = m[3] ?? (scheme === 'https' ? '443' : '80');
  if (port === '*' && !['localhost', '127.0.0.1', '[::1]'].includes(host)) {
    fatal(`CORS_ORIGIN entry "${raw}": a port wildcard is only allowed for localhost / 127.0.0.1.`);
  }
  return { scheme, host, port };
}

const rawOrigins = process.env.CORS_ORIGIN!.split(',').map((o) => o.trim()).filter(Boolean);
if (rawOrigins.includes('*')) {
  fatal(
    'CORS_ORIGIN must not contain "*".\n' +
    '        Allowing every origin together with the refresh cookie lets any website\n' +
    '        take over a logged-in user\'s session. List the exact frontend origins, e.g.\n' +
    '        CORS_ORIGIN=https://bedroc.cagancalidag.com,http://localhost:49152 (or http://localhost:*)'
  );
}
export const ORIGIN_RULES: OriginRule[] = rawOrigins.map(parseOriginRule);

export function isOriginAllowed(origin: string): boolean {
  let u: URL;
  try { u = new URL(origin); } catch { return false; }
  const scheme = u.protocol.replace(':', '');
  const host = u.hostname.toLowerCase();
  const port = u.port || (scheme === 'https' ? '443' : '80');
  return ORIGIN_RULES.some(
    (r) => r.scheme === scheme && r.host === host && (r.port === '*' || r.port === port)
  );
}

// ---------------------------------------------------------------------------
// Proxy trust
// ---------------------------------------------------------------------------
//
// Determines how req.ip is derived from X-Forwarded-For. `true` (trust every
// hop) lets any client spoof its IP and bypass per-IP rate limits, because
// nginx APPENDS to a client-supplied X-Forwarded-For header.
//
//   TRUST_PROXY=1            (default) exactly one reverse proxy in front (nginx / Caddy)
//   TRUST_PROXY=0 | false    server is exposed directly
//   TRUST_PROXY=2            two proxies (e.g. Cloudflare → Caddy)
//   TRUST_PROXY=10.0.0.1,... trust specific proxy addresses / CIDRs

function parseTrustProxy(raw: string | undefined): boolean | number | string[] {
  if (raw === undefined || raw.trim() === '') return 1;
  const v = raw.trim().toLowerCase();
  if (v === 'false' || v === '0') return false;
  if (v === 'true') fatal('TRUST_PROXY=true trusts every hop and lets clients spoof their IP. Use a hop count (e.g. 1) instead.');
  if (/^\d+$/.test(v)) return parseInt(v, 10);
  return raw.split(',').map((s) => s.trim()).filter(Boolean);
}
export const TRUST_PROXY = parseTrustProxy(process.env.TRUST_PROXY);

// ---------------------------------------------------------------------------
// Misc
// ---------------------------------------------------------------------------

export const HOST = process.env.HOST ?? '127.0.0.1';
export const PORT = parseInt(process.env.PORT ?? '3000', 10);
export const IS_PROD = process.env.NODE_ENV === 'production';
/** Set ALLOW_REGISTRATION=false to stop new sign-ups (existing users unaffected). */
export const ALLOW_REGISTRATION = (process.env.ALLOW_REGISTRATION ?? 'true').toLowerCase() !== 'false';
export const JWT_REFRESH_SECRET = refreshSecret;
