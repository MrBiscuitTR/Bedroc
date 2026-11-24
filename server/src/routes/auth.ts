/**
 * routes/auth.ts — Registration, SRP-6a login, token refresh, logout, sessions,
 * password change and account deletion.
 *
 * SRP-6a (RFC 5054 / RFC 2945, SHA-256, 3072-bit group) — math in crypto/srp.ts.
 *
 *   x (v1, legacy) = H(s | H(I ":" P))
 *   x (v2)         = PBKDF2-SHA256(I ":" P, s, 600 000)      ← stretched
 *   v = g^x mod N  (stored)
 *
 *   login/init   : username → { challengeId, salt, B, kdf }
 *   login/verify : { challengeId, A, M1 [, upgrade] } → tokens + M2
 *
 * Security properties enforced here:
 *   - The password never reaches the server.
 *   - Unknown usernames get a deterministic fake salt + a real-looking B and a
 *     real challenge, so responses and errors are identical (no enumeration).
 *   - Challenges are keyed by a random challengeId (not by username), one-time.
 *   - Failed proofs are counted per username (not just per IP) → lockout.
 *   - Proofs are compared in constant time.
 *   - Refresh tokens rotate on use; replay of a rotated token revokes the
 *     session; revoked/unknown tokens are rejected (never re-issued).
 *   - Password change and account deletion require a fresh SRP proof.
 *   - Legacy v1 verifiers are upgraded to v2 in the same request that proves
 *     knowledge of the password.
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  createUser, getUserByUsername, getUserById, usernameTakenCaseInsensitive,
  upsertSessionForDevice, refreshSession, findSessionByPrevRefreshHash,
  deleteSessionById, revokeSession, revokeSessionByRefreshHash, revokeAllSessions,
  getSessionsForUser, revokeSessionById, updateUserCredentials, upgradeSrpVerifier,
  pruneExpiredSessions, deleteUser, type UserRow,
} from '../db/queries/users.js';
import { hashToken, verifyAuth, type AuthedRequest } from '../middleware/auth.js';
import { getRedis } from '../plugins/redis.js';
import { writeAccessLog } from '../plugins/accessLog.js';
import { ALLOW_REGISTRATION, JWT_REFRESH_SECRET, RECORD_LOGIN_IP } from '../config.js';
import {
  isValidVerifier, serverEphemeral, fakeServerEphemeral,
  fakeSalt, encodeB, verifyProof, dummyProofWork,
} from '../crypto/srp.js';

// ---------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------

const CHALLENGE_TTL_SEC       = 120;
const MAX_FAILURES            = 10;        // failed proofs per username …
const FAILURE_WINDOW_SEC      = 15 * 60;   // … within this window → locked until it expires
const REFRESH_RACE_GRACE_SEC  = Math.max(1, parseInt(process.env.REFRESH_REUSE_GRACE_SECONDS ?? '30', 10) || 30); // concurrent-tab refresh tolerance
const CURRENT_KDF_VERSION     = 2;
const REFRESH_COOKIE          = 'bedroc_refresh';
const REFRESH_COOKIE_PATH     = '/api/auth';          // covers /refresh and /logout
const LEGACY_COOKIE_PATH      = '/api/auth/refresh';  // pre-1.1 path; cleared on sight

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const sha256Hex = (s: string): string => createHash('sha256').update(s).digest('hex');

/** Client IP as resolved by Fastify according to TRUST_PROXY (not spoofable via XFF). */
function getClientIp(req: FastifyRequest): string | null {
  return req.ip || null;
}

/**
 * Derive a short human-readable device label from a User-Agent string.
 * Returns something like "Chrome on Windows", "Safari on iPhone", "Firefox on Mac".
 */
