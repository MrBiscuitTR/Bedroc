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
import { auth, apiFetch, reportSyncResult } from './auth.svelte.js';
import { encryptNote, decryptNote } from '$lib/crypto/encrypt.js';
import { extractAttachments, rehydrateAttachments } from '$lib/attachments.js';
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
let _consecutiveSyncFailures = 0; // reset to 0 on first success after failures → triggers full sync
export const syncState = {
  get syncing() { return _syncing; },
  get isInitialSync() { return _syncing && (typeof localStorage === 'undefined' || localStorage.getItem(lastSyncKey()) === null); }
};

let _dbLoaded = $state(false);
export const dbState = { get loaded() { return _dbLoaded; } };

// ---------------------------------------------------------------------------
// Conflicts reactive map
// ---------------------------------------------------------------------------

export const conflictsMap = new SvelteMap<string, ConflictRecord>();

export { type ConflictRecord };

// ---------------------------------------------------------------------------
// External update signal (real-time editor sync)
// ---------------------------------------------------------------------------

/**
 * Posted by syncFromServer() when a note that is already in notesMap
 * receives a newer version from the server. The note editor watches this map
 * and applies the update cursor-preservingly when the setting is enabled.
 *
 * Consumed (deleted) by the editor after processing — acts as a one-shot signal.
 */
export interface ExternalUpdate {
  title: string;
  body: string;
  updatedAt: number;
}

export const externalUpdates = new SvelteMap<string, ExternalUpdate>();

// ---------------------------------------------------------------------------
// Live sync setting (localStorage — user pref)
// ---------------------------------------------------------------------------

function readLiveSync(): boolean {
  if (typeof localStorage === 'undefined') return true;
  const raw = localStorage.getItem('bedroc_live_sync');
  return raw === null ? true : raw === '1';
}

class LiveSyncStore {
  enabled = $state(readLiveSync());
  set(on: boolean) {
    this.enabled = on;
    if (typeof localStorage !== 'undefined') localStorage.setItem('bedroc_live_sync', on ? '1' : '0');
  }
}
export const liveSyncStore = new LiveSyncStore();

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
// Periodic sync interval (localStorage — user pref)
// ---------------------------------------------------------------------------

function readSyncInterval(): number {
  if (typeof localStorage === 'undefined') return 5000;
  const raw = localStorage.getItem('bedroc_sync_ms');
  const parsed = raw ? parseInt(raw, 10) : NaN;
  // minimum 1s, default 5s
  return Number.isFinite(parsed) && parsed >= 1000 ? parsed : 5000;
}

class SyncIntervalStore {
  interval = $state(readSyncInterval());
  set(ms: number) {
    const clamped = Math.max(1000, ms);
    this.interval = clamped;
    if (typeof localStorage !== 'undefined') localStorage.setItem('bedroc_sync_ms', String(clamped));
  }
}
export const syncIntervalStore = new SyncIntervalStore();

// ---------------------------------------------------------------------------
// Inactivity lock (localStorage — user pref)
// ---------------------------------------------------------------------------

const LS_INACTIVITY_KEY = 'bedroc_inactivity_ms';
const INACTIVITY_DEFAULT_MS = 30 * 60 * 1000; // 30 minutes

function readInactivityMs(): number {
  if (typeof localStorage === 'undefined') return INACTIVITY_DEFAULT_MS;
  const raw = localStorage.getItem(LS_INACTIVITY_KEY);
  const parsed = raw ? parseInt(raw, 10) : NaN;
  // 0 = disabled; otherwise minimum 1 minute
  if (parsed === 0) return 0;
  return Number.isFinite(parsed) && parsed >= 60_000 ? parsed : INACTIVITY_DEFAULT_MS;
}

class InactivityLockStore {
  ms = $state(readInactivityMs());
  get minutes() { return this.ms === 0 ? 0 : Math.round(this.ms / 60_000); }
  set(ms: number) {
    this.ms = ms;
    if (typeof localStorage !== 'undefined') localStorage.setItem(LS_INACTIVITY_KEY, String(ms));
  }
  setMinutes(min: number) {
    this.set(min === 0 ? 0 : Math.max(60_000, min * 60_000));
  }
}
export const inactivityLockStore = new InactivityLockStore();

// ---------------------------------------------------------------------------
// Load from IndexedDB on login
// ---------------------------------------------------------------------------

