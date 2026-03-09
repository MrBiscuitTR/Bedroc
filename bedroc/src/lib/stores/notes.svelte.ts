/**
 * notes.svelte.ts — Offline-first note, topic, and folder store.
 *
 * Architecture:
 *   Primary store: IndexedDB (all reads/writes hit IndexedDB first)
 *   Secondary store: Server (sync target; notes encrypted before leaving device)
 *
 * Write path:
 *   1. Encrypt title + body with DEK (AES-256-GCM)
 *   2. Write plaintext to IndexedDB (local, client-only)
 *   3. Enqueue encrypted payload to syncQueue in IndexedDB
 *   4. Mark note as `synced: false` in IndexedDB
 *   5. Attempt server PUT (if online)
 *   6. On success → mark `synced: true`, dequeue
 *   7. On failure → leave in syncQueue; retried by flushSyncQueue()
 *
 * Read path:
 *   1. Load from IndexedDB (instant, works offline)
 *   2. On mount, trigger delta sync from server (getNotesSince last sync)
 *   3. Decrypt incoming server notes, merge into IndexedDB and reactive maps
 *
 * Reactive maps (SvelteMap) provide granular DOM reactivity.
 * All async operations update maps after completion.
 */

import { SvelteMap } from 'svelte/reactivity';
import { auth, apiFetch } from './auth.svelte.js';
import { encryptNote, decryptNote } from '$lib/crypto/encrypt.js';
import {
  saveNote as idbSaveNote,
  getNoteById as idbGetNoteById,
  getNotesByUser,
  getNotesByTopic as idbGetNotesByTopic,
  markNoteDeleted as idbMarkDeleted,
  saveTopic as idbSaveTopic,
  getTopicsByUser,
  deleteTopic as idbDeleteTopic,
  saveFolder as idbSaveFolder,
  getFoldersByUser,
  deleteFolder as idbDeleteFolder,
  enqueueSyncItem,
  dequeueSyncItem,
  getAllSyncQueue,
  incrementRetry,
  saveConflict,
  deleteConflict,
  getConflictsByUser,
  type NoteLocal,
  type TopicLocal,
  type FolderLocal,
  type SyncQueueItem,
  type ConflictRecord,
} from '$lib/db/indexeddb.js';

// ---------------------------------------------------------------------------
// Re-export types used by UI components (maintain same interface shape)
// ---------------------------------------------------------------------------

export interface Note {
  id: string;
  title: string;
  body: string;
  topicId: string | null;
  createdAt: number;
  updatedAt: number;
  customOrder: number;
}

export interface Topic {
  id: string;
  name: string;
  color: string;
  folderId: string | null;
  order: number;
}

export interface Folder {
  id: string;
  name: string;
  parentId: string | null;
  order: number;
  collapsed: boolean;
}

export type SortMode = 'recent' | 'alpha' | 'custom';

// ---------------------------------------------------------------------------
// Reactive maps
// ---------------------------------------------------------------------------

export const notesMap = new SvelteMap<string, Note>();
export const topicsMap = new SvelteMap<string, Topic>();
export const foldersMap = new SvelteMap<string, Folder>();

let _syncing = $state(false);
export const syncState = { get syncing() { return _syncing; } };

// ---------------------------------------------------------------------------
// Conflicts reactive map
// ---------------------------------------------------------------------------

export const conflictsMap = new SvelteMap<string, ConflictRecord>();

export { type ConflictRecord };

// ---------------------------------------------------------------------------
// Sort mode (localStorage — user pref, not encrypted)
// ---------------------------------------------------------------------------

function readSortMode(): SortMode {
  if (typeof localStorage === 'undefined') return 'recent';
  const raw = localStorage.getItem('bedroc_sort_mode');
  if (raw === 'alpha' || raw === 'custom' || raw === 'recent') return raw;
  return 'recent';
}

