/**
 * db/queries/attachments.ts — Typed queries for the attachments table.
 *
 * Attachments are content-addressed by SHA-256(plaintext data URI).
 * The server stores only AES-256-GCM ciphertext — never plaintext.
 */

import { query } from '../client.js';

export interface AttachmentRow {
  hash: string;
  user_id: string;
  encrypted_data: string;
  mime_type: string;
  size_bytes: number;
  created_at: Date;
}

/**
 * Upsert an attachment. Idempotent — same (hash, user_id) pair is a no-op
 * on conflict, so uploading the same file twice is safe.
 */
export async function upsertAttachment(params: {
  hash: string;
  userId: string;
  encryptedData: string;
  mimeType: string;
  sizeBytes: number;
}): Promise<void> {
  await query(
    `INSERT INTO attachments (hash, user_id, encrypted_data, mime_type, size_bytes)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (hash, user_id) DO NOTHING`,
    [params.hash, params.userId, params.encryptedData, params.mimeType, params.sizeBytes]
  );
}

/**
 * Fetch a single attachment by hash for a given user.
 * Returns null if not found or belongs to a different user.
 */
export async function getAttachment(
  hash: string,
  userId: string
): Promise<AttachmentRow | null> {
  const { rows } = await query<AttachmentRow>(
    'SELECT * FROM attachments WHERE hash = $1 AND user_id = $2',
    [hash, userId]
  );
  return rows[0] ?? null;
}

/**
 * Fetch multiple attachments by hash list for a given user.
 * Returns only those that exist; missing hashes are silently omitted.
 */
export async function getAttachmentsByHashes(
  hashes: string[],
  userId: string
): Promise<AttachmentRow[]> {
  if (hashes.length === 0) return [];
  const { rows } = await query<AttachmentRow>(
    `SELECT * FROM attachments WHERE user_id = $1 AND hash = ANY($2)`,
    [userId, hashes]
  );
  return rows;
}

/**
 * Check which of the given hashes already exist for a user.
 * Used by the client to skip re-uploading known attachments.
 */
export async function getExistingHashes(
  hashes: string[],
  userId: string
): Promise<string[]> {
  if (hashes.length === 0) return [];
  const { rows } = await query<{ hash: string }>(
    `SELECT hash FROM attachments WHERE user_id = $1 AND hash = ANY($2)`,
    [userId, hashes]
  );
  return rows.map((r) => r.hash);
}

/**
 * Delete an attachment. Called when the user explicitly removes a file
 * from their notes (all references to that hash are gone).
 */
export async function deleteAttachment(
  hash: string,
  userId: string
): Promise<void> {
  await query(
    'DELETE FROM attachments WHERE hash = $1 AND user_id = $2',
    [hash, userId]
  );
}

/**
 * Delete all attachments for a user — called on account deletion.
 */
export async function deleteAllAttachments(userId: string): Promise<void> {
  await query('DELETE FROM attachments WHERE user_id = $1', [userId]);
}
