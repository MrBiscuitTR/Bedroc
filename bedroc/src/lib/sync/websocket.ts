/**
 * lib/sync/websocket.ts — WebSocket client for real-time multi-device sync.
 *
 * Connects to the server's /ws endpoint using the current access token.
 * The server sends push notifications when notes are created/updated/deleted
 * on another device — this client receives them and triggers a local sync.
 *
 * Protocol (defined in server/src/routes/sync.ts):
 *   Client → Server:  { type: 'ping' }
 *   Server → Client:  { type: 'pong' }
 *                     { type: 'note:updated', noteId: string }
 *                     { type: 'note:deleted', noteId: string }
 *
 * Features:
 *   - Auto-reconnect with exponential backoff (1s → 2s → 4s → ... → 60s max)
 *   - Keepalive ping every 30s to prevent idle disconnects
 *   - Stops reconnecting after logout (call disconnect())
 *   - Safe to call connect() multiple times — closes existing socket first
 *   - Works in all browsers (native WebSocket API, no library needed)
 *   - Works in PWA / add-to-homescreen context on iOS/Android
 */

import { auth } from '$lib/stores/auth.svelte.js';
import { syncFromServer } from '$lib/stores/notes.svelte.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type ServerMessage =
  | { type: 'pong' }
  | { type: 'note:updated'; noteId: string }
  | { type: 'note:deleted'; noteId: string };

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let socket: WebSocket | null = null;
let pingInterval: ReturnType<typeof setInterval> | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let reconnectDelay = 1000;       // ms — doubles on each failure, caps at 60s
let intentionallyClosed = false; // set true on logout to stop reconnecting
let connecting = false;

const MAX_RECONNECT_DELAY = 60_000;
const PING_INTERVAL = 30_000;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Connect to the WebSocket server. Safe to call multiple times. */
export function connect(): void {
  if (connecting) return;

  const token = auth.accessToken;
  const serverUrl = auth.serverUrl;
  if (!token || !serverUrl) return;

  // Build the WebSocket URL: replace http(s) with ws(s)
  const wsBase = serverUrl.replace(/^https/, 'wss').replace(/^http/, 'ws');
  const wsUrl = `${wsBase}/ws?token=${encodeURIComponent(token)}`;

  intentionallyClosed = false;
  _open(wsUrl);
}

/** Disconnect and stop all reconnect attempts. Call on logout. */
export function disconnect(): void {
  intentionallyClosed = true;
  _clearTimers();
  if (socket) {
    socket.onclose = null; // prevent reconnect handler from firing
    socket.close(1000, 'logout');
    socket = null;
  }
  connecting = false;
  reconnectDelay = 1000;
}

// ---------------------------------------------------------------------------
// Internal
// ---------------------------------------------------------------------------

function _open(wsUrl: string): void {
  connecting = true;

  // Close any existing socket cleanly before opening a new one
  if (socket && socket.readyState < WebSocket.CLOSING) {
    socket.onclose = null;
    socket.close(1000, 'reconnect');
  }

  try {
    socket = new WebSocket(wsUrl);
  } catch {
    // WebSocket constructor can throw on invalid URLs
    connecting = false;
    _scheduleReconnect(wsUrl);
    return;
  }

  socket.onopen = () => {
    connecting = false;
    reconnectDelay = 1000; // reset backoff on successful connect
    _startPing();
  };

  socket.onmessage = (event: MessageEvent) => {
    let msg: ServerMessage;
    try {
      msg = JSON.parse(event.data as string) as ServerMessage;
    } catch {
      return;
    }
    _handleMessage(msg);
  };

  socket.onerror = () => {
    // onerror is always followed by onclose — let onclose handle reconnect
  };

  socket.onclose = () => {
    connecting = false;
    _clearPing();
    if (!intentionallyClosed) {
      _scheduleReconnect(wsUrl);
    }
    socket = null;
  };
}

function _handleMessage(msg: ServerMessage): void {
  switch (msg.type) {
    case 'note:updated':
      // Another device created or updated a note — pull from server
      // We use full syncFromServer() rather than a single-note fetch so that
      // topic/folder changes are also picked up.
      syncFromServer().catch(() => {});
      break;

    case 'note:deleted':
      // Another device deleted a note — mirror locally without a full sync
      syncFromServer().catch(() => {});
      break;

    case 'pong':
      // Keepalive acknowledged — nothing to do
      break;
  }
}

function _startPing(): void {
  _clearPing();
  pingInterval = setInterval(() => {
    if (socket?.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ type: 'ping' }));
    }
  }, PING_INTERVAL);
}

function _clearPing(): void {
  if (pingInterval !== null) {
    clearInterval(pingInterval);
    pingInterval = null;
  }
}

function _scheduleReconnect(wsUrl: string): void {
  if (intentionallyClosed) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    if (!intentionallyClosed) _open(wsUrl);
  }, reconnectDelay);
  reconnectDelay = Math.min(reconnectDelay * 2, MAX_RECONNECT_DELAY);
}

function _clearTimers(): void {
  _clearPing();
  if (reconnectTimer !== null) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
}
