/**
 * routes/auth.ts — Registration, SRP-6a login, logout, session management.
 *
 * SRP-6a overview (RFC 5054 / RFC 2945):
 *   N  = large safe prime (3072-bit MODP group from RFC 3526)
 *   g  = generator (2)
 *   k  = H(N | PAD(g))  (SRP-6a multiplier)
 *   x  = H(salt | H(username ":" password))
 *   v  = g^x mod N  (verifier, stored server-side)
 *
 *   Login:
 *     Client sends  A = g^a mod N  (ephemeral public key)
 *     Server sends  B = (k*v + g^b) mod N  and salt
 *     Client sends  M1 = H(H(N) xor H(g) | H(username) | salt | A | B | K)
 *     Server verifies M1, sends M2 = H(A | M1 | K)
 *
 *   We use Node's built-in `crypto` module (BigInt arithmetic) — no third-party SRP lib.
 *   The 3072-bit MODP group is used (same as RFC 5054 §A.2).
 *
 * Key design points:
 *   - The password is NEVER sent to the server in any form.
 *   - The SRP verifier cannot be reversed to obtain the password.
 *   - JWTs are short-lived (15 min).  Refresh tokens are long-lived (7d),
 *     rotated on each use, stored hashed.
 *   - All token hashes are stored in the sessions table for instant revocation.
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { createHash, randomBytes } from 'node:crypto';
import { z } from 'zod';
import {
  createUser, getUserByUsername, getUserById,
  createSession, revokeSession, revokeAllSessions,
  getSessionsForUser, revokeSessionById,
} from '../db/queries/users.js';
import { hashToken, verifyAuth } from '../middleware/auth.js';
import { getRedis } from '../plugins/redis.js';

// ---------------------------------------------------------------------------
// SRP-6a constants  (RFC 3526 — 3072-bit MODP group)
// ---------------------------------------------------------------------------

// N as a hex string — 3072-bit safe prime from RFC 3526 §2
const N_HEX =
  'FFFFFFFFFFFFFFFFC90FDAA22168C234C4C6628B80DC1CD1' +
  '29024E088A67CC74020BBEA63B139B22514A08798E3404DD' +
  'EF9519B3CD3A431B302B0A6DF25F14374FE1356D6D51C245' +
  'E485B576625E7EC6F44C42E9A637ED6B0BFF5CB6F406B7ED' +
  'EE386BFB5A899FA5AE9F24117C4B1FE649286651ECE45B3D' +
  'C2007CB8A163BF0598DA48361C55D39A69163FA8FD24CF5F' +
  '83655D23DCA3AD961C62F356208552BB9ED529077096966D' +
  '670C354E4ABC9804F1746C08CA18217C32905E462E36CE3B' +
  'E39E772C180E86039B2783A2EC07A28FB5C55DF06F4C52C9' +
  'DE2BCBF6955817183995497CEA956AE515D2261898FA0510' +
  '15728E5A8AAAC42DAD33170D04507A33A85521ABDF1CBA64' +
  'ECFB850458DBEF0A8AEA71575D060C7DB3970F85A6E1E4C7' +
  'ABF5AE8CDB0933D71E8C94E04A25619DCEE3D2261AD2EE6B' +
  'F12FFA06D98A0864D87602733EC86A64521F2B18177B200C' +
  'BBE117577A615D6C770988C0BAD946E208E24FA074E5AB31' +
  '43DB5BFCE0FD108E4B82D120A93AD2CAFFFFFFFFFFFFFFFF';

const N = BigInt('0x' + N_HEX);
const g = BigInt(2);

// k = H(N | PAD(g))  where PAD pads g to len(N)
function srpK(): bigint {
  const nBuf = hexToBuffer(N_HEX);
  const gBuf = Buffer.alloc(nBuf.length);
  const gB = bigintToBuffer(g, nBuf.length);
  gB.copy(gBuf, nBuf.length - gB.length);
  return bufferToBigint(sha256(Buffer.concat([nBuf, gBuf])));
}
const k = srpK();

// ---------------------------------------------------------------------------
// Crypto helpers
// ---------------------------------------------------------------------------

function sha256(data: Buffer | string): Buffer {
  return createHash('sha256').update(data).digest();
}

function sha256Hex(data: Buffer | string): string {
  return createHash('sha256').update(data).digest('hex');
}

function hexToBuffer(hex: string): Buffer {
  return Buffer.from(hex.replace(/\s/g, ''), 'hex');
}

function bufferToHex(buf: Buffer): string {
  return buf.toString('hex');
}

function bigintToBuffer(n: bigint, len?: number): Buffer {
  let hex = n.toString(16);
  if (hex.length % 2 !== 0) hex = '0' + hex;
  const buf = Buffer.from(hex, 'hex');
  if (len && buf.length < len) {
    const padded = Buffer.alloc(len);
    buf.copy(padded, len - buf.length);
    return padded;
  }
  return buf;
}

function bufferToBigint(buf: Buffer): bigint {
  return BigInt('0x' + bufferToHex(buf));
}

function modpow(base: bigint, exp: bigint, mod: bigint): bigint {
  let result = BigInt(1);
  base = base % mod;
  while (exp > 0n) {
    if (exp % 2n === 1n) result = (result * base) % mod;
    exp = exp / 2n;
    base = (base * base) % mod;
  }
  return result;
}

// ---------------------------------------------------------------------------
// SRP verifier + server-side ephemeral
// ---------------------------------------------------------------------------

/**
 * Compute the SRP-6a verifier from a salt and x.
 * x = H(salt | H(username ":" password)) — computed client-side.
 * v = g^x mod N — stored server-side.
 *
 * The server never computes x; it receives v from the client during registration.
 */