function parseDeviceInfo(ua: string): string {
  if (!ua) return 'Unknown device';

  let os = 'Unknown OS';
  if (/iPhone/.test(ua))                    os = 'iPhone';
  else if (/iPad/.test(ua))                 os = 'iPad';
  else if (/Android/.test(ua))              os = 'Android';
  else if (/Windows NT/.test(ua))           os = 'Windows';
  else if (/CrOS/.test(ua))                 os = 'ChromeOS';
  else if (/Macintosh|Mac OS X/.test(ua))   os = 'Mac';
  else if (/Linux/.test(ua))                os = 'Linux';

  let browser = 'Unknown browser';
  if (/Electron\//.test(ua))                browser = 'Electron app';
  else if (/EdgA\//.test(ua))               browser = 'Edge';
  else if (/Edg\//.test(ua))                browser = 'Edge';
  else if (/OPR\/|OPiOS\/|Opera/.test(ua))  browser = 'Opera';
  else if (/SamsungBrowser/.test(ua))       browser = 'Samsung Browser';
  else if (/CriOS\//.test(ua))              browser = 'Chrome';
  else if (/FxiOS\//.test(ua))              browser = 'Firefox';
  else if (/Chrome\//.test(ua))             browser = 'Chrome';
  else if (/Firefox\//.test(ua))            browser = 'Firefox';
  else if (/Version\//.test(ua) && /Safari\//.test(ua)) browser = 'Safari';
  else if (/Safari\//.test(ua))             browser = 'Safari';

  return `${browser} on ${os}`;
}

function deviceInfoOf(req: FastifyRequest): string {
  return parseDeviceInfo((req.headers['user-agent'] as string) ?? '');
}

// ---------------------------------------------------------------------------
// JWT + cookie helpers
// ---------------------------------------------------------------------------

function parseTtlMs(ttl: string): number {
  if (ttl.endsWith('d')) return parseInt(ttl) * 86_400_000;
  if (ttl.endsWith('h')) return parseInt(ttl) * 3_600_000;
  if (ttl.endsWith('m')) return parseInt(ttl) * 60_000;
  return parseInt(ttl) * 1000;
}

function issueTokens(fastify: FastifyInstance, userId: string) {
  const accessTtl  = process.env.JWT_ACCESS_EXPIRY  ?? '15m';
  const refreshTtl = process.env.JWT_REFRESH_EXPIRY ?? '30d';

  // `exp` in the payload overrides any @fastify/jwt global sign default.
  // `jti` makes every token unique — two tokens for the same user minted in
  // the same second would otherwise be byte-identical (same token_hash).
  const nowSec        = Math.floor(Date.now() / 1000);
  const accessMs      = parseTtlMs(accessTtl);
  const refreshMs     = parseTtlMs(refreshTtl);

  const accessToken = fastify.jwt.sign({
    sub: userId, jti: randomUUID(), exp: nowSec + Math.floor(accessMs / 1000),
  });
  const refreshToken = fastify.jwt.sign(
    { sub: userId, type: 'refresh', jti: randomUUID(), exp: nowSec + Math.floor(refreshMs / 1000) },
    { key: JWT_REFRESH_SECRET }
  );

  return {
    accessToken,
    refreshToken,
    accessExpiresAt:  new Date(Date.now() + accessMs),
    refreshExpiresAt: new Date(Date.now() + refreshMs),
    refreshMaxAge:    Math.floor(refreshMs / 1000),
  };
}

function setRefreshCookie(reply: FastifyReply, token: string, maxAge: number): void {
  // SameSite=None is required because the frontend and backend are normally on
  // different sites. CSRF is prevented by the strict Origin allowlist in index.ts.
  reply.setCookie(REFRESH_COOKIE, token, {
    httpOnly: true, secure: true, sameSite: 'none', path: REFRESH_COOKIE_PATH, maxAge,
  });
  reply.clearCookie(REFRESH_COOKIE, { path: LEGACY_COOKIE_PATH, sameSite: 'none', secure: true });
}

function clearRefreshCookies(reply: FastifyReply): void {
  reply.clearCookie(REFRESH_COOKIE, { path: REFRESH_COOKIE_PATH, sameSite: 'none', secure: true });
  reply.clearCookie(REFRESH_COOKIE, { path: LEGACY_COOKIE_PATH, sameSite: 'none', secure: true });
}

async function startSession(
  fastify: FastifyInstance, req: FastifyRequest, reply: FastifyReply, userId: string
) {
  const t = issueTokens(fastify, userId);
  await upsertSessionForDevice({
    userId,
    tokenHash:        hashToken(t.accessToken),
    refreshTokenHash: hashToken(t.refreshToken),
    deviceInfo:       deviceInfoOf(req) || null,
    loginIp:          RECORD_LOGIN_IP ? getClientIp(req) : null,
    expiresAt:        t.refreshExpiresAt,
  });
  setRefreshCookie(reply, t.refreshToken, t.refreshMaxAge);
  return t;
}

// ---------------------------------------------------------------------------
// Zod schemas
// ---------------------------------------------------------------------------

const hex = (min: number, max: number) =>
  z.string().min(min).max(max).regex(/^[0-9a-fA-F]+$/, 'must be hex');

const Username = z.string().min(3).max(32).regex(/^[a-zA-Z0-9_-]+$/);

/** Wrapped DEK: JSON { iv: base64(12 bytes), ct: base64(32 + 16 bytes) }. */
const EncryptedDek = z.string().min(1).max(512).refine((s) => {
  try {
    const o = JSON.parse(s) as { iv?: unknown; ct?: unknown };
    return typeof o.iv === 'string' && typeof o.ct === 'string'
      && /^[A-Za-z0-9+/=]{1,64}$/.test(o.iv) && /^[A-Za-z0-9+/=]{1,256}$/.test(o.ct);
  } catch { return false; }
}, 'invalid wrapped key');

const Verifier = hex(2, 768).refine((v) => isValidVerifier(Buffer.from(v.length % 2 ? '0' + v : v, 'hex')), 'invalid verifier');
const KdfVersion = z.union([z.literal(1), z.literal(2)]);

const RegisterSchema = z.object({
  username:      Username,
  srpSalt:       hex(64, 64),
  srpVerifier:   Verifier,
  encryptedDek:  EncryptedDek,
  dekSalt:       hex(64, 64),
  // Clients from before the KDF upgrade omit this → v1, upgraded at next login.
  srpKdfVersion: KdfVersion.optional(),
});

const LoginInitSchema = z.object({ username: z.string().min(1).max(32) });

const ProofSchema = z.object({
  challengeId: z.string().uuid(),
  A:           hex(1, 768),
  M1:          hex(64, 64),
});

const LoginVerifySchema = ProofSchema.extend({
  username: z.string().max(32).optional(),   // ignored; the challenge carries it
  upgrade: z.object({ srpSalt: hex(64, 64), srpVerifier: Verifier }).optional(),
});

const ChangePasswordSchema = z.object({
  proof:         ProofSchema,
  srpSalt:       hex(64, 64),
  srpVerifier:   Verifier,
  encryptedDek:  EncryptedDek,
  dekSalt:       hex(64, 64),
  srpKdfVersion: KdfVersion.optional(),
});

const DeleteAccountSchema = z.object({ proof: ProofSchema });

// ---------------------------------------------------------------------------
// Route plugin
// ---------------------------------------------------------------------------

interface StoredChallenge {
  b: string;                // server ephemeral secret (hex)
  userId: string | null;    // null → unknown username (fake challenge)
  username: string;
}

export default async function authRoutes(fastify: FastifyInstance): Promise<void> {
  const redis = await getRedis();

  // ── Per-username failure counter (lockout) ───────────────────────────────

  const failKey = (username: string) => `srp:fail:${sha256Hex(username.toLowerCase())}`;

  /** Returns seconds until unlock, or 0 if not locked. */
  async function lockedFor(username: string): Promise<number> {
    const key = failKey(username);
    const count = parseInt((await redis.get(key)) ?? '0', 10);
    if (count < MAX_FAILURES) return 0;
    const ttl = await redis.ttl(key);
    return ttl > 0 ? ttl : FAILURE_WINDOW_SEC;
  }

  async function recordFailure(username: string): Promise<void> {
    const key = failKey(username);
    const n = await redis.incr(key);
    if (n === 1) await redis.expire(key, FAILURE_WINDOW_SEC);
  }

  function sendLocked(reply: FastifyReply, seconds: number) {
    return reply.code(429).header('Retry-After', String(seconds)).send({
      error: 'too_many_attempts',
      message: `Too many failed attempts for this account. Try again in ${Math.ceil(seconds / 60)} minute(s).`,
      retryAfter: seconds,
    });
  }

  // ── Challenge creation / consumption ─────────────────────────────────────

  async function createChallenge(username: string) {
    const user = await getUserByUsername(username);
    const challengeId = randomUUID();

    if (!user) {
      // Indistinguishable from a real account: stable salt, valid-looking B,
      // a real stored challenge, newest KDF version.
      const { b, B } = fakeServerEphemeral();
      const stored: StoredChallenge = { b: b.toString(16), userId: null, username };
      await redis.setEx(`srp:c:${challengeId}`, CHALLENGE_TTL_SEC, JSON.stringify(stored));
      return {
        challengeId,
        salt: fakeSalt(JWT_REFRESH_SECRET, username).toString('hex'),
        B:    encodeB(B),
        kdf:  CURRENT_KDF_VERSION,
      };
    }

    const { b, B } = serverEphemeral(user.srp_verifier);
    const stored: StoredChallenge = { b: b.toString(16), userId: user.id, username: user.username };
    await redis.setEx(`srp:c:${challengeId}`, CHALLENGE_TTL_SEC, JSON.stringify(stored));
    return {
      challengeId,
      salt: user.srp_salt.toString('hex'),
      B:    encodeB(B),
      kdf:  user.srp_kdf_version,
    };
  }

  type ProofOutcome =
    | { ok: true; user: UserRow; M2: Buffer }
    | { ok: false; status: number; body: Record<string, unknown> };

  const AUTH_FAILED = { status: 401, body: { error: 'Authentication failed' } };

  /**
   * Consume a challenge (one-time) and verify the client's proof.
   * Every failure path returns the same 401 body, whether or not the user exists.
   */
  async function consumeProof(
    proof: z.infer<typeof ProofSchema>,
    expectedUserId?: string
  ): Promise<ProofOutcome> {
    const key = `srp:c:${proof.challengeId}`;
    // GETDEL is atomic: a challenge can be used at most once, even concurrently.
    const raw = await redis.getDel(key);
    if (!raw) return { ok: false, ...AUTH_FAILED };
    const ch = JSON.parse(raw) as StoredChallenge;

    const locked = await lockedFor(ch.username);
    if (locked > 0) {
      return { ok: false, status: 429, body: { error: 'too_many_attempts', retryAfter: locked } };
    }

    const b = BigInt('0x' + ch.b);
    const user = ch.userId ? await getUserById(ch.userId) : null;

    if (!user || (expectedUserId && user.id !== expectedUserId)) {
      dummyProofWork(b);
      await recordFailure(ch.username);
      return { ok: false, ...AUTH_FAILED };
    }

    const A = BigInt('0x' + proof.A);
    const result = verifyProof({
      username: user.username,
      salt:     user.srp_salt,
      A,
      b,
      verifier: user.srp_verifier,
      clientM1: Buffer.from(proof.M1, 'hex'),
    });

    if (!result.valid) {
      await recordFailure(ch.username);
      return { ok: false, ...AUTH_FAILED };
    }

    await redis.del(failKey(ch.username));
    return { ok: true, user, M2: result.M2 };
  }

  // ── Register ─────────────────────────────────────────────────────────────

  fastify.post('/api/auth/register', {
    config: { rateLimit: { max: 5, timeWindow: '1 minute' } },
  }, async (req: FastifyRequest, reply: FastifyReply) => {
    if (!ALLOW_REGISTRATION) {
      return reply.code(403).send({ error: 'Registration is disabled on this server.' });
    }
    const parse = RegisterSchema.safeParse(req.body);
    if (!parse.success) return reply.code(400).send({ error: 'Invalid request', details: parse.error.flatten() });
    const { username, srpSalt, srpVerifier, encryptedDek, dekSalt, srpKdfVersion } = parse.data;

    if (await usernameTakenCaseInsensitive(username)) {
      return reply.code(409).send({ error: 'Username already taken' });
    }

    let user: UserRow;
    try {
      user = await createUser({
        username,
        srpSalt:       Buffer.from(srpSalt, 'hex'),
        srpVerifier:   Buffer.from(srpVerifier.length % 2 ? '0' + srpVerifier : srpVerifier, 'hex'),
        encryptedDek,
        dekSalt:       Buffer.from(dekSalt, 'hex'),
        srpKdfVersion: srpKdfVersion ?? 1,
      });
    } catch (err) {
      if ((err as { code?: string }).code === '23505') {
        return reply.code(409).send({ error: 'Username already taken' });
      }
      throw err;
    }

    const t = await startSession(fastify, req, reply, user.id);
    writeAccessLog('register', username, getClientIp(req));

    return reply.code(201).send({
      accessToken: t.accessToken,
      expiresAt:   t.accessExpiresAt.toISOString(),
      userId:      user.id,
      username:    user.username,
      encryptedDek,
      dekSalt,
    });
  });

  // ── Login step 1: username → { challengeId, salt, B, kdf } ───────────────

  fastify.post('/api/auth/login/init', {
    config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
  }, async (req: FastifyRequest, reply: FastifyReply) => {
    const parse = LoginInitSchema.safeParse(req.body);
    if (!parse.success) return reply.code(400).send({ error: 'Invalid request' });
    const { username } = parse.data;

    const locked = await lockedFor(username);
    if (locked > 0) return sendLocked(reply, locked);

    return reply.code(200).send(await createChallenge(username));
  });

  // ── Login step 2: { challengeId, A, M1 } → tokens + M2 ───────────────────

  fastify.post('/api/auth/login/verify', {
    config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
  }, async (req: FastifyRequest, reply: FastifyReply) => {
    const parse = LoginVerifySchema.safeParse(req.body);
    if (!parse.success) return reply.code(400).send({ error: 'Invalid request' });

    const outcome = await consumeProof(parse.data);
    if (!outcome.ok) {
      if (outcome.status === 429) return sendLocked(reply, Number(outcome.body.retryAfter));
      return reply.code(outcome.status).send(outcome.body);
    }
    const { user, M2 } = outcome;

    // Transparent KDF upgrade: the client proved the password in THIS request,
    // so it may replace its legacy v1 verifier with a stretched v2 one.
    let kdfUpgraded = false;
    const upgrade = parse.data.upgrade;
    if (upgrade && user.srp_kdf_version < CURRENT_KDF_VERSION) {
      kdfUpgraded = await upgradeSrpVerifier({
        id:          user.id,
        srpSalt:     Buffer.from(upgrade.srpSalt, 'hex'),
        srpVerifier: Buffer.from(upgrade.srpVerifier.length % 2 ? '0' + upgrade.srpVerifier : upgrade.srpVerifier, 'hex'),
      });
    }

    const t = await startSession(fastify, req, reply, user.id);
    writeAccessLog('login', user.username, getClientIp(req));

    return reply.code(200).send({
      accessToken:  t.accessToken,
      expiresAt:    t.accessExpiresAt.toISOString(),
      userId:       user.id,
      username:     user.username,
      encryptedDek: user.encrypted_dek,
      dekSalt:      user.dek_salt.toString('hex'),
      M2:           M2.toString('hex'),
      kdfUpgraded,
    });
  });

  // ── Refresh access token ─────────────────────────────────────────────────

  fastify.post('/api/auth/refresh', {
    config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
  }, async (req: FastifyRequest, reply: FastifyReply) => {
    const refreshToken = req.cookies?.[REFRESH_COOKIE];
    if (!refreshToken) return reply.code(401).send({ error: 'No refresh token' });

    let payload: { sub: string; type?: string };
    try {
      payload = fastify.jwt.verify(refreshToken, { key: JWT_REFRESH_SECRET }) as { sub: string; type?: string };
    } catch {
      clearRefreshCookies(reply);
      return reply.code(401).send({ error: 'Invalid refresh token' });
    }
    if (payload.type !== 'refresh' || !payload.sub) {
      clearRefreshCookies(reply);
      return reply.code(401).send({ error: 'Invalid token type' });
    }

    const presentedHash = hashToken(refreshToken);
    const t = issueTokens(fastify, payload.sub);

    const sessionId = await refreshSession({
      userId:              payload.sub,
      refreshTokenHash:    presentedHash,
      newTokenHash:        hashToken(t.accessToken),
      newRefreshTokenHash: hashToken(t.refreshToken),
      newExpiresAt:        t.refreshExpiresAt,
    });

    if (!sessionId) {
      // Not the current token of any live session. Either it was just rotated
      // by a concurrent request (benign: another tab), or it is being replayed.
      const prev = await findSessionByPrevRefreshHash(payload.sub, presentedHash, REFRESH_RACE_GRACE_SEC);
      if (prev?.inGrace) {
        // The browser's cookie jar already holds (or is about to hold) the new
        // token — tell the client to retry shortly. Do NOT clear the cookie.
        return reply.code(409).send({ error: 'refresh_race' });
      }
      if (prev) {
        // A rotated token was replayed outside the grace window → assume theft.
        await deleteSessionById(prev.id);
        req.log.warn({ userId: payload.sub }, 'refresh token reuse detected; session revoked');
      }
      // Revoked, logged-out, expired, or unknown session: never re-issue.
      clearRefreshCookies(reply);
      return reply.code(401).send({ error: 'Session expired or revoked' });
    }

    await pruneExpiredSessions(payload.sub);
    setRefreshCookie(reply, t.refreshToken, t.refreshMaxAge);
    return reply.code(200).send({ accessToken: t.accessToken, expiresAt: t.accessExpiresAt.toISOString() });
  });

  // ── Logout ───────────────────────────────────────────────────────────────

  fastify.post('/api/auth/logout', async (req: FastifyRequest, reply: FastifyReply) => {
    // Best-effort: revoke by whichever credential the client still holds.
    const authHeader = req.headers.authorization ?? '';
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
    if (token) await revokeSession(hashToken(token));
    const refreshToken = req.cookies?.[REFRESH_COOKIE];
    if (refreshToken) await revokeSessionByRefreshHash(hashToken(refreshToken));

    clearRefreshCookies(reply);
    return reply.code(200).send({ ok: true });
  });

  // ── Sessions list (protected) ────────────────────────────────────────────

  fastify.get('/api/auth/sessions', async (req: FastifyRequest, reply: FastifyReply) => {
    await verifyAuth(req, reply);
    if (reply.sent) return;
    const { userId, sessionId } = req as AuthedRequest;
    const sessions = await getSessionsForUser(userId);
    return reply.code(200).send({ sessions, currentSessionId: sessionId });
  });

  // ── Revoke a specific session (protected) ───────────────────────────────

  fastify.delete('/api/auth/sessions/:id', async (req: FastifyRequest, reply: FastifyReply) => {
    await verifyAuth(req, reply);
    if (reply.sent) return;
    const { id } = req.params as { id: string };
    if (!z.string().uuid().safeParse(id).success) return reply.code(400).send({ error: 'Invalid id' });
    await revokeSessionById(id, (req as AuthedRequest).userId);
    return reply.code(200).send({ ok: true });
  });

  // ── Revoke all sessions (logout everywhere) (protected) ─────────────────

  fastify.post('/api/auth/sessions/revoke-all', async (req: FastifyRequest, reply: FastifyReply) => {
    await verifyAuth(req, reply);
    if (reply.sent) return;
    await revokeAllSessions((req as AuthedRequest).userId);
    clearRefreshCookies(reply);
    return reply.code(200).send({ ok: true });
  });

  // ── Delete account (protected + fresh SRP proof) ─────────────────────────
  // Deletes the user row; CASCADE removes sessions, notes, topics, folders,
  // attachments. Requires the password (via SRP) — an access token alone must
  // not be able to destroy an E2EE account irrecoverably.

  fastify.delete('/api/auth/account', {
    config: { rateLimit: { max: 5, timeWindow: '1 minute' } },
  }, async (req: FastifyRequest, reply: FastifyReply) => {
    await verifyAuth(req, reply);
    if (reply.sent) return;
    const { userId } = req as AuthedRequest;

    const parse = DeleteAccountSchema.safeParse(req.body);
    if (!parse.success) return reply.code(400).send({ error: 'Password confirmation required' });

    const outcome = await consumeProof(parse.data.proof, userId);
    if (!outcome.ok) {
      if (outcome.status === 429) return sendLocked(reply, Number(outcome.body.retryAfter));
      return reply.code(403).send({ error: 'Password confirmation failed' });
    }

    await deleteUser(userId);
    clearRefreshCookies(reply);
    return reply.code(200).send({ ok: true });
  });

  // ── Change password (protected + fresh SRP proof) ────────────────────────
  // The client proves the CURRENT password via SRP and sends new material
  // derived from the NEW password. On success every other session is revoked.

  fastify.post('/api/auth/change-password', {
    config: { rateLimit: { max: 5, timeWindow: '1 minute' } },
  }, async (req: FastifyRequest, reply: FastifyReply) => {
    await verifyAuth(req, reply);
    if (reply.sent) return;
    const { userId, sessionId } = req as AuthedRequest;

    const parse = ChangePasswordSchema.safeParse(req.body);
    if (!parse.success) return reply.code(400).send({ error: 'Invalid request', details: parse.error.flatten() });
    const { proof, srpSalt, srpVerifier, encryptedDek, dekSalt, srpKdfVersion } = parse.data;

    const outcome = await consumeProof(proof, userId);
    if (!outcome.ok) {
      if (outcome.status === 429) return sendLocked(reply, Number(outcome.body.retryAfter));
      return reply.code(403).send({ error: 'Current password is incorrect' });
    }

    await updateUserCredentials({
      id:            userId,
      srpSalt:       Buffer.from(srpSalt, 'hex'),
      srpVerifier:   Buffer.from(srpVerifier.length % 2 ? '0' + srpVerifier : srpVerifier, 'hex'),
      encryptedDek,
      dekSalt:       Buffer.from(dekSalt, 'hex'),
      srpKdfVersion: srpKdfVersion ?? 1,
      keepSessionId: sessionId,
    });

    return reply.code(200).send({ ok: true });
  });
}