class SortModeStore {
  value = $state<SortMode>(readSortMode());
  set(mode: SortMode) {
    this.value = mode;
    if (typeof localStorage !== 'undefined') localStorage.setItem('bedroc_sort_mode', mode);
  }
}
export const sortModeStore = new SortModeStore();

// ---------------------------------------------------------------------------
// Autosave (localStorage — user pref)
// ---------------------------------------------------------------------------

function readAutosaveInterval(): number {
  if (typeof localStorage === 'undefined') return 1000;
  const raw = localStorage.getItem('bedroc_autosave_ms');
  const parsed = raw ? parseInt(raw, 10) : NaN;
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 1000;
}

class AutosaveStore {
  interval = $state(readAutosaveInterval());
  set(ms: number) {
    this.interval = ms;
    if (typeof localStorage !== 'undefined') localStorage.setItem('bedroc_autosave_ms', String(ms));
  }
}
export const autosave = new AutosaveStore();

// ---------------------------------------------------------------------------
// Load from IndexedDB on login
// ---------------------------------------------------------------------------

/** Load all data from IndexedDB into reactive maps. Call once after login. */
export async function loadFromDb(): Promise<void> {
  const userId = auth.userId;
  if (!userId) return;

  const [notes, topics, folders, conflicts] = await Promise.all([
    getNotesByUser(userId),
    getTopicsByUser(userId),
    getFoldersByUser(userId),
    getConflictsByUser(userId),
  ]);

  notesMap.clear();
  topicsMap.clear();
  foldersMap.clear();
  conflictsMap.clear();

  for (const n of notes) {
    notesMap.set(n.id, localToNote(n));
  }
  for (const t of topics) {
    topicsMap.set(t.id, localToTopic(t));
  }
  for (const f of folders) {
    foldersMap.set(f.id, localToFolder(f));
  }
  for (const c of conflicts) {
    conflictsMap.set(c.noteId, c);
  }
}

/** Clear reactive maps on logout. */
export function clearStore(): void {
  notesMap.clear();
  topicsMap.clear();
  foldersMap.clear();
  conflictsMap.clear();
}

// ---------------------------------------------------------------------------
// Delta sync from server
// ---------------------------------------------------------------------------

/** Key in localStorage tracking last successful sync timestamp. */
const LAST_SYNC_KEY = 'bedroc_last_sync';

function getLastSync(): string {
  if (typeof localStorage === 'undefined') return new Date(0).toISOString();
  return localStorage.getItem(LAST_SYNC_KEY) ?? new Date(0).toISOString();
}

function setLastSync(iso: string): void {
  if (typeof localStorage !== 'undefined') localStorage.setItem(LAST_SYNC_KEY, iso);
}

/**
 * Pull changes from the server since last sync, decrypt and merge locally.
 * Safe to call at any time; skips if no DEK is available.
 *
 * Conflict detection:
 *   A conflict occurs when ALL of:
 *     1. The server has a version newer than what the local copy last saw
 *     2. The local copy has unsynced edits (synced: false)
 *     3. The local copy was edited after its last known server update
 *
 *   When detected: both versions are saved to the `conflicts` store.
 *   The local (unsynced) note is NEVER overwritten — user must resolve.
 *
 *   Fast-forward (no conflict): server version is accepted and local is updated.
 */
