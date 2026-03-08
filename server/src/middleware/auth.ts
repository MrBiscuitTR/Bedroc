/**
 * middleware/auth.ts — JWT verification + session revocation check.
 *
 * Every protected route calls `verifyAuth(request, reply)` which:
 *   1. Extracts the Bearer token from the Authorization header.
 *   2. Verifies the JWT signature with the access secret.
 *   3. Computes SHA-256(token) and checks the sessions table for revocation.
 *   4. Attaches `request.userId` for downstream handlers.
 *
 * We do NOT use Fastify's built-in JWT decorator auto-verify because we need
 * the extra revocation check against the DB.
 */

import type { FastifyRequest, FastifyReply } from 'fastify';
import { createHash } from 'node:crypto';
import { getSessionByHash } from '../db/queries/users.js';

/**
 * Hash a raw JWT string to look up in the sessions table.
 * Uses SHA-256 (non-cryptographic purpose here — just a compact key).
 */
export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/**
 * Verify the JWT on a request and check that the session has not been revoked.
 * Throws a 401 reply if auth fails.
 */
export async function verifyAuth(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<void> {
  try {
    // Fastify-jwt attaches .jwtVerify() to the request
    await request.jwtVerify();
  } catch {
    reply.code(401).send({ error: 'Unauthorized' });
    return;
  }

  const user = request.user as { sub: string; jti: string };
  if (!user?.sub) {
    reply.code(401).send({ error: 'Unauthorized' });
    return;
  }

  // Check token revocation via token_hash lookup
  const authHeader = request.headers.authorization ?? '';
  const rawToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
  const tokenHash = hashToken(rawToken);

  const session = await getSessionByHash(tokenHash);
  if (!session || session.revoked) {
    reply.code(401).send({ error: 'Session revoked or expired' });
    return;
  }

  (request as FastifyRequest & { userId: string }).userId = user.sub;
}
