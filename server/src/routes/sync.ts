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
 *   Client → Server:
 *     { type: 'ping' }
 *
 * Authentication: client sends the access JWT in the `Authorization` query
 * parameter on the WebSocket handshake URL, e.g.:
 *   wss://host/ws?token=<access_token>
 *
 * The token is verified before the connection is accepted.
 */

import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { WebSocket } from 'ws';
import { verifyAuth } from '../middleware/auth.js';

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

export default async function syncRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.get('/ws', { websocket: true }, async (socket: WebSocket, req: FastifyRequest) => {
    // Extract token from query param (WebSocket handshake cannot send headers in browser)
    const token = (req.query as Record<string, string>).token;
    if (!token) {
      socket.close(4001, 'Missing token');
      return;
    }

    // Temporarily set the Authorization header for verifyAuth reuse
    (req.headers as Record<string, string>).authorization = `Bearer ${token}`;

    // Fake reply object to detect auth failure
    let authed = true;
    const fakeReply = {
      code: () => fakeReply,
      send: () => { authed = false; },
      sent: false,
    } as unknown as import('fastify').FastifyReply;

    await verifyAuth(req, fakeReply);
    if (!authed) {
      socket.close(4001, 'Unauthorized');
      return;
    }

    const userId = (req as FastifyRequest & { userId: string }).userId;
    register(userId, socket);

    socket.on('message', (raw: Buffer | string) => {
      try {
        const msg = JSON.parse(raw.toString()) as { type: string };
        if (msg.type === 'ping') {
          socket.send(JSON.stringify({ type: 'pong' }));
        }
      } catch {
        // ignore malformed messages
      }
    });

    socket.on('close', () => {
      unregister(userId, socket);
    });

    socket.on('error', () => {
      unregister(userId, socket);
    });
  });
}