export async function syncFromServer(): Promise<void> {
  const dek = auth.dek;
  const userId = auth.userId;
  if (!dek || !userId || _syncing) return;

  _syncing = true;
  try {
    const since = getLastSync();
    const res = await apiFetch(`/api/notes/sync?since=${encodeURIComponent(since)}`);
    if (!res.ok) return;

    const data = await res.json() as {
      notes: ServerNote[];
      serverTime: string;
    };

    for (const sn of data.notes) {
      const serverUpdatedAt = new Date(sn.server_updated_at).getTime();

      // Handle server-side deletes — always accept
      if (sn.is_deleted) {
        await idbMarkDeleted(sn.id);
        notesMap.delete(sn.id);
        if (conflictsMap.has(sn.id)) {
          conflictsMap.delete(sn.id);
          await deleteConflict(sn.id);
        }
        continue;
      }

      // Load local record to check for conflicts
      const existing = await idbGetNoteById(sn.id);

      const hasLocalUnsyncedEdits =
        existing &&
        !existing.synced &&
        existing.clientUpdatedAt > (existing.serverUpdatedAt || 0);

      const serverIsNewer =
        !existing ||
        serverUpdatedAt > (existing.serverUpdatedAt || 0);

      if (hasLocalUnsyncedEdits && serverIsNewer) {
        // --- CONFLICT ---
        const { title: serverTitle, body: serverBody } = await decryptNote(
          sn.encrypted_title, sn.encrypted_body, dek
        );

        const conflict: ConflictRecord = {
          noteId: sn.id,
          userId,
          localTitle: existing.title,
          localBody: existing.body,
          localUpdatedAt: existing.clientUpdatedAt,
          serverTitle,
          serverBody,
          serverUpdatedAt,
          serverVersion: sn.version,
          detectedAt: Date.now(),
        };

        await saveConflict(conflict);
        conflictsMap.set(sn.id, conflict);
        // Do NOT overwrite the local note — user must resolve the conflict
        continue;
      }

      // --- Fast-forward (no conflict) ---
      const { title, body } = await decryptNote(sn.encrypted_title, sn.encrypted_body, dek);

      const local: NoteLocal = {
        id: sn.id,
        userId,
        topicId: sn.topic_id,
        title,
        body,
        customOrder: sn.custom_order,
        clientUpdatedAt: new Date(sn.client_updated_at).getTime(),
        serverUpdatedAt,
        isDeleted: false,
        version: sn.version,
        synced: true,
      };

      await idbSaveNote(local);
      notesMap.set(sn.id, localToNote(local));

      // Clear any stale conflict for this note
      if (conflictsMap.has(sn.id)) {
        conflictsMap.delete(sn.id);
        await deleteConflict(sn.id);
      }
    }

    setLastSync(data.serverTime);

    // Also sync topics and folders
    await syncTopicsFromServer();
    await syncFoldersFromServer();

    // Flush any pending writes queued while offline
    await flushSyncQueue();
  } finally {
    _syncing = false;
  }
}

/**
 * Resolve a conflict by choosing which version to keep, or providing a merge.
 *
 * @param noteId     - the conflicted note's ID
 * @param resolution - 'local' | 'server' | { title, body } for a custom merge
 */
export async function resolveConflict(
  noteId: string,
  resolution: 'local' | 'server' | { title: string; body: string }
): Promise<void> {
  const conflict = conflictsMap.get(noteId);
  if (!conflict) return;

  const dek = auth.dek!;
  const userId = auth.userId!;

  let title: string;
  let body: string;

  if (resolution === 'local') {
    title = conflict.localTitle;
    body = conflict.localBody;
  } else if (resolution === 'server') {
    title = conflict.serverTitle;
    body = conflict.serverBody;
  } else {
    title = resolution.title;
    body = resolution.body;
  }

  const now = Date.now();
  const existing = await idbGetNoteById(noteId);

  const local: NoteLocal = {
    id: noteId,
    userId,
    topicId: existing?.topicId ?? null,
    title,
    body,
    customOrder: existing?.customOrder ?? 0,
    clientUpdatedAt: now,
    serverUpdatedAt: conflict.serverUpdatedAt,
    isDeleted: false,
    version: conflict.serverVersion,
    synced: false,
  };

  await idbSaveNote(local);
  notesMap.set(noteId, localToNote(local));

  // Remove the conflict record
  conflictsMap.delete(noteId);
  await deleteConflict(noteId);

  // Push the resolved version to the server
  const { encryptedTitle, encryptedBody } = await encryptNote(title, body, dek);
  await queueNoteUpsert(noteId, userId, local.topicId, encryptedTitle, encryptedBody, local.customOrder, now, local.version);
  await tryServerUpsertNote(noteId, userId, local.topicId, encryptedTitle, encryptedBody, local.customOrder, now, local.version);
}

