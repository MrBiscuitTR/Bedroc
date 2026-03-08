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

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

export async function createSession(params: {
  userId: string;
  tokenHash: string;
  deviceInfo: string | null;
  expiresAt: Date;
}): Promise<SessionRow> {
  const { rows } = await query<SessionRow>(
    `INSERT INTO sessions (user_id, token_hash, device_info, expires_at)
     VALUES ($1, $2, $3, $4)
     RETURNING *`,
    [params.userId, params.tokenHash, params.deviceInfo, params.expiresAt]
  );
  return rows[0];
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
     ORDER BY created_at DESC
     LIMIT 20`,
    [userId]
  );
  return rows;
}

export async function revokeSessionById(sessionId: string, userId: string): Promise<void> {
  await query(
    'UPDATE sessions SET revoked = true WHERE id = $1 AND user_id = $2',
    [sessionId, userId]
  );
}
