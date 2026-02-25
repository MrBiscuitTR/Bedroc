/**
 * notes.svelte.ts — In-memory note, topic, and folder store (Phase 0 / Phase 1 shell).
 *
 * PLACEHOLDERS (replace in Phase 2):
 *  - All data is in-memory only; no IndexedDB or server persistence.
 *  - saveNote / deleteNote / saveTopic / deleteTopic only mutate local maps.
 *  - Note body is stored as raw HTML from contenteditable; in Phase 2 this
 *    must be AES-GCM encrypted before leaving the device.
 *  - autosave.interval is read from localStorage; defaults to 1000ms.
 *    Real setting persistence wired in Phase 5.
 *  - sortMode and customOrder are persisted to localStorage only.
 *    Move to server-backed user preferences in Phase 5.
 *
 * ID strategy:
 *  - All note, topic, and folder IDs are crypto.randomUUID() — client-generated.
 *  - Static UUIDs are used for demo data to avoid calling crypto at module
 *    evaluation time, which throws during SSR.
 *  - The server (Phase 2) will store the client UUID as the primary key.
 */

import { SvelteMap } from 'svelte/reactivity';

// ─── Types ────────────────────────────────────────────────────────

export interface Folder {
	id: string;
	name: string;
	/** null = root level (no parent folder) */
	parentId: string | null;
	/** Ascending integer — lower = higher in the list */
	order: number;
	collapsed: boolean;
}

export interface Topic {
	id: string;
	name: string;
	/** CSS color string — any valid CSS color (hex, hsl, etc.) */
	color: string;
	/** null = unfiled (not inside any folder) */
	folderId: string | null;
	/** Ascending integer — lower = higher within its folder group */
	order: number;
}

export interface Note {
	id: string;
	title: string;
	/** Raw HTML from contenteditable — PLACEHOLDER: must be encrypted in Phase 2 */
	body: string;
	topicId: string | null;
	createdAt: number;   // Unix ms
	updatedAt: number;   // Unix ms
	/**
	 * Position in the custom sort order within its topic group.
	 * Only used when sortMode === 'custom'. Lower = higher in list.
	 * PLACEHOLDER: persisted to localStorage. Move to server in Phase 5.
	 */
	customOrder: number;
}

/** How the note list is sorted. Persisted to localStorage. */
export type SortMode = 'recent' | 'alpha' | 'custom';

// ─── Demo data (static IDs — no crypto at module eval time) ───────
// PLACEHOLDER: removed and replaced with empty arrays in Phase 2.

const F_WORK_FOLDER = 'f1000000-0000-0000-0000-000000000001';

const DEFAULT_FOLDERS: Folder[] = [
	{ id: F_WORK_FOLDER, name: 'Work projects', parentId: null, order: 0, collapsed: false },
];

const T_PERSONAL = 'a1000000-0000-0000-0000-000000000001';
const T_WORK     = 'a1000000-0000-0000-0000-000000000002';
const T_IDEAS    = 'a1000000-0000-0000-0000-000000000003';

const DEFAULT_TOPICS: Topic[] = [
	{ id: T_PERSONAL, name: 'Personal', color: '#6b8afd', folderId: null,         order: 0 },
	{ id: T_WORK,     name: 'Work',     color: '#4caf87', folderId: F_WORK_FOLDER, order: 0 },
	{ id: T_IDEAS,    name: 'Ideas',    color: '#e0a45c', folderId: null,          order: 1 },
];

const DEFAULT_NOTES: Note[] = [
	{
		id: 'b1000000-0000-0000-0000-000000000001',
		title: 'Shopping list',
		body: '<p>Milk, eggs, bread, coffee, olive oil</p><ul><li>Milk</li><li>Eggs</li><li>Bread</li><li>Coffee</li></ul>',
		topicId: T_PERSONAL,
		createdAt: Date.now() - 86400000,
		updatedAt: Date.now() - 120000,
		customOrder: 0,
	},
	{
		id: 'b1000000-0000-0000-0000-000000000002',
		title: 'Meeting notes',
		body: '<p><strong>Q3 goals</strong> — action items from last week</p><ul><li>Follow up with design team</li><li>Update the roadmap doc</li><li>Schedule weekly sync</li></ul>',
		topicId: T_WORK,
		createdAt: Date.now() - 172800000,
		updatedAt: Date.now() - 3600000,
		customOrder: 0,
	},
	{
		id: 'b1000000-0000-0000-0000-000000000003',
		title: 'Feature ideas',
		body: '<p>New feature concepts for the project:</p><ol><li>Offline-first sync with conflict resolution</li><li>Shared encrypted notes via asymmetric keys</li><li>Markdown export</li></ol>',
		topicId: T_IDEAS,
		createdAt: Date.now() - 259200000,
		updatedAt: Date.now() - 86400000,
		customOrder: 0,
	},
	{
		id: 'b1000000-0000-0000-0000-000000000004',
		title: 'Quick note',
		body: '<p>Remember to check the deployment configs before Friday.</p>',
		topicId: null,
		createdAt: Date.now() - 300000,
		updatedAt: Date.now() - 300000,
		customOrder: 0,
	},
];