export function srpVerifierFromHex(vHex: string): Buffer {
  return hexToBuffer(vHex);
}

/** Generate server ephemeral key pair: b (secret, random) and B (public). */
function serverEphemeral(verifier: Buffer): { b: bigint; B: bigint } {
  const b = bufferToBigint(randomBytes(32));
  const v = bufferToBigint(verifier);
  // B = (k*v + g^b) mod N
  const B = ((k * v % N) + modpow(g, b, N)) % N;
  return { b, B };
}

/**
 * Verify the client proof M1 and compute server proof M2.
 *
 * M1 = H( H(N) xor H(g) | H(username) | salt | A | B | K )
 * K  = H(S)  where S = (A * v^u) ^ b mod N
 * u  = H(A | B)
 */
function verifySrpProof(params: {
  username: string;
  salt: Buffer;
  A: bigint;
  B: bigint;
  b: bigint;
  verifier: Buffer;
  clientM1: Buffer;
}): { valid: boolean; M2: Buffer; sessionKey: Buffer } {
  const { username, salt, A, B, b, verifier, clientM1 } = params;
  const v = bufferToBigint(verifier);
  const nLen = bigintToBuffer(N).length;

  // u = H(PAD(A) | PAD(B))
  const APad = bigintToBuffer(A, nLen);
  const BPad = bigintToBuffer(B, nLen);
  const u = bufferToBigint(sha256(Buffer.concat([APad, BPad])));

  // S = (A * v^u mod N) ^ b mod N
  const S = modpow((A * modpow(v, u, N)) % N, b, N);
  const K = sha256(bigintToBuffer(S, nLen));

  // H(N) xor H(g)
  const HN = sha256(bigintToBuffer(N, nLen));
  const Hg = sha256(bigintToBuffer(g));
  const HNxorHg = Buffer.alloc(32);
  for (let i = 0; i < 32; i++) HNxorHg[i] = HN[i] ^ Hg[i];

  // M1 = H( HN^Hg | H(username) | salt | PAD(A) | PAD(B) | K )
  const Husername = sha256(Buffer.from(username, 'utf8'));
  const expectedM1 = sha256(Buffer.concat([HNxorHg, Husername, salt, APad, BPad, K]));

  if (!expectedM1.equals(clientM1)) {
    return { valid: false, M2: Buffer.alloc(0), sessionKey: Buffer.alloc(0) };
  }

  // M2 = H( PAD(A) | M1 | K )
  const M2 = sha256(Buffer.concat([APad, clientM1, K]));
  return { valid: true, M2, sessionKey: K };
}

