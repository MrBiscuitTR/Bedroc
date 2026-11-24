/**
 * db/queries/users.ts — Typed queries for the users and sessions tables.
 *
 * All password-equivalent material (srp_verifier, encrypted_dek) is stored
 * only as hex-encoded bytes or JSON — never as plain text.
 */

import { query, withTransaction } from '../client.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface UserRow {
  id: string;
  username: string;
  srp_salt: Buffer;
  srp_verifier: Buffer;
  encrypted_dek: string;   // JSON { iv, ct } — AES-256-GCM wrapped DEK
  dek_salt: Buffer;
  srp_kdf_version: number; // 1 = legacy SHA-256 x, 2 = PBKDF2 x
  created_at: Date;
}

export interface SessionRow {
  id: string;
  user_id: string;
  token_hash: string;
  refresh_token_hash: string | null;
  device_info: string | null;
  login_ip: string | null;
  last_used_at: Date | null;
  created_at: Date;
  expires_at: Date;
  revoked: boolean;
}

// ---------------------------------------------------------------------------
// Users
// ---------------------------------------------------------------------------

export async function createUser(params: {
  username: string;
  srpSalt: Buffer;
  srpVerifier: Buffer;
  encryptedDek: string;
  dekSalt: Buffer;
  srpKdfVersion: number;
}): Promise<UserRow> {
  const { rows } = await query<UserRow>(
    `INSERT INTO users (username, srp_salt, srp_verifier, encrypted_dek, dek_salt, srp_kdf_version)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING *`,
    [params.username, params.srpSalt, params.srpVerifier, params.encryptedDek, params.dekSalt, params.srpKdfVersion]
  );
  return rows[0];
}

/** Case-insensitive existence check — prevents look-alike accounts (Alice vs alice). */
export async function usernameTakenCaseInsensitive(username: string): Promise<boolean> {
  const { rows } = await query<{ one: number }>(
    'SELECT 1 AS one FROM users WHERE lower(username) = lower($1) LIMIT 1',
    [username]
  );
  return rows.length > 0;
}

export async function getUserByUsername(username: string): Promise<UserRow | null> {
  const { rows } = await query<UserRow>(
    'SELECT * FROM users WHERE username = $1',
    [username]
  );
  return rows[0] ?? null;
}

export async function getUserById(id: string): Promise<UserRow | null> {
  const { rows } = await query<UserRow>(
    'SELECT * FROM users WHERE id = $1',
    [id]
  );
  return rows[0] ?? null;
}

export async function deleteUser(id: string): Promise<void> {
  await query('DELETE FROM users WHERE id = $1', [id]);
}

/**
 * Replace all password-derived material and revoke every session except
 * `keepSessionId`, atomically. Used by change-password.
 */
export async function updateUserCredentials(params: {
  id: string;
  srpSalt: Buffer;
  srpVerifier: Buffer;
  encryptedDek: string;
  dekSalt: Buffer;
  srpKdfVersion: number;
  keepSessionId: string | null;
}): Promise<void> {
  await withTransaction(async (c) => {
    await c.query(
      `UPDATE users
       SET srp_salt = $2, srp_verifier = $3, encrypted_dek = $4, dek_salt = $5, srp_kdf_version = $6
       WHERE id = $1`,
      [params.id, params.srpSalt, params.srpVerifier, params.encryptedDek, params.dekSalt, params.srpKdfVersion]
    );
    await c.query(
      'DELETE FROM sessions WHERE user_id = $1 AND ($2::uuid IS NULL OR id <> $2::uuid)',
      [params.id, params.keepSessionId]
    );
  });
}

/**
 * Upgrade a legacy (v1) SRP verifier to v2. Only applies while the row is
 * still v1, so a replayed upgrade can never overwrite a v2 row.
 */
export async function upgradeSrpVerifier(params: {
  id: string;
  srpSalt: Buffer;
  srpVerifier: Buffer;
}): Promise<boolean> {
  const { rowCount } = await query(
    `UPDATE users SET srp_salt = $2, srp_verifier = $3, srp_kdf_version = 2
     WHERE id = $1 AND srp_kdf_version = 1`,
    [params.id, params.srpSalt, params.srpVerifier]
  );
  return (rowCount ?? 0) > 0;
}

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

export async function createSession(params: {
  userId: string;
  tokenHash: string;
  refreshTokenHash: string;
  deviceInfo: string | null;
  loginIp: string | null;
  expiresAt: Date;
}): Promise<SessionRow> {
  const { rows } = await query<SessionRow>(
    `INSERT INTO sessions (user_id, token_hash, refresh_token_hash, device_info, login_ip, last_used_at, expires_at)
     VALUES ($1, $2, $3, $4, $5, now(), $6)
     RETURNING *`,
    [params.userId, params.tokenHash, params.refreshTokenHash, params.deviceInfo, params.loginIp, params.expiresAt]
  );
  return rows[0];
}

/** Upper bound on concurrent sessions per user; the least recently used are dropped. */
const MAX_SESSIONS_PER_USER = 25;