// ─── Reactive stores ───────────────────────────────────────────────
// SvelteMap provides fine-grained reactivity; all keyed by ID.

export const foldersMap = new SvelteMap<string, Folder>(
	DEFAULT_FOLDERS.map((f) => [f.id, f])
);

export const topicsMap = new SvelteMap<string, Topic>(
	DEFAULT_TOPICS.map((t) => [t.id, t])
);

export const notesMap = new SvelteMap<string, Note>(
	DEFAULT_NOTES.map((n) => [n.id, n])
);

// ─── Autosave setting ─────────────────────────────────────────────
// Class instance pattern — required in .svelte.ts modules because
// `export let x = $state(...)` with reassignment is not allowed by the
// Svelte 5 compiler when the binding crosses module boundaries.

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
		if (typeof localStorage !== 'undefined') {
			localStorage.setItem('bedroc_autosave_ms', String(ms));
		}
	}
}

export const autosave = new AutosaveStore();

// ─── Sort mode setting ─────────────────────────────────────────────
// PLACEHOLDER: persisted to localStorage only. Phase 5: server preferences.

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
		if (typeof localStorage !== 'undefined') {
			localStorage.setItem('bedroc_sort_mode', mode);
		}
	}
}

export const sortModeStore = new SortModeStore();

// ─── Folder mutations ─────────────────────────────────────────────

/** Create a new folder and return its UUID. */
export function createFolder(name: string, parentId: string | null = null): string {
	const id = crypto.randomUUID();
	const siblings = getFolders().filter((f) => f.parentId === parentId);
	const order = siblings.length > 0 ? Math.max(...siblings.map((f) => f.order)) + 1 : 0;
	foldersMap.set(id, { id, name, parentId, order, collapsed: false });
	return id;
}

/** Update an existing folder. */
export function saveFolder(folder: Folder) {
	foldersMap.set(folder.id, folder);
}

/** Toggle a folder's collapsed state. */
export function toggleFolderCollapsed(id: string) {
	const f = foldersMap.get(id);
	if (f) foldersMap.set(id, { ...f, collapsed: !f.collapsed });
}

/**
 * Delete a folder. Child folders are moved to the deleted folder's parent.
 * Topics inside the folder become unfiled.
 */
export function deleteFolder(id: string) {
	const folder = foldersMap.get(id);
	if (!folder) return;
	for (const [fid, f] of foldersMap) {
		if (f.parentId === id) foldersMap.set(fid, { ...f, parentId: folder.parentId });
	}
	for (const [tid, t] of topicsMap) {
		if (t.folderId === id) topicsMap.set(tid, { ...t, folderId: null });
	}
	foldersMap.delete(id);
}

/** Move a folder to a new parent and reorder. */
export function moveFolder(id: string, newParentId: string | null, afterId?: string) {
	const folder = foldersMap.get(id);
	if (!folder) return;
	const siblings = getFolders()
		.filter((f) => f.parentId === newParentId && f.id !== id)
		.sort((a, b) => a.order - b.order);
	const insertIdx = afterId ? siblings.findIndex((f) => f.id === afterId) + 1 : 0;
	siblings.splice(insertIdx, 0, { ...folder, parentId: newParentId });
	siblings.forEach((f, i) => foldersMap.set(f.id, { ...f, order: i }));
}

// ─── Topic mutations ──────────────────────────────────────────────

/** Create a new topic and return its UUID. */
export function createTopic(name: string, color: string, folderId: string | null = null): string {
	const id = crypto.randomUUID();
	const siblings = getTopics().filter((t) => t.folderId === folderId);
	const order = siblings.length > 0 ? Math.max(...siblings.map((t) => t.order)) + 1 : 0;
	topicsMap.set(id, { id, name, color, folderId, order });
	return id;
}

/** Update an existing topic. */
export function saveTopic(topic: Topic) {
	topicsMap.set(topic.id, topic);
}

