/**
 * db/queries/users.ts — Typed queries for the users and sessions tables.
 *
 * All password-equivalent material (srp_verifier, encrypted_dek) is stored
 * only as hex-encoded bytes or JSON — never as plain text.
 */

import { query } from '../client.js';

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
  created_at: Date;
}

export interface SessionRow {
  id: string;
  user_id: string;
  token_hash: string;
  refresh_token_hash: string | null;
  device_info: string | null;
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
}): Promise<UserRow> {
  const { rows } = await query<UserRow>(
    `INSERT INTO users (username, srp_salt, srp_verifier, encrypted_dek, dek_salt)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING *`,
    [params.username, params.srpSalt, params.srpVerifier, params.encryptedDek, params.dekSalt]
  );
  return rows[0];
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

export async function updateUserCredentials(params: {
  id: string;
  srpSalt: Buffer;
  srpVerifier: Buffer;
  encryptedDek: string;
  dekSalt: Buffer;
}): Promise<void> {
  await query(
    `UPDATE users
     SET srp_salt = $2, srp_verifier = $3, encrypted_dek = $4, dek_salt = $5
     WHERE id = $1`,
    [params.id, params.srpSalt, params.srpVerifier, params.encryptedDek, params.dekSalt]
  );
}

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

export async function createSession(params: {
  userId: string;
  tokenHash: string;
  refreshTokenHash: string;
  deviceInfo: string | null;
  expiresAt: Date;
}): Promise<SessionRow> {
  const { rows } = await query<SessionRow>(
    `INSERT INTO sessions (user_id, token_hash, refresh_token_hash, device_info, expires_at)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING *`,
    [params.userId, params.tokenHash, params.refreshTokenHash, params.deviceInfo, params.expiresAt]
  );
  return rows[0];
}

/**
 * Upsert a session by device label: if an active session already exists for
 * this user+device_info, replace its tokens in-place. Otherwise insert fresh.
 * Also deletes expired/revoked sessions for the user as part of the same op.
 * This ensures one active session per device label.
 */
export async function upsertSessionForDevice(params: {
  userId: string;
  tokenHash: string;
  refreshTokenHash: string;
  deviceInfo: string | null;
  expiresAt: Date;
}): Promise<SessionRow> {
  // First, prune expired/revoked sessions for this user
  await pruneExpiredSessions(params.userId);

  // If we have a device label, replace any existing session for that device
  if (params.deviceInfo) {
    const { rowCount, rows } = await query<SessionRow>(
      `UPDATE sessions
       SET token_hash = $3, refresh_token_hash = $4, expires_at = $5,
           revoked = false, created_at = now()
       WHERE user_id = $1 AND device_info = $2 AND revoked = false
       RETURNING *`,
      [params.userId, params.deviceInfo, params.tokenHash, params.refreshTokenHash, params.expiresAt]
    );
    if ((rowCount ?? 0) > 0) return rows[0];
  }

  // No existing session for this device — create a new one
  return createSession(params);
}

/**
 * Update an existing session's access token hash when the token is refreshed.
 * Returns false if no active session was found for the given refresh token hash.
 */
export async function refreshSession(params: {
  refreshTokenHash: string;
  newTokenHash: string;
  newRefreshTokenHash: string;
  newExpiresAt: Date;
}): Promise<boolean> {
  const { rowCount } = await query(
    `UPDATE sessions
     SET token_hash = $2, refresh_token_hash = $3, expires_at = $4
     WHERE refresh_token_hash = $1
       AND revoked = false
       AND expires_at > now()`,
    [params.refreshTokenHash, params.newTokenHash, params.newRefreshTokenHash, params.newExpiresAt]
  );
  return (rowCount ?? 0) > 0;
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

export async function revokeSession(tokenHash: string): Promise<void> {
  await query('UPDATE sessions SET revoked = true WHERE token_hash = $1', [tokenHash]);
}

export async function revokeAllSessions(userId: string): Promise<void> {
  await query('UPDATE sessions SET revoked = true WHERE user_id = $1', [userId]);
}

export async function getSessionsForUser(userId: string): Promise<SessionRow[]> {
  const { rows } = await query<SessionRow>(
    `SELECT id, user_id, device_info, created_at, expires_at, revoked
     FROM sessions
     WHERE user_id = $1
       AND revoked = false
       AND expires_at > now()
     ORDER BY created_at DESC
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
