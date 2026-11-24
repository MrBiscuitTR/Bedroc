/**
 * middleware/auth.ts — JWT verification + session revocation check.
 *
 * Every protected route calls `verifyAuth(request, reply)` which:
 *   1. Extracts the Bearer token from the Authorization header.
 *   2. Verifies the JWT signature with the access secret.
 *   3. Computes SHA-256(token) and checks the sessions table for revocation.
 *   4. Attaches `request.userId` and `request.sessionId` for downstream handlers.
 *
 * We do NOT use Fastify's built-in JWT decorator auto-verify because we need
 * the extra revocation check against the DB.
 */

import type { FastifyRequest, FastifyReply } from 'fastify';
import { createHash } from 'node:crypto';
import { getSessionByHash } from '../db/queries/users.js';

export type AuthedRequest = FastifyRequest & { userId: string; sessionId: string };

/**
 * Hash a raw JWT string to look up in the sessions table.
 * SHA-256 is fine here: tokens are high-entropy, so no stretching is needed.
 */
export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** Extract the raw Bearer token from the Authorization header ('' if absent). */
export function bearerToken(request: FastifyRequest): string {
  const authHeader = request.headers.authorization ?? '';
  return authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
}

/**
 * Verify the JWT on a request and check that the session has not been revoked.
 * Sends a 401 reply if auth fails (callers check `reply.sent`).
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

  const user = request.user as { sub?: string; type?: string };
  if (!user?.sub || user.type === 'refresh') {
    reply.code(401).send({ error: 'Unauthorized' });
    return;
  }

  // Check token revocation via token_hash lookup, and make sure the session
  // actually belongs to the token's subject.
  const session = await getSessionByHash(hashToken(bearerToken(request)));
  if (!session || session.revoked || session.user_id !== user.sub) {
    reply.code(401).send({ error: 'Session revoked or expired' });
    return;
  }

  (request as AuthedRequest).userId = user.sub;
  (request as AuthedRequest).sessionId = session.id;
}
