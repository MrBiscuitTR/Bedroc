# Bedroc — Placeholder Tracker

Every item marked as a placeholder in the codebase. Update this file when a placeholder is replaced with real logic.

---

## Phase 1 — Auth & Encryption

| File | What is placeholder | Replace with |
| --- | --- | --- |
| `routes/login/+page.svelte` | `handleSubmit` is a no-op | SRP login flow (`lib/crypto/srp.ts`) |
| `routes/login/+page.svelte` | `serverUrl` read from localStorage with hardcoded default | `lib/stores/auth.ts` server URL store |
| `routes/register/+page.svelte` | `handleSubmit` is a no-op | SRP registration flow |
| `routes/register/+page.svelte` | Password strength uses naive heuristic (length + character class checks) | `zxcvbn` entropy scorer |
| `routes/register/+page.svelte` | `serverUrl` read from localStorage with hardcoded default | `lib/stores/auth.ts` server URL store |

---

## Phase 2 — Notes CRUD

| File | What is placeholder | Replace with |
| --- | --- | --- |
| `lib/stores/notes.svelte.ts` | In-memory `notesMap` / `topicsMap` / `foldersMap` with hardcoded demo data | IndexedDB as primary store; server as sync target |
| `lib/stores/notes.svelte.ts` | `saveNote()` / `deleteNote()` mutate in-memory map only | IndexedDB write + sync queue entry + server push when online |
| `lib/stores/notes.svelte.ts` | `saveTopic()` / `deleteTopic()` mutate in-memory map only | IndexedDB write + sync queue entry |
| `lib/stores/notes.svelte.ts` | `saveFolder()` / `deleteFolder()` mutate in-memory map only | IndexedDB write + sync queue entry |
| `lib/stores/notes.svelte.ts` | `autosave.interval` persisted to `localStorage` only | Move to server-backed user preferences in Phase 5 |
| `lib/stores/notes.svelte.ts` | Demo data uses static hardcoded UUIDs (e.g. `a1000000-...`) to avoid SSR crash from `crypto.randomUUID()` | Remove demo data entirely; load from IndexedDB on boot |
| `routes/note/[id]/+page.svelte` | Note loaded from in-memory `notesMap` (no decryption) | Read from IndexedDB → DEK from auth store → AES-GCM decrypt note body |
| `routes/note/[id]/+page.svelte` | `doSave()` writes to in-memory `notesMap` only | AES-GCM encrypt → write to IndexedDB → queue server PUT |
| `routes/note/[id]/+page.svelte` | `handleDelete()` removes from in-memory `notesMap` only | IndexedDB removal + server DELETE (or soft-delete queue) |
| `routes/note/[id]/+page.svelte` | Rich text body stored as plaintext HTML in memory | Encrypted HTML blob via AES-GCM before writing to IndexedDB/server |
| `routes/+page.svelte` | Drag-and-drop reordering / folder assignment writes to in-memory maps only | `saveFolder()` / `saveTopic()` must queue sync after every drag-drop commit |

---

## Phase 3 — Real-time Sync

| File | What is placeholder | Replace with |
| --- | --- | --- |
| `lib/stores/notes.svelte.ts` | No WebSocket integration | Connect to `lib/sync/websocket.ts` on login |
| `routes/+layout.svelte` | Split-window secondary pane is an `<iframe>` sharing in-memory stores via same-origin | With IndexedDB as the source of truth, the iframe naturally shares the same DB; no extra wiring needed |

---

## Phase 4 — Offline / Service Worker

| File | What is placeholder | Replace with |
| --- | --- | --- |
| (none yet) | No service worker | `static/sw.js` — cache shell + static assets; serve IndexedDB data when offline |

---

## Phase 5 — Settings / Security

| File | What is placeholder | Replace with |
| --- | --- | --- |
| `routes/settings/+page.svelte` | Username shown as static string "username" | Read from auth store |
| `routes/settings/+page.svelte` | Sessions list is hardcoded demo array | Fetch from `GET /api/auth/sessions` |
| `routes/settings/+page.svelte` | Revoke button is a no-op | `DELETE /api/auth/sessions/:id` |
| `routes/settings/+page.svelte` | Log out button is a no-op | Clear DEK from memory, clear IndexedDB, revoke token |
| `routes/settings/+page.svelte` | Delete account button is a no-op | `DELETE /api/auth/account` + clear all local data |
| `routes/settings/+page.svelte` | Change password button is a no-op | Re-derive Master Key, re-encrypt DEK, update server |
| `routes/settings/+page.svelte` | Export notes button is a no-op | Decrypt all notes → JSON download with warning modal |
| `lib/stores/notes.svelte.ts` | `autosave.interval` persisted to `localStorage` only | Server-backed user preferences |

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