/** Load all data from IndexedDB into reactive maps. Call once after login. */
export async function loadFromDb(): Promise<void> {
  const userId = auth.userId;
  if (!userId) return;

  _dbLoaded = false;
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

  // Repair orphaned folders (circular parentId references)
  for (const [id, folder] of foldersMap) {
    if (folder.parentId === null) continue;
    // Walk the parent chain; if we revisit this folder's id, it's circular
    const visited = new Set<string>([id]);
    let cur = folder.parentId;
    let broken = false;
    while (cur) {
      if (visited.has(cur)) { broken = true; break; }
      visited.add(cur);
      const parent = foldersMap.get(cur);
      cur = parent?.parentId ?? null;
    }
    // Also broken if parentId references a folder that doesn't exist
    if (!broken && folder.parentId && !foldersMap.has(folder.parentId)) broken = true;
    if (broken) {
      const fixed = { ...folder, parentId: null };
      foldersMap.set(id, fixed);
      // Persist the fix
      saveFolder(fixed);
    }
  }

  for (const c of conflicts) {
      conflictsMap.set(c.noteId, c);
    }

    _dbLoaded = true;
}

/** Clear reactive maps on logout. */
export function clearStore(): void {
    _dbLoaded = false;
    notesMap.clear();
  topicsMap.clear();
  foldersMap.clear();
  conflictsMap.clear();
}

// ---------------------------------------------------------------------------
// Delta sync from server
// ---------------------------------------------------------------------------

/** Key in localStorage tracking last successful sync timestamp — scoped per user. */
function lastSyncKey(): string {
  // auth.userId may be null on first call before login; fall back to shared key
  const uid = auth.userId;
  return uid ? `bedroc_last_sync_${uid}` : 'bedroc_last_sync';
}

function getLastSync(): string {
  if (typeof localStorage === 'undefined') return new Date(0).toISOString();
  return localStorage.getItem(lastSyncKey()) ?? new Date(0).toISOString();
}

function setLastSync(iso: string): void {
  if (typeof localStorage !== 'undefined') localStorage.setItem(lastSyncKey(), iso);
}