async function syncTopicsFromServer(): Promise<void> {
  const res = await apiFetch('/api/topics');
  if (!res.ok) return;
  const topics = await res.json() as ServerTopic[];
  const userId = auth.userId!;

  topicsMap.clear();
  for (const st of topics) {
    const local: TopicLocal = {
      id: st.id,
      userId,
      name: st.name,
      color: st.color,
      folderId: st.folder_id,
      sortOrder: st.sort_order,
      synced: true,
    };
    await idbSaveTopic(local);
    topicsMap.set(st.id, localToTopic(local));
  }
}

async function syncFoldersFromServer(): Promise<void> {
  const res = await apiFetch('/api/folders');
  if (!res.ok) return;
  const folders = await res.json() as ServerFolder[];
  const userId = auth.userId!;

  foldersMap.clear();
  for (const sf of folders) {
    const local: FolderLocal = {
      id: sf.id,
      userId,
      name: sf.name,
      parentId: sf.parent_id,
      sortOrder: sf.sort_order,
      collapsed: sf.collapsed,
      synced: true,
    };
    await idbSaveFolder(local);
    foldersMap.set(sf.id, localToFolder(local));
  }
}

// ---------------------------------------------------------------------------
// Flush sync queue (offline writes)
// ---------------------------------------------------------------------------

const MAX_RETRIES = 5;

export async function flushSyncQueue(): Promise<void> {
  const queue = await getAllSyncQueue();
  for (const item of queue) {
    if (item.retries >= MAX_RETRIES) continue; // give up after 5 attempts
    try {
      if (item.type === 'note') {
        if (item.action === 'upsert') {
          const res = await apiFetch(`/api/notes/${item.id}`, {
            method: 'PUT',
            body: JSON.stringify(item.payload),
          });
          if (res.ok) {
            await dequeueSyncItem(item.id);
            // Mark as synced in IndexedDB
            const n = await idbGetNoteById(item.id);
            if (n) await idbSaveNote({ ...n, synced: true });
          } else {
            await incrementRetry(item.id);
          }
        } else if (item.action === 'delete') {
          const res = await apiFetch(`/api/notes/${item.id}`, { method: 'DELETE' });
          if (res.ok) await dequeueSyncItem(item.id);
          else await incrementRetry(item.id);
        }
      } else if (item.type === 'topic') {
        if (item.action === 'upsert') {
          const res = await apiFetch(`/api/topics/${item.id}`, {
            method: 'PUT',
            body: JSON.stringify(item.payload),
          });
          if (res.ok) await dequeueSyncItem(item.id);
          else await incrementRetry(item.id);
        } else if (item.action === 'delete') {
          const res = await apiFetch(`/api/topics/${item.id}`, { method: 'DELETE' });
          if (res.ok) await dequeueSyncItem(item.id);
          else await incrementRetry(item.id);
        }
      } else if (item.type === 'folder') {
        if (item.action === 'upsert') {
          const res = await apiFetch(`/api/folders/${item.id}`, {
            method: 'PUT',
            body: JSON.stringify(item.payload),
          });
          if (res.ok) await dequeueSyncItem(item.id);
          else await incrementRetry(item.id);
        } else if (item.action === 'delete') {
          const res = await apiFetch(`/api/folders/${item.id}`, { method: 'DELETE' });
          if (res.ok) await dequeueSyncItem(item.id);
          else await incrementRetry(item.id);
        }
      }
    } catch {
      await incrementRetry(item.id);
    }
  }
}

// ---------------------------------------------------------------------------
// Note mutations
// ---------------------------------------------------------------------------

