/**
 * plugins/accessLog.ts — Server-side access log for public deployments.
 *
 * Only active when ENABLE_ACCESS_LOG=true is set in the environment.
 * Intended for the public VPS deployment (bedrocapi.cagancalidag.com) where the server
 * owner wants an audit trail of which IPs are logging in and when.
 *
 * NOT enabled by default — WireGuard/private self-hosted deployments have no
 * reason to log IPs since all traffic comes through the VPN.
 *
 * Log format (one line per event):
 *   [2025-06-14T18:42:01.234Z] login    alice         203.0.113.42
 *   [2025-06-14T18:42:05.991Z] register bob           198.51.100.7
 *
 * Log file:
 *   ./logs/access.log  (relative to the CWD of the Node process, i.e. /app)
 *
 * Privacy:
 *   - Logs usernames and IPs — this is the server owner's data, not user data.
 *   - Notes are E2E encrypted; this log only records authentication events.
 *   - Mount the log directory as a Docker volume to persist across container
 *     restarts and to make logs readable on the host.
 *   - Rotate with logrotate or delete old files as needed — there is no
 *     automatic rotation here to keep the plugin dependency-free.
 */

import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ENABLED = process.env.ENABLE_ACCESS_LOG === 'true';

// Resolve log path relative to project root (two levels up from dist/plugins/).
// In Docker the CWD is /app so this resolves to /app/logs/access.log.
const LOG_DIR  = join(process.cwd(), 'logs');
const LOG_FILE = join(LOG_DIR, 'access.log');

if (ENABLED) {
  try {
    mkdirSync(LOG_DIR, { recursive: true });
  } catch {
    // Directory already exists — fine.
  }
}

/**
 * Append one line to logs/access.log.
 *
 * @param event     'login' | 'register'
 * @param username  The authenticated username
 * @param ip        Client IP (may be null if not determinable)
 */
export function writeAccessLog(
  event: 'login' | 'register',
  username: string,
  ip: string | null
): void {
  if (!ENABLED) return;

  const ts      = new Date().toISOString();
  const ipField = ip ?? 'unknown';
  // Pad fields for readability in a plain-text tail
  const line = `[${ts}] ${event.padEnd(8)} ${username.padEnd(24)} ${ipField}\n`;

  try {
    appendFileSync(LOG_FILE, line, 'utf8');
  } catch (err) {
    // Non-fatal — log to stderr but don't crash the server
    console.error('[accessLog] Failed to write access log:', (err as Error).message);
  }
}
