/**
 * lib/db/indexeddb.ts — IndexedDB offline-first storage layer.
 *
 * Stores all user data locally so the app works fully offline.
 * The server is a sync target, not the primary store.
 *
 * Database: "bedroc" (version 2)
 * Object stores:
 *   notes      — NoteLocal records (decrypted title/body stored in plain text)
 *   topics     — TopicLocal records
 *   folders    — FolderLocal records
 *   syncQueue  — pending writes to be flushed to server (encrypted)
 *   keyMaterial — encrypted DEK + derivation params (one record per account)
 *   conflicts  — ConflictRecord: both versions of a note when a sync conflict is detected
 *
 * Design decisions:
 *   - notes are stored DECRYPTED in IndexedDB (client-local only).
 *     IndexedDB is not accessible from other origins and is sandboxed.
 *     Storing decrypted content enables offline text search without re-decrypting.
 *   - syncQueue holds the server payload (encrypted ciphertext) to avoid
 *     needing the DEK to be available when the sync flush actually runs.
 *   - keyMaterial is NOT the plaintext DEK — it's the encrypted_dek blob from
 *     the server plus the dekSalt needed to re-derive the master key from password.
 *     This allows the app to restore the DEK from password on next open without
 *     fetching from the server while offline.
 *   - conflicts stores both the local and server versions of a note. The local
 *     version is preserved until the user resolves the conflict. Resolution can
 *     be: keep local, keep server, or write a custom merge. Resolved conflicts
 *     are removed from this store.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface NoteLocal {
  id: string;
  userId: string;
  topicId: string | null;
  title: string;        // plaintext (decrypted client-side)
  body: string;         // plaintext
  customOrder: number;
  clientUpdatedAt: number; // Unix timestamp ms
  serverUpdatedAt: number; // 0 if not yet synced
  isDeleted: boolean;
  version: number;
  synced: boolean;      // true = server has this version
}

export interface TopicLocal {
  id: string;
  userId: string;
  name: string;
  color: string;
  folderId: string | null;
  sortOrder: number;
  synced: boolean;
}

export interface FolderLocal {
  id: string;
  userId: string;
  name: string;
  parentId: string | null;
  sortOrder: number;
  collapsed: boolean;
  synced: boolean;
}

/** A pending write queued for server sync. */
export interface SyncQueueItem {
  id: string;             // same as the note/topic/folder id
  type: 'note' | 'topic' | 'folder';
  action: 'upsert' | 'delete';
  /** Encrypted server payload — ready to PUT/DELETE via API. */
  payload: unknown;
  createdAt: number;
  retries: number;
}

/** Stored key material for restoring the DEK after page reload. */
export interface KeyMaterialRecord {
  id: 'current';          // singleton record
  username: string;
  userId: string;         // stored for offline unlock (can't decode JWT offline)
  serverUrl: string;
  encryptedDek: string;   // JSON blob from server (iv + ciphertext)
  dekSaltHex: string;     // hex 32-byte salt for PBKDF2
}

/**
 * A conflict record created when syncFromServer() finds that the server has
 * a newer version of a note that was also edited locally (unsynced).
 *
 * Both versions are stored so the user can resolve without data loss.
 */
export interface ConflictRecord {
  noteId: string;           // the note's ID (also the keyPath)
  userId: string;
  // Local version (what the user wrote offline)
  localTitle: string;
  localBody: string;
  localUpdatedAt: number;   // clientUpdatedAt from the local NoteLocal
  // Server version (what was on the server)
  serverTitle: string;
  serverBody: string;
  serverUpdatedAt: number;  // serverUpdatedAt from the incoming ServerNote
  serverVersion: number;
  detectedAt: number;       // when the conflict was detected
}

// ---------------------------------------------------------------------------
// DB singleton
// ---------------------------------------------------------------------------

let db: IDBDatabase | null = null;
const DB_NAME = 'bedroc';
const DB_VERSION = 2;