/** Create a new note, persist to IndexedDB, sync to server. */
export async function createNote(topicId: string | null = null): Promise<string> {
  const id = crypto.randomUUID();
  const userId = auth.userId!;
  const dek = auth.dek!;

  const now = Date.now();
  const siblings = [...notesMap.values()].filter((n) => n.topicId === topicId);
  const nextOrder = siblings.length > 0 ? Math.max(...siblings.map((n) => n.customOrder)) + 1 : 0;

  const note: Note = { id, title: '', body: '', topicId, createdAt: now, updatedAt: now, customOrder: nextOrder };

  // Write plaintext to IndexedDB
  const local: NoteLocal = {
    id, userId, topicId, title: '', body: '', customOrder: nextOrder,
    clientUpdatedAt: now, serverUpdatedAt: 0, isDeleted: false, version: 1, synced: false,
  };
  await idbSaveNote(local);
  notesMap.set(id, note);

  // Encrypt and queue for server
  const { encryptedTitle, encryptedBody } = await encryptNote('', '', dek);
  await queueNoteUpsert(id, userId, topicId, encryptedTitle, encryptedBody, nextOrder, now, 1);
  await tryServerUpsertNote(id, userId, topicId, encryptedTitle, encryptedBody, nextOrder, now, 1);

  return id;
}

/** Save (upsert) a note — encrypt → IndexedDB → server. */
export async function saveNote(note: Note): Promise<void> {
  const userId = auth.userId!;
  const dek = auth.dek!;
  const now = Date.now();
  const updated = { ...note, updatedAt: now };

  // Preserve existing serverUpdatedAt and version from IndexedDB (don't reset them)
  const existing = await idbGetNoteById(note.id);
  const serverUpdatedAt = existing?.serverUpdatedAt ?? 0;
  const version = existing?.version ?? 1;

  // Write plaintext to IndexedDB
  const local: NoteLocal = {
    id: note.id, userId, topicId: note.topicId,
    title: note.title, body: note.body, customOrder: note.customOrder,
    clientUpdatedAt: now, serverUpdatedAt, isDeleted: false, version, synced: false,
  };
  await idbSaveNote(local);
  notesMap.set(note.id, updated);

  // Encrypt and send to server
  const { encryptedTitle, encryptedBody } = await encryptNote(note.title, note.body, dek);
  await queueNoteUpsert(note.id, userId, note.topicId, encryptedTitle, encryptedBody, note.customOrder, now, version);
  await tryServerUpsertNote(note.id, userId, note.topicId, encryptedTitle, encryptedBody, note.customOrder, now, version);
}

/** Soft-delete a note. */
export async function deleteNote(id: string): Promise<void> {
  notesMap.delete(id);
  await idbMarkDeleted(id);

  const item: SyncQueueItem = {
    id, type: 'note', action: 'delete', payload: null, createdAt: Date.now(), retries: 0,
  };
  await enqueueSyncItem(item);

  try {
    const res = await apiFetch(`/api/notes/${id}`, { method: 'DELETE' });
    if (res.ok) await dequeueSyncItem(id);
  } catch {
    // stays in queue
  }
}

/** Reorder a note in custom sort mode. */
export async function reorderNote(id: string, afterId: string | null): Promise<void> {
  const note = notesMap.get(id);
  if (!note) return;
  const siblings = [...notesMap.values()]
    .filter((n) => n.topicId === note.topicId && n.id !== id)
    .sort((a, b) => a.customOrder - b.customOrder);
  const insertIdx = afterId ? siblings.findIndex((n) => n.id === afterId) + 1 : 0;
  siblings.splice(insertIdx, 0, { ...note });
  // Update each sibling order
  await Promise.all(
    siblings.map(async (n, i) => {
      const updated = { ...n, customOrder: i };
      notesMap.set(n.id, updated);
      const dek = auth.dek!;
      const userId = auth.userId!;
      const { encryptedTitle, encryptedBody } = await encryptNote(n.title, n.body, dek);
      const existing = await idbGetNoteById(n.id);
      const serverUpdatedAt = existing?.serverUpdatedAt ?? 0;
      const version = existing?.version ?? 1;
      await idbSaveNote({ id: n.id, userId, topicId: n.topicId, title: n.title, body: n.body,
        customOrder: i, clientUpdatedAt: n.updatedAt, serverUpdatedAt, isDeleted: false, version, synced: false });
      await tryServerUpsertNote(n.id, userId, n.topicId, encryptedTitle, encryptedBody, i, n.updatedAt, version);
    })
  );
}

