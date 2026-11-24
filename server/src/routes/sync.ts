/**
 * routes/sync.ts — WebSocket real-time sync.
 *
 * Each authenticated WebSocket connection is tracked in a per-user set.
 * When any note is saved/deleted via REST, `notifyClients(userId, msg)` fans
 * out the event to all other connections for that user (multi-device sync).
 *
 * Message protocol (all JSON):
 *   Server → Client:
 *     { type: 'note:updated', noteId: string }
 *     { type: 'note:deleted', noteId: string }
 *     { type: 'pong' }
 *     { type: 'auth:ok' }
 *   Client → Server:
 *     { type: 'auth', token: string }
 *     { type: 'ping' }
 *
 * Authentication: after connecting to wss://host/ws the client must send
 *   { type: 'auth', token: <access_token> }
 * within 10 s; the server replies { type: 'auth:ok' } or closes with 4001.
 * (The token is NOT put in the URL, so it never lands in proxy access logs.)
 * The session is re-validated every 60 s; revoked sessions are disconnected.
 */

import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { WebSocket } from 'ws';
import { verifyAuth, type AuthedRequest } from '../middleware/auth.js';
import { isSessionActive } from '../db/queries/users.js';

// ---------------------------------------------------------------------------
// In-process connection registry  (userId → Set<WebSocket>)
// ---------------------------------------------------------------------------
// For a multi-instance deployment, replace this with Redis pub/sub:
//   - On notifyClients(), PUBLISH to a Redis channel for that userId.
//   - Each server instance SUBSCRIBES to all user channels for its connected clients.

const connections = new Map<string, Set<WebSocket>>();

function register(userId: string, ws: WebSocket): void {
  if (!connections.has(userId)) connections.set(userId, new Set());
  connections.get(userId)!.add(ws);
}

function unregister(userId: string, ws: WebSocket): void {
  const set = connections.get(userId);
  if (!set) return;
  set.delete(ws);
  if (set.size === 0) connections.delete(userId);
}

/**
 * Notify all *other* WebSocket connections for a given user of a note change.
 * Used by REST note handlers after a successful save/delete.
 */
export async function notifyClients(
  userId: string,
  message: { type: string; noteId: string }
): Promise<void> {
  const set = connections.get(userId);
  if (!set) return;
  const json = JSON.stringify(message);
  for (const ws of set) {
    if (ws.readyState === 1 /* OPEN */) {
      ws.send(json);
    }
  }
}

// ---------------------------------------------------------------------------
// WebSocket route plugin
// ---------------------------------------------------------------------------

const AUTH_TIMEOUT_MS       = 10_000;   // client must authenticate within this time
const REVALIDATE_MS         = 60_000;   // re-check the session is still live
const MAX_SOCKETS_PER_USER  = 20;

export default async function syncRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.get('/ws', { websocket: true }, async (socket: WebSocket, req: FastifyRequest) => {
    let userId: string | null = null;
    let sessionId: string | null = null;
    let revalidateTimer: ReturnType<typeof setInterval> | null = null;
    let pendingAuth: Promise<boolean> | null = null;   // legacy ?token= auth in flight

    const authTimer = setTimeout(() => {
      if (!userId) socket.close(4001, 'Authentication timeout');
    }, AUTH_TIMEOUT_MS);

    const cleanup = () => {
      if (revalidateTimer) clearInterval(revalidateTimer);
      clearTimeout(authTimer);
      if (userId) unregister(userId, socket);
    };

    /** Verify an access token and, on success, register the socket. */
    async function authenticate(token: string): Promise<boolean> {
      (req.headers as Record<string, string>).authorization = `Bearer ${token}`;
      let authed = true;
      const fakeReply = {
        code: () => fakeReply,
        send: () => { authed = false; },
        sent: false,
      } as unknown as import('fastify').FastifyReply;
      await verifyAuth(req, fakeReply);
      delete (req.headers as Record<string, string>).authorization;
      if (!authed) return false;

      const uid = (req as AuthedRequest).userId;
      if ((connections.get(uid)?.size ?? 0) >= MAX_SOCKETS_PER_USER) {
        socket.close(4008, 'Too many connections');
        return false;
      }
      userId = uid;
      sessionId = (req as AuthedRequest).sessionId;
      register(uid, socket);
      clearTimeout(authTimer);

      // A revoked session (logout elsewhere, "revoke", password change) must
      // stop receiving events even though the socket outlives the token.
      revalidateTimer = setInterval(async () => {
        if (!sessionId || !(await isSessionActive(sessionId).catch(() => false))) {
          socket.close(4001, 'Session revoked');
        }
      }, REVALIDATE_MS);
      return true;
    }

    socket.on('close', cleanup);
    socket.on('error', cleanup);

    socket.on('message', async (raw: Buffer | string) => {
      let msg: { type?: string; token?: string };
      try {
        msg = JSON.parse(raw.toString()) as { type?: string; token?: string };
      } catch {
        return; // ignore malformed messages
      }

      // Messages that arrive while a legacy URL-token check is still running
      // must wait for it instead of being treated as unauthenticated.
      if (!userId && pendingAuth) await pendingAuth;

      if (!userId) {
        // Only an auth message is accepted before authentication.
        if (msg.type !== 'auth' || typeof msg.token !== 'string' || msg.token.length > 4096) {
          socket.close(4001, 'Unauthorized');
          return;
        }
        if (await authenticate(msg.token)) {
          socket.send(JSON.stringify({ type: 'auth:ok' }));
        } else if (socket.readyState === 1) {
          socket.close(4001, 'Unauthorized');
        }
        return;
      }

      if (msg.type === 'ping') {
        socket.send(JSON.stringify({ type: 'pong' }));
      }
    });

    // Legacy clients put the token in the URL (?token=…). Still accepted for
    // backward compatibility, but new clients authenticate with a first
    // message so the token never appears in proxy access logs.
    const legacyToken = (req.query as Record<string, string>).token;
    if (legacyToken) {
      pendingAuth = authenticate(legacyToken);
      if (!(await pendingAuth) && socket.readyState === 1) {
        socket.close(4001, 'Unauthorized');
      }
      pendingAuth = null;
    }
  });
}
