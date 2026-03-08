/**
 * db/queries/notes.ts — Typed queries for notes, topics, and folders tables.
 *
 * The server is a dumb encrypted-blob store. It never inspects the content
 * of encrypted_title or encrypted_body — those are AES-256-GCM ciphertexts.
 */

import { query } from '../client.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface NoteRow {
  id: string;
  user_id: string;
  topic_id: string | null;
  encrypted_title: string;
  encrypted_body: string;
  custom_order: number;
  client_updated_at: Date;
  server_updated_at: Date;
  created_at: Date;
  is_deleted: boolean;
  version: number;
}

export interface TopicRow {
  id: string;
  user_id: string;
  name: string;
  color: string;
  folder_id: string | null;
  sort_order: number;
  created_at: Date;
  updated_at: Date;
}

export interface FolderRow {
  id: string;
  user_id: string;
  name: string;
  parent_id: string | null;
  sort_order: number;
  collapsed: boolean;
  created_at: Date;
  updated_at: Date;
}

// ---------------------------------------------------------------------------
// Notes
// ---------------------------------------------------------------------------

export async function upsertNote(params: {
  id: string;
  userId: string;
  topicId: string | null;
  encryptedTitle: string;
  encryptedBody: string;
  customOrder: number;
  clientUpdatedAt: Date;
  version: number;
}): Promise<NoteRow> {
  // Optimistic lock: only update if incoming version >= stored version.
  // On conflict (same id), update only when the client has a newer timestamp.
  const { rows } = await query<NoteRow>(
    `INSERT INTO notes
       (id, user_id, topic_id, encrypted_title, encrypted_body,
        custom_order, client_updated_at, server_updated_at, version)
     VALUES ($1, $2, $3, $4, $5, $6, $7, now(), 1)
     ON CONFLICT (id) DO UPDATE SET
       topic_id          = EXCLUDED.topic_id,
       encrypted_title   = EXCLUDED.encrypted_title,
       encrypted_body    = EXCLUDED.encrypted_body,
       custom_order      = EXCLUDED.custom_order,
       client_updated_at = EXCLUDED.client_updated_at,
       server_updated_at = now(),
       version           = notes.version + 1,
       is_deleted        = false
     WHERE notes.client_updated_at < EXCLUDED.client_updated_at
     RETURNING *`,
    [
      params.id,
      params.userId,
      params.topicId,
      params.encryptedTitle,
      params.encryptedBody,
      params.customOrder,
      params.clientUpdatedAt,
    ]
  );
  // If WHERE clause failed (stale write), rows will be empty — fetch current
  if (rows.length === 0) {
    const existing = await getNoteById(params.id, params.userId);
    if (!existing) throw new Error('Note not found after upsert conflict');
    return existing;
  }
  return rows[0];
}

export async function getNoteById(id: string, userId: string): Promise<NoteRow | null> {
  const { rows } = await query<NoteRow>(
    'SELECT * FROM notes WHERE id = $1 AND user_id = $2',
    [id, userId]
  );
  return rows[0] ?? null;
}

export async function getNotesByUser(userId: string, includeDeleted = false): Promise<NoteRow[]> {
  const { rows } = await query<NoteRow>(
    `SELECT * FROM notes
     WHERE user_id = $1 ${includeDeleted ? '' : 'AND is_deleted = false'}
     ORDER BY client_updated_at DESC`,
    [userId]
  );
  return rows;
}

/**
 * Delta sync: return all notes changed since a given timestamp.
 * Includes soft-deleted notes so clients can remove them locally.
 */
export async function getNotesSince(userId: string, since: Date): Promise<NoteRow[]> {
  const { rows } = await query<NoteRow>(
    `SELECT * FROM notes
     WHERE user_id = $1
       AND server_updated_at > $2
     ORDER BY server_updated_at ASC`,
    [userId, since]
  );
  return rows;
}

export async function softDeleteNote(id: string, userId: string): Promise<void> {
  await query(
    `UPDATE notes
     SET is_deleted = true, server_updated_at = now(), version = version + 1
     WHERE id = $1 AND user_id = $2`,
    [id, userId]
  );
}

// ---------------------------------------------------------------------------
// Topics
// ---------------------------------------------------------------------------

export async function upsertTopic(params: {
  id: string;
  userId: string;
  name: string;
  color: string;
  folderId: string | null;
  sortOrder: number;
}): Promise<TopicRow> {
  const { rows } = await query<TopicRow>(
    `INSERT INTO topics (id, user_id, name, color, folder_id, sort_order)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (id) DO UPDATE SET
       name       = EXCLUDED.name,
       color      = EXCLUDED.color,
       folder_id  = EXCLUDED.folder_id,
       sort_order = EXCLUDED.sort_order,
       updated_at = now()
     RETURNING *`,
    [params.id, params.userId, params.name, params.color, params.folderId, params.sortOrder]
  );
  return rows[0];
}

export async function getTopicsByUser(userId: string): Promise<TopicRow[]> {
  const { rows } = await query<TopicRow>(
    'SELECT * FROM topics WHERE user_id = $1 ORDER BY sort_order ASC',
    [userId]
  );
  return rows;
}

export async function deleteTopic(id: string, userId: string): Promise<void> {
  // Unassign notes from this topic before deleting
  await query('UPDATE notes SET topic_id = NULL WHERE topic_id = $1 AND user_id = $2', [id, userId]);
  await query('DELETE FROM topics WHERE id = $1 AND user_id = $2', [id, userId]);
}

// ---------------------------------------------------------------------------
// Folders
// ---------------------------------------------------------------------------

export async function upsertFolder(params: {
  id: string;
  userId: string;
  name: string;
  parentId: string | null;
  sortOrder: number;
  collapsed: boolean;
}): Promise<FolderRow> {
  const { rows } = await query<FolderRow>(
    `INSERT INTO folders (id, user_id, name, parent_id, sort_order, collapsed)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (id) DO UPDATE SET
       name       = EXCLUDED.name,
       parent_id  = EXCLUDED.parent_id,
       sort_order = EXCLUDED.sort_order,
       collapsed  = EXCLUDED.collapsed,
       updated_at = now()
     RETURNING *`,
    [params.id, params.userId, params.name, params.parentId, params.sortOrder, params.collapsed]
  );
  return rows[0];
}

export async function getFoldersByUser(userId: string): Promise<FolderRow[]> {
  const { rows } = await query<FolderRow>(
    'SELECT * FROM folders WHERE user_id = $1 ORDER BY sort_order ASC',
    [userId]
  );
  return rows;
}

export async function deleteFolder(id: string, userId: string): Promise<void> {
  // Move child folders to this folder's parent
  const folder = (await query<FolderRow>(
    'SELECT parent_id FROM folders WHERE id = $1 AND user_id = $2', [id, userId]
  )).rows[0];
  if (folder) {
    await query(
      'UPDATE folders SET parent_id = $1 WHERE parent_id = $2 AND user_id = $3',
      [folder.parent_id, id, userId]
    );
    await query(
      'UPDATE topics SET folder_id = NULL WHERE folder_id = $1 AND user_id = $2',
      [id, userId]
    );
  }
  await query('DELETE FROM folders WHERE id = $1 AND user_id = $2', [id, userId]);
}