/** Clear the sync timestamp for the current user (call on logout so next login does a full sync). */
export function clearLastSync(): void {
  if (typeof localStorage !== 'undefined') {
    localStorage.removeItem(lastSyncKey());
    // Also clear the legacy shared key
    localStorage.removeItem('bedroc_last_sync');
  }
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
    // Flush pending writes FIRST so the server has the latest local state
    // before we pull down. This prevents locally-created notes from being
    // missed by the subsequent pull (race: note created after last sync timestamp).
    await flushSyncQueue();

    // After any outage (1+ consecutive failures), do a full sync to ensure no
    // notes are missed due to stale lastSync timestamp.
    const wasOffline = _consecutiveSyncFailures > 0;
    const since = wasOffline ? new Date(0).toISOString() : getLastSync();
    console.log('[sync] Starting syncFromServer', { userId, since, wasOffline, serverUrl: auth.serverUrl, hasAccessToken: !!auth.accessToken, tokenIsOffline: auth.accessToken === 'offline' });
    const res = await apiFetch(`/api/notes/sync?since=${encodeURIComponent(since)}`);
    console.log('[sync] /api/notes/sync response', res.status, res.ok);
    reportSyncResult(res.ok);
    if (!res.ok) {
      _consecutiveSyncFailures++;
      const body = await res.text().catch(() => '');
      console.warn('[sync] /api/notes/sync failed', res.status, body);
      return;
    }
    _consecutiveSyncFailures = 0;

    const data = await res.json() as {
      notes: ServerNote[];
      serverTime: string;
    };

    console.log('[sync] Received', data.notes.length, 'notes from server, serverTime:', data.serverTime);

    // Process all notes (IDB writes + conflict detection) first, collecting
    // reactive map changes. Apply them all at the end in one synchronous pass
    // so Svelte batches into a single re-render instead of one per note.
    const notesToSet: [string, Note][] = [];
    const notesToDelete: string[] = [];
    const conflictsToSet: [string, ConflictRecord][] = [];
    const conflictsToDelete: string[] = [];

    for (const sn of data.notes) {
      const serverUpdatedAt = new Date(sn.server_updated_at).getTime();

      // Handle server-side deletes
      if (sn.is_deleted) {
        const existingForDelete = await idbGetNoteById(sn.id);
        const hasUnsyncedEdits =
          existingForDelete &&
          !existingForDelete.synced &&
          existingForDelete.clientUpdatedAt > (existingForDelete.serverUpdatedAt || 0);

        if (hasUnsyncedEdits) {
          // Never silently delete a note with local unsynced edits.
          // Surface it as a conflict so the user can recover their work.
          const conflict: ConflictRecord = {
            noteId: sn.id,
            userId,
            localTitle: existingForDelete.title,
            localBody: existingForDelete.body,
            localUpdatedAt: existingForDelete.clientUpdatedAt,
            serverTitle: '',
            serverBody: '',
            serverUpdatedAt: new Date(sn.server_updated_at).getTime(),
            serverVersion: sn.version,
            detectedAt: Date.now(),
          };
          await saveConflict(conflict);
          conflictsToSet.push([sn.id, conflict]);
        } else {
          await idbMarkDeleted(sn.id);
          notesToDelete.push(sn.id);
          if (conflictsMap.has(sn.id)) {
            conflictsToDelete.push(sn.id);
            await deleteConflict(sn.id);
          }
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
        const { title: serverTitle, body: serverBodyRaw } = await decryptNote(
          sn.encrypted_title, sn.encrypted_body, dek
        );
        const serverBody = await rehydrateAttachments(serverBodyRaw, userId, dek);

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
        conflictsToSet.push([sn.id, conflict]);
        // Do NOT overwrite the local note — user must resolve the conflict
        continue;
      }

      // --- Fast-forward (no conflict) ---
      const { title, body: rawBody } = await decryptNote(sn.encrypted_title, sn.encrypted_body, dek);
      // Restore attachment placeholders → data URIs before storing locally
      const body = await rehydrateAttachments(rawBody, userId, dek);

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
      notesToSet.push([sn.id, localToNote(local)]);

      // Signal real-time update to any open editor for this note.
      // Only signal when live sync is enabled and the note was already loaded
      // (i.e. existed in notesMap before this sync cycle).
      if (liveSyncStore.enabled && notesMap.has(sn.id)) {
        externalUpdates.set(sn.id, { title, body, updatedAt: serverUpdatedAt });
      }

      // Clear any stale conflict for this note
      if (conflictsMap.has(sn.id)) {
        conflictsToDelete.push(sn.id);
        await deleteConflict(sn.id);
      }
    }

    // Apply all reactive map changes synchronously — one Svelte render pass
    for (const id of notesToDelete) notesMap.delete(id);
    for (const [id, note] of notesToSet) notesMap.set(id, note);
    for (const id of conflictsToDelete) conflictsMap.delete(id);
    for (const [id, conflict] of conflictsToSet) conflictsMap.set(id, conflict);

    setLastSync(data.serverTime);
    console.log('[sync] Notes sync complete. Syncing topics and folders...');

    // Also sync topics and folders
    await syncTopicsFromServer();
    await syncFoldersFromServer();

    console.log('[sync] Topics:', topicsMap.size, 'Folders:', foldersMap.size, 'Notes:', notesMap.size);
    setLastSync(data.serverTime);
    console.log('[sync] syncFromServer complete');

  } catch (err) {
    _consecutiveSyncFailures++;
    reportSyncResult(false);
    throw err;
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
    // If server deleted the note (empty title+body sentinel), accept the deletion
    if (conflict.serverTitle === '' && conflict.serverBody === '') {
      await idbMarkDeleted(noteId);
      notesMap.delete(noteId);
      conflictsMap.delete(noteId);
      await deleteConflict(noteId);
      return;
    }
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

  // Push the resolved version to the server (extract attachments before encrypting)
  const syncBody = await extractAttachments(body, userId, dek);
  const { encryptedTitle, encryptedBody } = await encryptNote(title, syncBody, dek);
  await queueNoteUpsert(noteId, userId, local.topicId, encryptedTitle, encryptedBody, local.customOrder, now, local.version);
  await tryServerUpsertNote(noteId, userId, local.topicId, encryptedTitle, encryptedBody, local.customOrder, now, local.version);
}

async function syncTopicsFromServer(): Promise<void> {
  const res = await apiFetch('/api/topics');
  console.log('[sync] /api/topics response', res.status, res.ok);
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    console.warn('[sync] /api/topics failed', res.status, body);
    return;
  }
  const data = await res.json() as { topics?: ServerTopic[] };
  const topics = data.topics;
  console.log('[sync] /api/topics returned', Array.isArray(topics) ? topics.length : 'invalid shape', 'topics, raw data keys:', Object.keys(data));
  // Guard: only replace local state if we got a valid array back
  if (!Array.isArray(topics)) {
    console.warn('[sync] topics is not an array, skipping clear. data:', data);
    return;
  }
  const userId = auth.userId!;

  // Build new entries first, then atomically replace the map
  const incoming = new Map<string, TopicLocal>();
  for (const st of topics) {
    incoming.set(st.id, {
      id: st.id,
      userId,
      name: st.name,
      color: st.color,
      folderId: st.folder_id,
      sortOrder: st.sort_order,
      synced: true,
    });
  }

  // Save to IDB first (async), then replace the reactive map in one synchronous
  // pass so Svelte batches all the .set() calls into a single re-render.
  await Promise.all([...incoming.values()].map(idbSaveTopic));
  topicsMap.clear();
  for (const [id, local] of incoming) {
    topicsMap.set(id, localToTopic(local));
  }
}