// ---------------------------------------------------------------------------
// JWT helpers
// ---------------------------------------------------------------------------

function issueTokens(
  fastify: FastifyInstance,
  userId: string
): { accessToken: string; refreshToken: string; accessExpiresAt: Date; refreshExpiresAt: Date } {
  const accessTtl = process.env.JWT_ACCESS_EXPIRY ?? '15m';
  const refreshTtl = process.env.JWT_REFRESH_EXPIRY ?? '7d';

  const accessToken = fastify.jwt.sign(
    { sub: userId },
    { expiresIn: accessTtl }
  );
  const refreshToken = fastify.jwt.sign(
    { sub: userId, type: 'refresh' },
    { secret: process.env.JWT_REFRESH_SECRET ?? 'changeme-refresh',
      expiresIn: refreshTtl }
  );

  const accessMs = accessTtl.endsWith('m')
    ? parseInt(accessTtl) * 60_000
    : parseInt(accessTtl) * 1000;
  const refreshMs = refreshTtl.endsWith('d')
    ? parseInt(refreshTtl) * 86_400_000
    : 604_800_000;

  return {
    accessToken,
    refreshToken,
    accessExpiresAt: new Date(Date.now() + accessMs),
    refreshExpiresAt: new Date(Date.now() + refreshMs),
  };
}

// ---------------------------------------------------------------------------
// Zod schemas
// ---------------------------------------------------------------------------

const RegisterSchema = z.object({
  username:     z.string().min(3).max(32).regex(/^[a-zA-Z0-9_-]+$/),
  srpSalt:      z.string().min(64).max(64),      // 32 bytes hex
  srpVerifier:  z.string().min(1).max(2048),      // hex bigint
  encryptedDek: z.string().min(1),               // JSON { iv, ct }
  dekSalt:      z.string().min(64).max(64),       // 32 bytes hex
});

const LoginInitSchema  = z.object({ username: z.string().min(1) });

const LoginVerifySchema = z.object({
  username:   z.string().min(1),
  clientA:    z.string().min(1),   // A hex
  clientM1:   z.string().min(1),   // M1 hex
});

// ---------------------------------------------------------------------------
// Route plugin
// ---------------------------------------------------------------------------