// ---------------------------------------------------------------------------
// Topic mutations
// ---------------------------------------------------------------------------

export async function createTopic(name: string, color: string, folderId: string | null = null): Promise<string> {
  const id = crypto.randomUUID();
  const userId = auth.userId!;
  const siblings = getTopics().filter((t) => t.folderId === folderId);
  const order = siblings.length > 0 ? Math.max(...siblings.map((t) => t.order)) + 1 : 0;

  const topic: Topic = { id, name, color, folderId, order };
  topicsMap.set(id, topic);

  const local: TopicLocal = { id, userId, name, color, folderId, sortOrder: order, synced: false };
  await idbSaveTopic(local);

  const payload = { id, name, color, folderId, sortOrder: order };
  await enqueueSyncItem({ id, type: 'topic', action: 'upsert', payload, createdAt: Date.now(), retries: 0 });
  try {
    const res = await apiFetch(`/api/topics/${id}`, { method: 'PUT', body: JSON.stringify(payload) });
    if (res.ok) await dequeueSyncItem(id);
  } catch { /* queue handles retry */ }

  return id;
}

export async function saveTopic(topic: Topic): Promise<void> {
  const userId = auth.userId!;
  topicsMap.set(topic.id, topic);
  await idbSaveTopic({ id: topic.id, userId, name: topic.name, color: topic.color,
    folderId: topic.folderId, sortOrder: topic.order, synced: false });

  const payload = { id: topic.id, name: topic.name, color: topic.color, folderId: topic.folderId, sortOrder: topic.order };
  await enqueueSyncItem({ id: topic.id, type: 'topic', action: 'upsert', payload, createdAt: Date.now(), retries: 0 });
  try {
    const res = await apiFetch(`/api/topics/${topic.id}`, { method: 'PUT', body: JSON.stringify(payload) });
    if (res.ok) await dequeueSyncItem(topic.id);
  } catch { /* queue handles retry */ }
}

export async function deleteTopic(id: string): Promise<void> {
  topicsMap.delete(id);
  for (const [nid, note] of notesMap) {
    if (note.topicId === id) notesMap.set(nid, { ...note, topicId: null });
  }
  await idbDeleteTopic(id);

  await enqueueSyncItem({ id, type: 'topic', action: 'delete', payload: null, createdAt: Date.now(), retries: 0 });
  try {
    const res = await apiFetch(`/api/topics/${id}`, { method: 'DELETE' });
    if (res.ok) await dequeueSyncItem(id);
  } catch { /* queue handles retry */ }
}

export async function moveTopic(id: string, newFolderId: string | null, afterId?: string): Promise<void> {
  const topic = topicsMap.get(id);
  if (!topic) return;
  const siblings = getTopics()
    .filter((t) => t.folderId === newFolderId && t.id !== id)
    .sort((a, b) => a.order - b.order);
  const insertIdx = afterId ? siblings.findIndex((t) => t.id === afterId) + 1 : 0;
  siblings.splice(insertIdx, 0, { ...topic, folderId: newFolderId });
  await Promise.all(siblings.map((t, i) => saveTopic({ ...t, order: i })));
}

// ---------------------------------------------------------------------------
// Folder mutations
// ---------------------------------------------------------------------------

