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
| `lib/db/indexeddb.ts` | ✅ Done | Full offline-first IndexedDB layer with sync queue |

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