/**
 * Create a session for a fresh login/registration.
 *
 * Each login gets its own row (two machines with the same browser+OS must not
 * evict each other). Expired/revoked rows are pruned, and the total per user is
 * capped so abandoned sessions (cleared cookies) cannot accumulate forever.
 */
export async function upsertSessionForDevice(params: {
  userId: string;
  tokenHash: string;
  refreshTokenHash: string;
  deviceInfo: string | null;
  loginIp: string | null;
  expiresAt: Date;
}): Promise<SessionRow> {
  await pruneExpiredSessions(params.userId);
  const row = await createSession(params);
  await query(
    `DELETE FROM sessions WHERE user_id = $1 AND id NOT IN (
       SELECT id FROM sessions WHERE user_id = $1
       ORDER BY last_used_at DESC NULLS LAST, created_at DESC
       LIMIT $2)`,
    [params.userId, MAX_SESSIONS_PER_USER]
  );
  return row;
}

/**
 * Rotate a session's tokens given its CURRENT refresh-token hash.
 * Returns the session id, or null if no active session holds that hash.
 * The old hash is kept in prev_refresh_token_hash for replay detection.
 */
export async function refreshSession(params: {
  userId: string;
  refreshTokenHash: string;
  newTokenHash: string;
  newRefreshTokenHash: string;
  newExpiresAt: Date;
}): Promise<string | null> {
  const { rows } = await query<{ id: string }>(
    `UPDATE sessions
     SET prev_refresh_token_hash = refresh_token_hash,
         refresh_rotated_at      = now(),
         token_hash              = $3,
         refresh_token_hash      = $4,
         expires_at              = $5,
         last_used_at            = now()
     WHERE refresh_token_hash = $2
       AND user_id = $1
       AND revoked = false
       AND expires_at > now()
     RETURNING id`,
    [params.userId, params.refreshTokenHash, params.newTokenHash, params.newRefreshTokenHash, params.newExpiresAt]
  );
  return rows[0]?.id ?? null;
}

/**
 * Find a session whose PREVIOUS refresh token matches (the presented token was
 * already rotated). `inGrace` is true if that rotation happened very recently.
 */
export async function findSessionByPrevRefreshHash(
  userId: string,
  refreshTokenHash: string,
  graceSeconds: number
): Promise<{ id: string; inGrace: boolean } | null> {
  const { rows } = await query<{ id: string; in_grace: boolean }>(
    `SELECT id, (refresh_rotated_at > now() - make_interval(secs => $3)) AS in_grace
     FROM sessions
     WHERE prev_refresh_token_hash = $2 AND user_id = $1 AND revoked = false`,
    [userId, refreshTokenHash, graceSeconds]
  );
  return rows[0] ? { id: rows[0].id, inGrace: rows[0].in_grace === true } : null;
}

export async function deleteSessionById(id: string): Promise<void> {
  await query('DELETE FROM sessions WHERE id = $1', [id]);
}

export async function revokeSessionByRefreshHash(refreshTokenHash: string): Promise<void> {
  await query('DELETE FROM sessions WHERE refresh_token_hash = $1', [refreshTokenHash]);
}

export async function getSessionByHash(tokenHash: string): Promise<SessionRow | null> {
  const { rows } = await query<SessionRow>(
    `SELECT * FROM sessions
     WHERE token_hash = $1
       AND revoked = false
       AND expires_at > now()`,
    [tokenHash]
  );
  return rows[0] ?? null;
}

/** True if the session with this id is still active. Used to re-validate WebSockets. */
export async function isSessionActive(sessionId: string): Promise<boolean> {
  const { rows } = await query<{ one: number }>(
    'SELECT 1 AS one FROM sessions WHERE id = $1 AND revoked = false AND expires_at > now()',
    [sessionId]
  );
  return rows.length > 0;
}

export async function revokeSession(tokenHash: string): Promise<void> {
  await query('DELETE FROM sessions WHERE token_hash = $1', [tokenHash]);
}

export async function revokeAllSessions(userId: string): Promise<void> {
  await query('DELETE FROM sessions WHERE user_id = $1', [userId]);
}

export async function getSessionsForUser(userId: string): Promise<SessionRow[]> {
  const { rows } = await query<SessionRow>(
    `SELECT id, user_id, device_info, login_ip, last_used_at, created_at, expires_at, revoked
     FROM sessions
     WHERE user_id = $1
       AND revoked = false
       AND expires_at > now()
     ORDER BY last_used_at DESC NULLS LAST, created_at DESC
     LIMIT 20`,
    [userId]
  );
  return rows;
}

export async function revokeSessionById(sessionId: string, userId: string): Promise<void> {
  // Delete immediately rather than mark revoked — the UI filters by active sessions
  // and we don't need to keep the row for any other purpose.
  await query(
    'DELETE FROM sessions WHERE id = $1 AND user_id = $2',
    [sessionId, userId]
  );
}

export async function pruneExpiredSessions(userId: string): Promise<void> {
  await query(
    'DELETE FROM sessions WHERE user_id = $1 AND (revoked = true OR expires_at < now())',
    [userId]
  );
}