export async function createFolder(name: string, parentId: string | null = null): Promise<string> {
  const id = crypto.randomUUID();
  const userId = auth.userId!;
  const siblings = getFolders().filter((f) => f.parentId === parentId);
  const order = siblings.length > 0 ? Math.max(...siblings.map((f) => f.order)) + 1 : 0;

  const folder: Folder = { id, name, parentId, order, collapsed: false };
  foldersMap.set(id, folder);

  await idbSaveFolder({ id, userId, name, parentId, sortOrder: order, collapsed: false, synced: false });

  const payload = { id, name, parentId, sortOrder: order, collapsed: false };
  await enqueueSyncItem({ id, type: 'folder', action: 'upsert', payload, createdAt: Date.now(), retries: 0 });
  try {
    const res = await apiFetch(`/api/folders/${id}`, { method: 'PUT', body: JSON.stringify(payload) });
    if (res.ok) await dequeueSyncItem(id);
  } catch { /* queue handles retry */ }

  return id;
}

export async function saveFolder(folder: Folder): Promise<void> {
  const userId = auth.userId!;
  foldersMap.set(folder.id, folder);
  await idbSaveFolder({ id: folder.id, userId, name: folder.name, parentId: folder.parentId,
    sortOrder: folder.order, collapsed: folder.collapsed, synced: false });

  const payload = { id: folder.id, name: folder.name, parentId: folder.parentId,
    sortOrder: folder.order, collapsed: folder.collapsed };
  await enqueueSyncItem({ id: folder.id, type: 'folder', action: 'upsert', payload, createdAt: Date.now(), retries: 0 });
  try {
    const res = await apiFetch(`/api/folders/${folder.id}`, { method: 'PUT', body: JSON.stringify(payload) });
    if (res.ok) await dequeueSyncItem(folder.id);
  } catch { /* queue handles retry */ }
}

export function toggleFolderCollapsed(id: string): void {
  const f = foldersMap.get(id);
  if (f) saveFolder({ ...f, collapsed: !f.collapsed });
}

export async function deleteFolder(id: string): Promise<void> {
  const folder = foldersMap.get(id);
  if (!folder) return;
  for (const [fid, f] of foldersMap) {
    if (f.parentId === id) await saveFolder({ ...f, parentId: folder.parentId });
  }
  for (const [tid, t] of topicsMap) {
    if (t.folderId === id) await saveTopic({ ...t, folderId: null });
  }
  foldersMap.delete(id);
  await idbDeleteFolder(id);

  await enqueueSyncItem({ id, type: 'folder', action: 'delete', payload: null, createdAt: Date.now(), retries: 0 });
  try {
    const res = await apiFetch(`/api/folders/${id}`, { method: 'DELETE' });
    if (res.ok) await dequeueSyncItem(id);
  } catch { /* queue handles retry */ }
}

export async function moveFolder(id: string, newParentId: string | null, afterId?: string): Promise<void> {
  const folder = foldersMap.get(id);
  if (!folder) return;
  const siblings = getFolders()
    .filter((f) => f.parentId === newParentId && f.id !== id)
    .sort((a, b) => a.order - b.order);
  const insertIdx = afterId ? siblings.findIndex((f) => f.id === afterId) + 1 : 0;
  siblings.splice(insertIdx, 0, { ...folder, parentId: newParentId });
  await Promise.all(siblings.map((f, i) => saveFolder({ ...f, order: i })));
}

// ---------------------------------------------------------------------------
// Derived helpers (same API as before — UI components unchanged)
// ---------------------------------------------------------------------------

export function getFolders(): Folder[] {
  return [...foldersMap.values()].sort((a, b) => a.order - b.order);
}

export function getTopics(): Topic[] {
  return [...topicsMap.values()].sort((a, b) => a.order - b.order);
}