/** Open (or return cached) IndexedDB instance. */
export function openDb(): Promise<IDBDatabase> {
  if (db) return Promise.resolve(db);

  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);

    req.onupgradeneeded = (event) => {
      const d = (event.target as IDBOpenDBRequest).result;
      const oldVersion = event.oldVersion;

      if (oldVersion < 1) {
        // notes
        const notes = d.createObjectStore('notes', { keyPath: 'id' });
        notes.createIndex('by_user', 'userId');
        notes.createIndex('by_user_topic', ['userId', 'topicId']);
        notes.createIndex('by_user_order', ['userId', 'customOrder']);
        notes.createIndex('by_updated', ['userId', 'clientUpdatedAt']);
        notes.createIndex('unsynced', ['userId', 'synced']);

        // topics
        const topics = d.createObjectStore('topics', { keyPath: 'id' });
        topics.createIndex('by_user', 'userId');

        // folders
        const folders = d.createObjectStore('folders', { keyPath: 'id' });
        folders.createIndex('by_user', 'userId');

        // syncQueue
        const queue = d.createObjectStore('syncQueue', { keyPath: 'id' });
        queue.createIndex('by_type', 'type');
        queue.createIndex('by_created', 'createdAt');

        // keyMaterial
        d.createObjectStore('keyMaterial', { keyPath: 'id' });
      }

      if (oldVersion < 2) {
        // conflicts — stores both versions of a note when a sync conflict is detected
        const conflicts = d.createObjectStore('conflicts', { keyPath: 'noteId' });
        conflicts.createIndex('by_user', 'userId');
        conflicts.createIndex('by_detected', 'detectedAt');
      }
    };

    req.onsuccess = (event) => {
      db = (event.target as IDBOpenDBRequest).result;
      resolve(db);
    };

    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error('IndexedDB upgrade blocked by another tab'));
  });
}

/** Close the DB connection (call on logout to release lock). */
export function closeDb(): void {
  db?.close();
  db = null;
}

// ---------------------------------------------------------------------------
// Generic helpers
// ---------------------------------------------------------------------------

function idbRequest<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function getStore(
  storeName: string,
  mode: IDBTransactionMode
): Promise<IDBObjectStore> {
  const d = await openDb();
  return d.transaction(storeName, mode).objectStore(storeName);
}

// ---------------------------------------------------------------------------
// Notes
// ---------------------------------------------------------------------------

export async function saveNote(note: NoteLocal): Promise<void> {
  const store = await getStore('notes', 'readwrite');
  await idbRequest(store.put(note));
}

export async function getNoteById(id: string): Promise<NoteLocal | undefined> {
  const store = await getStore('notes', 'readonly');
  return idbRequest(store.get(id));
}

export async function getNotesByUser(userId: string): Promise<NoteLocal[]> {
  const store = await getStore('notes', 'readonly');
  const idx = store.index('by_user');
  const notes = await idbRequest<NoteLocal[]>(idx.getAll(userId));
  return notes.filter((n) => !n.isDeleted);
}

export async function getNotesByTopic(
  userId: string,
  topicId: string | null
): Promise<NoteLocal[]> {
  const store = await getStore('notes', 'readonly');
  const idx = store.index('by_user_topic');
  const notes = await idbRequest<NoteLocal[]>(idx.getAll([userId, topicId]));
  return notes.filter((n) => !n.isDeleted);
}

export async function deleteNoteLocal(id: string): Promise<void> {
  const store = await getStore('notes', 'readwrite');
  await idbRequest(store.delete(id));
}

export async function markNoteDeleted(id: string): Promise<void> {
  const note = await getNoteById(id);
  if (!note) return;
  const store = await getStore('notes', 'readwrite');
  await idbRequest(store.put({ ...note, isDeleted: true, synced: false }));
}

// ---------------------------------------------------------------------------
// Topics
// ---------------------------------------------------------------------------

export async function saveTopic(topic: TopicLocal): Promise<void> {
  const store = await getStore('topics', 'readwrite');
  await idbRequest(store.put(topic));
}

export async function getTopicsByUser(userId: string): Promise<TopicLocal[]> {
  const store = await getStore('topics', 'readonly');
  const idx = store.index('by_user');
  return idbRequest<TopicLocal[]>(idx.getAll(userId));
}

export async function deleteTopic(id: string): Promise<void> {
  const store = await getStore('topics', 'readwrite');
  await idbRequest(store.delete(id));
}

// ---------------------------------------------------------------------------
// Folders
// ---------------------------------------------------------------------------

export async function saveFolder(folder: FolderLocal): Promise<void> {
  const store = await getStore('folders', 'readwrite');
  await idbRequest(store.put(folder));
}

export async function getFoldersByUser(userId: string): Promise<FolderLocal[]> {
  const store = await getStore('folders', 'readonly');
  const idx = store.index('by_user');
  return idbRequest<FolderLocal[]>(idx.getAll(userId));
}