async function syncFoldersFromServer(): Promise<void> {
  const res = await apiFetch('/api/folders');
  console.log('[sync] /api/folders response', res.status, res.ok);
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    console.warn('[sync] /api/folders failed', res.status, body);
    return;
  }
  const data = await res.json() as { folders?: ServerFolder[] };
  const folders = data.folders;
  console.log('[sync] /api/folders returned', Array.isArray(folders) ? folders.length : 'invalid shape', 'folders');
  // Guard: only replace local state if we got a valid array back
  if (!Array.isArray(folders)) {
    console.warn('[sync] folders is not an array, skipping clear. data:', data);
    return;
  }
  const userId = auth.userId!;

  // Build new entries first, then atomically replace the map
  const incoming = new Map<string, FolderLocal>();
  for (const sf of folders) {
    incoming.set(sf.id, {
      id: sf.id,
      userId,
      name: sf.name,
      parentId: sf.parent_id,
      sortOrder: sf.sort_order,
      collapsed: sf.collapsed,
      synced: true,
    });
  }

  // Same batching pattern: IDB writes first, then atomic map replacement.
  await Promise.all([...incoming.values()].map(idbSaveFolder));
  foldersMap.clear();
  for (const [id, local] of incoming) {
    foldersMap.set(id, localToFolder(local));
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
  const dek = auth.dek;
  const now = Date.now();
  const updated = { ...note, updatedAt: now };

  // Preserve existing serverUpdatedAt and version from IndexedDB (don't reset them)
  const existing = await idbGetNoteById(note.id);
  const serverUpdatedAt = existing?.serverUpdatedAt ?? 0;
  const version = existing?.version ?? 1;

  // Write plaintext to IndexedDB — always safe regardless of DEK state
  const local: NoteLocal = {
    id: note.id, userId, topicId: note.topicId,
    title: note.title, body: note.body, customOrder: note.customOrder,
    clientUpdatedAt: now, serverUpdatedAt, isDeleted: false, version, synced: false,
  };
  await idbSaveNote(local);
  notesMap.set(note.id, updated);

  // Encrypt and sync to server — requires DEK (skip if locked/offline-unlocked without key)
  if (!dek) return;
  // Extract image attachments from body before encrypting — replaces data: URIs with
  // `attachment:<hash>` placeholders so large blobs are not re-uploaded every save.
  const syncBody = await extractAttachments(note.body, userId, dek);
  const { encryptedTitle, encryptedBody } = await encryptNote(note.title, syncBody, dek);
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
      const syncBody = await extractAttachments(n.body, userId, dek);
      const { encryptedTitle, encryptedBody } = await encryptNote(n.title, syncBody, dek);
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
  // Prevent circular reference: can't move folder into itself or any of its descendants
  if (newParentId !== null) {
    if (newParentId === id) return;
    let cur = newParentId;
    while (cur) {
      const p = foldersMap.get(cur);
      if (!p || !p.parentId) break;
      if (p.parentId === id) return; // descendant — would create cycle
      cur = p.parentId;
    }
  }
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
    console.log('[sync] PUT /api/notes/', id, 'topicId:', topicId, 'version:', version);
    const res = await apiFetch(`/api/notes/${id}`, { method: 'PUT', body: JSON.stringify(payload) });
    console.log('[sync] PUT /api/notes/ response', res.status, res.ok);
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      console.warn('[sync] PUT /api/notes/ failed', res.status, body);
    }
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
