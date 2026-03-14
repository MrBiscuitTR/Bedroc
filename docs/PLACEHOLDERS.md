# Bedroc — Placeholder Tracker

Every item marked as a placeholder in the codebase. Update this file when a placeholder is replaced with real logic.

---

## Phase 1 — Auth & Encryption ✅ COMPLETE

All Phase 1 placeholders have been replaced. See `lib/crypto/`, `lib/stores/auth.svelte.ts`.

| File | Status | Implementation |
| --- | --- | --- |
| `routes/login/+page.svelte` | ✅ Done | Real SRP-6a login via `lib/stores/auth.svelte.ts` |
| `routes/login/+page.svelte` | ✅ Done | Saved-server list with Bitwarden-style switcher |
| `routes/register/+page.svelte` | ✅ Done | SRP verifier + DEK generation via `lib/crypto/` |
| `routes/register/+page.svelte` | ✅ Done | Naive strength heuristic kept (zxcvbn deferred) |
| `lib/crypto/keys.ts` | ✅ Done | PBKDF2 (600k iterations) master key + AES-256-GCM DEK wrap/unwrap |
| `lib/crypto/srp.ts` | ✅ Done | SRP-6a client (3072-bit MODP, pure BigInt, no external libraries) |
| `lib/crypto/encrypt.ts` | ✅ Done | AES-256-GCM per-field encryption for note title + body |
| `lib/db/indexeddb.ts` | ✅ Done | Full offline-first IndexedDB layer with sync queue + conflicts store (v2) |

---

## Phase 2 — Notes CRUD ✅ COMPLETE

| File | Status | Implementation |
| --- | --- | --- |
| `lib/stores/notes.svelte.ts` | ✅ Done | IndexedDB primary store; server sync target; no demo data |
| `lib/stores/notes.svelte.ts` | ✅ Done | `saveNote()` — encrypt → IndexedDB → syncQueue → server PUT |
| `lib/stores/notes.svelte.ts` | ✅ Done | `deleteNote()` — IndexedDB soft-delete → server DELETE |
| `lib/stores/notes.svelte.ts` | ✅ Done | Topics + folders: IndexedDB + server sync |
| `lib/stores/notes.svelte.ts` | ✅ Done | `reorderNote()` — syncs order to server |
| `routes/note/[id]/+page.svelte` | ✅ Done | `doSave()` is async; calls real `saveNote()` (encrypt + IndexedDB + server) |
| `routes/note/[id]/+page.svelte` | ✅ Done | `handleDelete()` is async; calls real `deleteNote()` |
| `routes/+layout.svelte` | ✅ Done | Auth guard: `restoreSession()` on mount, redirect to /login if not authed |

---

## Phase 3 — Real-time Sync ✅ COMPLETE

| File | Status | Implementation |
| --- | --- | --- |
| `lib/stores/notes.svelte.ts` | ✅ Done | WebSocket integration via `lib/sync/websocket.ts`; connect/disconnect wired in `+layout.svelte` |
| `lib/sync/websocket.ts` | ✅ Done | WebSocket client with auto-reconnect, exponential backoff, 30s keepalive ping |
| `routes/+layout.svelte` | ✅ Done | `wsConnect()` + immediate `syncFromServer()` called when `auth.isLoggedIn && auth.dek` become true |
| `lib/stores/notes.svelte.ts` | ✅ Done | Conflict detection in `syncFromServer()` — preserves local edits, stores both versions, never silently overwrites |
| `lib/stores/notes.svelte.ts` | ✅ Done | `resolveConflict()` — user resolves with local/server/custom merge; pushes resolved version to server |
| `routes/note/[id]/+page.svelte` | ✅ Done | Conflict resolution UI — banner + full diff view showing both versions side-by-side |
| `lib/stores/notes.svelte.ts` | ✅ Done | `externalUpdates` SvelteMap — signals real-time updates to open editors; `liveSyncStore` toggle |
| `routes/note/[id]/+page.svelte` | ✅ Done | Real-time editor sync: applies incoming updates cursor-preservingly (character-offset save/restore); shows banner if unsaved changes |
| `routes/settings/+page.svelte` | ✅ Done | "Live editor sync" toggle (default on) |

---

## Phase 4 — Offline / Service Worker ✅ COMPLETE

| File | Status | Implementation |
| --- | --- | --- |
| `static/sw.js` | ✅ Done | Service worker: cache-first for static assets, network-first with shell fallback for navigation, never caches API/WS |
| `routes/+layout.svelte` | ✅ Done | `navigator.serviceWorker.register('/sw.js')` on mount; works on iOS 11.3+, Android, all desktop browsers |

---

## Phase 5 — Settings / Security ✅ COMPLETE

| File | Status | Implementation |
| --- | --- | --- |
| `routes/settings/+page.svelte` | ✅ Done | Username shown from `auth.username` |
| `routes/settings/+page.svelte` | ✅ Done | Sessions list fetched from `GET /api/auth/sessions` |
| `routes/settings/+page.svelte` | ✅ Done | Revoke individual session — `DELETE /api/auth/sessions/:id` |
| `routes/settings/+page.svelte` | ✅ Done | Log out — clears DEK from memory, wipes IndexedDB, revokes token |
| `routes/settings/+page.svelte` | ✅ Done | Delete account — `DELETE /api/auth/account` + clear all local data |
| `routes/settings/+page.svelte` | ✅ Done | Change password — re-derives master key, re-encrypts DEK, new SRP verifier |
| `routes/settings/+page.svelte` | ✅ Done | Export notes — decrypts all notes, downloads as categorised JSON |
| `lib/stores/notes.svelte.ts` | Deferred | `autosave.interval` persisted to `localStorage` only — server-backed user preferences deferred to Phase 5b |

---

## Phase 6 — Editor Enhancements

| File | What is placeholder | Replace with |
| --- | --- | --- |
| `routes/note/[id]/+page.svelte` | Text formatting uses `document.execCommand` (deprecated) | Migrate to ProseMirror or custom contenteditable model in Phase 6 |
| `routes/note/[id]/+page.svelte` | Font color picker is a native `<input type="color">` | Custom color palette matching design system |
| `routes/note/[id]/+page.svelte` | Font size select is a plain `<select>` | Styled custom dropdown |

---

## Notes on IDs

Note IDs are `crypto.randomUUID()` — generated client-side at creation time. They are random UUIDs (e.g. `f47ac10b-58cc-4372-a567-0e02b2c3d479`), not sequential integers. The URL for a note is `/note/<uuid>`.

Topic and Folder IDs are also `crypto.randomUUID()`.

**SSR note:** Demo data uses static hardcoded UUID-format strings (e.g. `a1000000-0000-0000-0000-000000000001`) rather than calling `crypto.randomUUID()` at module evaluation time, because the SvelteKit SSR process (Node.js) does not have `crypto` available in the same way and would throw a 500 error on page load. Real notes created at runtime use `crypto.randomUUID()` inside event handlers, which is safe.

When the backend is integrated (Phase 2), the server will accept and store the client-generated UUID as the note's primary key. The server does not generate note IDs.