export async function deleteFolder(id: string): Promise<void> {
  const store = await getStore('folders', 'readwrite');
  await idbRequest(store.delete(id));
}

// ---------------------------------------------------------------------------
// Sync queue
// ---------------------------------------------------------------------------

export async function enqueueSyncItem(item: SyncQueueItem): Promise<void> {
  const store = await getStore('syncQueue', 'readwrite');
  await idbRequest(store.put(item));
}

export async function dequeueSyncItem(id: string): Promise<void> {
  const store = await getStore('syncQueue', 'readwrite');
  await idbRequest(store.delete(id));
}

export async function getAllSyncQueue(): Promise<SyncQueueItem[]> {
  const store = await getStore('syncQueue', 'readonly');
  return idbRequest<SyncQueueItem[]>(store.getAll());
}

export async function incrementRetry(id: string): Promise<void> {
  const store = await getStore('syncQueue', 'readwrite');
  const item = await idbRequest<SyncQueueItem>(store.get(id));
  if (item) await idbRequest(store.put({ ...item, retries: item.retries + 1 }));
}

// ---------------------------------------------------------------------------
// Key material
// ---------------------------------------------------------------------------

export async function saveKeyMaterial(record: KeyMaterialRecord): Promise<void> {
  const store = await getStore('keyMaterial', 'readwrite');
  await idbRequest(store.put(record));
}

export async function loadKeyMaterial(): Promise<KeyMaterialRecord | undefined> {
  const store = await getStore('keyMaterial', 'readonly');
  return idbRequest(store.get('current'));
}

export async function clearKeyMaterial(): Promise<void> {
  const store = await getStore('keyMaterial', 'readwrite');
  await idbRequest(store.delete('current'));
}

// ---------------------------------------------------------------------------
// Conflicts
// ---------------------------------------------------------------------------

export async function saveConflict(record: ConflictRecord): Promise<void> {
  const store = await getStore('conflicts', 'readwrite');
  await idbRequest(store.put(record));
}

export async function getConflict(noteId: string): Promise<ConflictRecord | undefined> {
  const store = await getStore('conflicts', 'readonly');
  return idbRequest(store.get(noteId));
}

export async function getConflictsByUser(userId: string): Promise<ConflictRecord[]> {
  const store = await getStore('conflicts', 'readonly');
  const idx = store.index('by_user');
  return idbRequest<ConflictRecord[]>(idx.getAll(userId));
}

export async function deleteConflict(noteId: string): Promise<void> {
  const store = await getStore('conflicts', 'readwrite');
  await idbRequest(store.delete(noteId));
}

// ---------------------------------------------------------------------------
// Full wipe (logout / account delete)
// ---------------------------------------------------------------------------

/** Clear all data for a user from every object store. */
export async function wipeLocalData(userId: string): Promise<void> {
  const d = await openDb();
  const tx = d.transaction(['notes', 'topics', 'folders', 'syncQueue', 'keyMaterial', 'conflicts'], 'readwrite');

  // Delete notes
  const noteIdx = tx.objectStore('notes').index('by_user');
  await new Promise<void>((resolve, reject) => {
    const req = noteIdx.openCursor(userId);
    req.onsuccess = () => {
      const cursor = req.result;
      if (cursor) { cursor.delete(); cursor.continue(); }
      else resolve();
    };
    req.onerror = () => reject(req.error);
  });

  // Delete topics
  const topicIdx = tx.objectStore('topics').index('by_user');
  await new Promise<void>((resolve, reject) => {
    const req = topicIdx.openCursor(userId);
    req.onsuccess = () => {
      const cursor = req.result;
      if (cursor) { cursor.delete(); cursor.continue(); }
      else resolve();
    };
    req.onerror = () => reject(req.error);
  });

  // Delete folders
  const folderIdx = tx.objectStore('folders').index('by_user');
  await new Promise<void>((resolve, reject) => {
    const req = folderIdx.openCursor(userId);
    req.onsuccess = () => {
      const cursor = req.result;
      if (cursor) { cursor.delete(); cursor.continue(); }
      else resolve();
    };
    req.onerror = () => reject(req.error);
  });

  // Clear entire sync queue, key material, and conflicts
  tx.objectStore('syncQueue').clear();
  tx.objectStore('keyMaterial').clear();
  tx.objectStore('conflicts').clear();

  await new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });

  closeDb();
}