export function getNotes(mode: SortMode = 'recent'): Note[] {
  const all = [...notesMap.values()];
  switch (mode) {
    case 'alpha':
      return all.sort((a, b) => a.title.localeCompare(b.title, undefined, { sensitivity: 'base' }));
    case 'custom':
      return all.sort((a, b) => a.customOrder - b.customOrder);
    default:
      return all.sort((a, b) => b.updatedAt - a.updatedAt);
  }
}

export function getNotesByTopic(topicId: string | null, mode: SortMode = 'recent'): Note[] {
  return getNotes(mode).filter((n) => n.topicId === topicId);
}

export function relativeTime(ms: number): string {
  const diff = Date.now() - ms;
  if (diff < 60_000) return 'just now';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  if (diff < 604_800_000) return `${Math.floor(diff / 86_400_000)}d ago`;
  return new Date(ms).toLocaleDateString();
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function localToNote(n: NoteLocal): Note {
  return {
    id: n.id, title: n.title, body: n.body, topicId: n.topicId,
    createdAt: n.clientUpdatedAt, updatedAt: n.clientUpdatedAt, customOrder: n.customOrder,
  };
}

function localToTopic(t: TopicLocal): Topic {
  return { id: t.id, name: t.name, color: t.color, folderId: t.folderId, order: t.sortOrder };
}

function localToFolder(f: FolderLocal): Folder {
  return { id: f.id, name: f.name, parentId: f.parentId, order: f.sortOrder, collapsed: f.collapsed };
}

async function queueNoteUpsert(
  id: string, userId: string, topicId: string | null,
  encryptedTitle: string, encryptedBody: string,
  customOrder: number, clientUpdatedAt: number, version: number
): Promise<void> {
  const payload = {
    id, topicId, encryptedTitle, encryptedBody, customOrder,
    clientUpdatedAt: new Date(clientUpdatedAt).toISOString(),
    version,
  };
  await enqueueSyncItem({ id, type: 'note', action: 'upsert', payload, createdAt: Date.now(), retries: 0 });
}

async function tryServerUpsertNote(
  id: string, userId: string, topicId: string | null,
  encryptedTitle: string, encryptedBody: string,
  customOrder: number, clientUpdatedAt: number, version: number
): Promise<void> {
  try {
    const payload = {
      id, topicId, encryptedTitle, encryptedBody, customOrder,
      clientUpdatedAt: new Date(clientUpdatedAt).toISOString(),
      version,
    };
    const res = await apiFetch(`/api/notes/${id}`, { method: 'PUT', body: JSON.stringify(payload) });
    if (res.ok) {
      await dequeueSyncItem(id);
      const n = notesMap.get(id);
      if (n) {
        // Use server's response for version and server_updated_at
        const serverNote = await res.clone().json().catch(() => null) as { note?: { version?: number; server_updated_at?: string } } | null;
        const serverVersion = serverNote?.note?.version ?? version;
        const serverUpdatedAt = serverNote?.note?.server_updated_at
          ? new Date(serverNote.note.server_updated_at).getTime()
          : Date.now();
        await idbSaveNote({
          id, userId, topicId, title: n.title, body: n.body, customOrder,
          clientUpdatedAt, serverUpdatedAt, isDeleted: false, version: serverVersion, synced: true,
        });
      }
    }
  } catch {
    // Offline — item stays in queue
  }
}

// ---------------------------------------------------------------------------
// Server response types (internal — not exported)
// ---------------------------------------------------------------------------

interface ServerNote {
  id: string;
  topic_id: string | null;
  encrypted_title: string;
  encrypted_body: string;
  custom_order: number;
  client_updated_at: string;
  server_updated_at: string;
  is_deleted: boolean;
  version: number;
}

interface ServerTopic {
  id: string;
  name: string;
  color: string;
  folder_id: string | null;
  sort_order: number;
}

interface ServerFolder {
  id: string;
  name: string;
  parent_id: string | null;
  sort_order: number;
  collapsed: boolean;
}