/**
 * Delete a topic and unassign its notes.
 * PLACEHOLDER: no server call.
 */
export function deleteTopic(id: string) {
	topicsMap.delete(id);
	for (const [nid, note] of notesMap) {
		if (note.topicId === id) notesMap.set(nid, { ...note, topicId: null });
	}
}

/** Move a topic to a different folder and/or reorder it. */
export function moveTopic(id: string, newFolderId: string | null, afterId?: string) {
	const topic = topicsMap.get(id);
	if (!topic) return;
	const siblings = getTopics()
		.filter((t) => t.folderId === newFolderId && t.id !== id)
		.sort((a, b) => a.order - b.order);
	const insertIdx = afterId ? siblings.findIndex((t) => t.id === afterId) + 1 : 0;
	siblings.splice(insertIdx, 0, { ...topic, folderId: newFolderId });
	siblings.forEach((t, i) => topicsMap.set(t.id, { ...t, order: i }));
}

// ─── Note mutations ───────────────────────────────────────────────

/** Create a new note and return its UUID. */
export function createNote(topicId: string | null = null): string {
	const id = crypto.randomUUID();
	const siblings = [...notesMap.values()].filter(n => n.topicId === topicId);
	const nextOrder = siblings.length > 0 ? Math.max(...siblings.map(n => n.customOrder)) + 1 : 0;
	notesMap.set(id, {
		id,
		title: '',
		body: '',
		topicId,
		createdAt: Date.now(),
		updatedAt: Date.now(),
		customOrder: nextOrder,
	});
	return id;
}

/** Save (upsert) a note. PLACEHOLDER: no encryption or server call. */
export function saveNote(note: Note) {
	notesMap.set(note.id, { ...note, updatedAt: Date.now() });
}

/** Soft-delete a note. PLACEHOLDER: no server call. */
export function deleteNote(id: string) {
	notesMap.delete(id);
}

/**
 * Reorder a note in custom sort mode.
 * Moves `id` to appear after `afterId` within its topic group.
 * If afterId is null, moves the note to the top.
 */
export function reorderNote(id: string, afterId: string | null) {
	const note = notesMap.get(id);
	if (!note) return;
	const siblings = [...notesMap.values()]
		.filter(n => n.topicId === note.topicId && n.id !== id)
		.sort((a, b) => a.customOrder - b.customOrder);
	const insertIdx = afterId ? siblings.findIndex(n => n.id === afterId) + 1 : 0;
	siblings.splice(insertIdx, 0, { ...note });
	siblings.forEach((n, i) => notesMap.set(n.id, { ...n, customOrder: i }));
}

// ─── Derived helpers ──────────────────────────────────────────────

/** All folders sorted by order within each parent group. */
export function getFolders(): Folder[] {
	return [...foldersMap.values()].sort((a, b) => a.order - b.order);
}

/** All topics sorted by order within each folder group. */
export function getTopics(): Topic[] {
	return [...topicsMap.values()].sort((a, b) => a.order - b.order);
}

/**
 * All notes, sorted by the active sort mode.
 *  - 'recent'  → newest updatedAt first (default)
 *  - 'alpha'   → title A→Z (case-insensitive)
 *  - 'custom'  → customOrder ascending within each topic group
 */
export function getNotes(mode: SortMode = 'recent'): Note[] {
	const all = [...notesMap.values()];
	switch (mode) {
		case 'alpha':
			return all.sort((a, b) => a.title.localeCompare(b.title, undefined, { sensitivity: 'base' }));
		case 'custom':
			return all.sort((a, b) => a.customOrder - b.customOrder);
		case 'recent':
		default:
			return all.sort((a, b) => b.updatedAt - a.updatedAt);
	}
}

/** Notes filtered by topic (null = uncategorised). */
export function getNotesByTopic(topicId: string | null, mode: SortMode = 'recent'): Note[] {
	return getNotes(mode).filter((n) => n.topicId === topicId);
}

/** Format a Unix ms timestamp as a human-readable relative string. */
export function relativeTime(ms: number): string {
	const diff = Date.now() - ms;
	if (diff < 60_000)    return 'just now';
	if (diff < 3600_000)  return `${Math.floor(diff / 60_000)}m ago`;
	if (diff < 86400_000) return `${Math.floor(diff / 3600_000)}h ago`;
	if (diff < 604800_000) return `${Math.floor(diff / 86400_000)}d ago`;
	return new Date(ms).toLocaleDateString();
}