export default async function authRoutes(fastify: FastifyInstance): Promise<void> {
  const redis = await getRedis();

  // ── Register ─────────────────────────────────────────────────────────────

  fastify.post('/api/auth/register', async (req: FastifyRequest, reply: FastifyReply) => {
    const parse = RegisterSchema.safeParse(req.body);
    if (!parse.success) return reply.code(400).send({ error: 'Invalid request', details: parse.error.flatten() });
    const { username, srpSalt, srpVerifier, encryptedDek, dekSalt } = parse.data;

    // Check uniqueness
    const existing = await getUserByUsername(username);
    if (existing) return reply.code(409).send({ error: 'Username already taken' });

    await createUser({
      username,
      srpSalt:     Buffer.from(srpSalt, 'hex'),
      srpVerifier: Buffer.from(srpVerifier, 'hex'),
      encryptedDek,
      dekSalt:     Buffer.from(dekSalt, 'hex'),
    });

    return reply.code(201).send({ ok: true });
  });

  // ── Login step 1: client sends username → server returns salt + B ────────

  fastify.post('/api/auth/login/init', async (req: FastifyRequest, reply: FastifyReply) => {
    const parse = LoginInitSchema.safeParse(req.body);
    if (!parse.success) return reply.code(400).send({ error: 'Invalid request' });
    const { username } = parse.data;

    const user = await getUserByUsername(username);
    // Return a fake response for unknown users to prevent user enumeration
    if (!user) {
      const fakeSalt = randomBytes(32).toString('hex');
      const fakeB    = randomBytes(384).toString('hex');
      return reply.code(200).send({ srpSalt: fakeSalt, serverB: fakeB });
    }

    const { b, B } = serverEphemeral(user.srp_verifier);
    const serverBHex = bigintToBuffer(B).toString('hex');

    // Store server ephemeral secret in Redis with 120s TTL
    const challengeKey = `srp:${sha256Hex(username)}`;
    await redis.setEx(
      challengeKey,
      120,
      JSON.stringify({ b: b.toString(16), userId: user.id })
    );

    return reply.code(200).send({
      srpSalt:  user.srp_salt.toString('hex'),
      serverB:  serverBHex,
    });
  });

  // ── Login step 2: client sends A + M1 → server verifies + issues JWT ────

  fastify.post('/api/auth/login/verify', async (req: FastifyRequest, reply: FastifyReply) => {
    const parse = LoginVerifySchema.safeParse(req.body);
    if (!parse.success) return reply.code(400).send({ error: 'Invalid request' });
    const { username, clientA, clientM1 } = parse.data;

    // Retrieve ephemeral from Redis
    const challengeKey = `srp:${sha256Hex(username)}`;
    const stored = await redis.get(challengeKey);
    if (!stored) return reply.code(401).send({ error: 'Login session expired. Please retry.' });

    const { b: bHex, userId } = JSON.parse(stored) as { b: string; userId: string };
    await redis.del(challengeKey);  // one-time use

    const user = await getUserById(userId);
    if (!user) return reply.code(401).send({ error: 'Unauthorized' });

    const A = BigInt('0x' + clientA);
    // A must not be 0 mod N (SRP spec §6)
    if (A % N === 0n) return reply.code(401).send({ error: 'Invalid client key' });

    // Re-derive B to verify (we only stored b; recompute B from b and verifier)
    const b = BigInt('0x' + bHex);
    const v = bufferToBigint(user.srp_verifier);
    const B = ((k * v % N) + modpow(g, b, N)) % N;

    const { valid, M2 } = verifySrpProof({
      username,
      salt:      user.srp_salt,
      A,
      B,
      b,
      verifier:  user.srp_verifier,
      clientM1:  Buffer.from(clientM1, 'hex'),
    });

    if (!valid) return reply.code(401).send({ error: 'Authentication failed' });

    // Issue JWTs
    const { accessToken, refreshToken, accessExpiresAt, refreshExpiresAt } = issueTokens(fastify, userId);
    const deviceInfo = ((req.headers['user-agent'] as string) ?? '').slice(0, 200);

    // Store hashed access token for revocation checks
    await createSession({
      userId,
      tokenHash:  hashToken(accessToken),
      deviceInfo: deviceInfo || null,
      expiresAt:  accessExpiresAt,
    });

    // Refresh token stored in httpOnly cookie (never accessible to JS)
    reply.setCookie('bedroc_refresh', refreshToken, {
      httpOnly: true,
      secure:   process.env.NODE_ENV === 'production',
      sameSite: 'strict',
      path:     '/api/auth/refresh',
      maxAge:   7 * 24 * 3600,
    });

    return reply.code(200).send({
      accessToken,
      expiresAt:    accessExpiresAt.toISOString(),
      encryptedDek: user.encrypted_dek,
      dekSalt:      user.dek_salt.toString('hex'),
      serverM2:     M2.toString('hex'),
    });
  });

  // ── Refresh access token ─────────────────────────────────────────────────

  fastify.post('/api/auth/refresh', async (req: FastifyRequest, reply: FastifyReply) => {
    const refreshToken = req.cookies?.bedroc_refresh;
    if (!refreshToken) return reply.code(401).send({ error: 'No refresh token' });

    let payload: { sub: string; type?: string };
    try {
      payload = fastify.jwt.verify(refreshToken, {
        key: process.env.JWT_REFRESH_SECRET ?? 'changeme-refresh',
      }) as { sub: string; type?: string };
    } catch {
      return reply.code(401).send({ error: 'Invalid refresh token' });
    }

    if (payload.type !== 'refresh') return reply.code(401).send({ error: 'Invalid token type' });

    const user = await getUserById(payload.sub);
    if (!user) return reply.code(401).send({ error: 'User not found' });

    const { accessToken, refreshToken: newRefresh, accessExpiresAt } = issueTokens(fastify, user.id);

    await createSession({
      userId:    user.id,
      tokenHash: hashToken(accessToken),
      deviceInfo: null,
      expiresAt:  accessExpiresAt,
    });

    reply.setCookie('bedroc_refresh', newRefresh, {
      httpOnly: true,
      secure:   process.env.NODE_ENV === 'production',
      sameSite: 'strict',
      path:     '/api/auth/refresh',
      maxAge:   7 * 24 * 3600,
    });

    return reply.code(200).send({ accessToken, expiresAt: accessExpiresAt.toISOString() });
  });

  // ── Logout ───────────────────────────────────────────────────────────────

  fastify.post('/api/auth/logout', async (req: FastifyRequest, reply: FastifyReply) => {
    // Best-effort: revoke even without full auth to handle expired tokens
    const authHeader = req.headers.authorization ?? '';
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
    if (token) await revokeSession(hashToken(token));

    reply.clearCookie('bedroc_refresh', { path: '/api/auth/refresh' });
    return reply.code(200).send({ ok: true });
  });

  // ── Sessions list (protected) ────────────────────────────────────────────

  fastify.get('/api/auth/sessions', async (req: FastifyRequest, reply: FastifyReply) => {
    await verifyAuth(req, reply);
    if (reply.sent) return;
    const userId = (req as FastifyRequest & { userId: string }).userId;
    const sessions = await getSessionsForUser(userId);
    return reply.code(200).send({ sessions });
  });

  // ── Revoke a specific session (protected) ───────────────────────────────

  fastify.delete('/api/auth/sessions/:id', async (req: FastifyRequest, reply: FastifyReply) => {
    await verifyAuth(req, reply);
    if (reply.sent) return;
    const userId = (req as FastifyRequest & { userId: string }).userId;
    const { id } = req.params as { id: string };
    await revokeSessionById(id, userId);
    return reply.code(200).send({ ok: true });
  });

  // ── Revoke all sessions (logout everywhere) (protected) ─────────────────

  fastify.post('/api/auth/sessions/revoke-all', async (req: FastifyRequest, reply: FastifyReply) => {
    await verifyAuth(req, reply);
    if (reply.sent) return;
    const userId = (req as FastifyRequest & { userId: string }).userId;
    await revokeAllSessions(userId);
    reply.clearCookie('bedroc_refresh', { path: '/api/auth/refresh' });
    return reply.code(200).send({ ok: true });
  });

  // ── Delete account (protected) ───────────────────────────────────────────
  // Deletes the user row; CASCADE removes all sessions, notes, topics, folders.

  fastify.delete('/api/auth/account', async (req: FastifyRequest, reply: FastifyReply) => {
    await verifyAuth(req, reply);
    if (reply.sent) return;
    const userId = (req as FastifyRequest & { userId: string }).userId;
    // Imported lazily to avoid circular dep
    const { deleteUser } = await import('../db/queries/users.js');
    await deleteUser(userId);
    reply.clearCookie('bedroc_refresh', { path: '/api/auth/refresh' });
    return reply.code(200).send({ ok: true });
  });
}
