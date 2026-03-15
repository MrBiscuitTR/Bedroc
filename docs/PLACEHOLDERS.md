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

## Phase 6 — Editor Enhancements ✅ COMPLETE

| File | Status | Notes |
| --- | --- | --- |
| `routes/note/[id]/+page.svelte` | ✅ Done | `document.execCommand` replaced with TipTap (ProseMirror). Extensions: StarterKit, Underline, TextStyle, Color, FontSize, TextAlign, Subscript, Superscript, Link, Table, Image, Placeholder, Highlight, Typography, TaskList, TaskItem, CharacterCount. |
| `routes/note/[id]/+page.svelte` | ✅ Done | Font color picker: custom swatch panel + native `<input type="color">` fallback; color-at-cursor reads from `editor.getAttributes('textStyle').color`; preview swatch updates in real time. |
| `routes/note/[id]/+page.svelte` | ✅ Done | Font size: dropdown with preset sizes; value stored as `"16px"` (with unit) via FontSize extension; display strips unit with `.replace('px','')` to avoid double-unit bug. |
| `routes/note/[id]/+page.svelte` | ✅ Done | Word/char count footer via CharacterCount extension — updates in real time, also updated on external sync. |
| `routes/note/[id]/+page.svelte` | ✅ Done | Tables: insert 3×3 table, add/delete row/column, delete table. Contextual table toolbar appears only when cursor is inside a table. |
| `routes/note/[id]/+page.svelte` | ✅ Done | Images: upload from device → base64 data URI stored in note HTML (no server upload, fully private, encrypted with rest of note). |
| `routes/note/[id]/+page.svelte` | ✅ Done | Task lists: checkboxes with nested support; completed items struck through via CSS. |
| `routes/note/[id]/+page.svelte` | ✅ Done | Highlights: multi-color highlight via `<mark>` with `data-color`. |
| `routes/note/[id]/+page.svelte` | ✅ Done | Link dialog: inline URL input; Enter or Apply inserts link; clicking button again on a link removes it. |
| `routes/note/[id]/+page.svelte` | ✅ Done | Typography: smart quotes, em-dashes, ellipsis auto-substitution. |
| `routes/note/[id]/+page.svelte` | ✅ Done | Headings H1–H4 via dropdown; Code, Blockquote, Code block via toolbar buttons. |

### Current note storage format

Notes are stored as **semantic HTML** output by TipTap/ProseMirror. The decrypted `body` field is an HTML string such as:

```html
<h2>My heading</h2>
<p>Hello <span style="font-size:24px;color:#6b8afd;">world</span>, this is a <strong>note</strong>.</p>
<ul data-type="taskList"><li data-checked="true"><p>Done item</p></li></ul>
<table><tbody><tr><th><p>Cell</p></th></tr></tbody></table>
<img src="attachment:a3f1..." style="width:400px">
<div data-file-attachment data-hash="b2e4..." data-file-name="report.pdf" ...></div>
```

This is clean ProseMirror HTML — semantic tags (`<strong>`, `<em>`, `<h1>`–`<h4>`, `<mark>`, `<table>`, task list `<ul>`) with inline styles only for font-size and color overrides. It is backward-compatible with notes written before the TipTap migration (old `<b>`/`<span>` execCommand HTML renders fine in ProseMirror).

Images use `attachment:<sha256-hex>` placeholders in the `src` attribute. File cards use a custom `<div data-file-attachment>` node serialised by TipTap. Both are restored to their data URIs before the editor renders them.

---

## Phase 7 — Attachment sync ✅ COMPLETE

| File | Status | Notes |
| --- | --- | --- |
| `lib/attachments.ts` | ✅ Done | `extractAttachments()`: extracts `data:` URIs from HTML, encrypts with DEK (AES-256-GCM), stores in IndexedDB, uploads to server, replaces with `attachment:<hash>` placeholder. |
| `lib/attachments.ts` | ✅ Done | `rehydrateAttachments()`: replaces placeholders with decrypted data URIs. If hash is missing from IndexedDB, fetches encrypted blob from server (cross-device sync), caches locally, then decrypts. |
| `lib/attachments.ts` | ✅ Done | `uploadFileAttachment()`: used by file/image upload in editor. Encrypts immediately, stores in IndexedDB, fires background upload to server. |
| `lib/attachments.ts` | ✅ Done | `loadFileAttachment()`: used by download/preview buttons. Decrypts from IndexedDB; falls back to server fetch if not cached locally. |
| `lib/db/indexeddb.ts` | ✅ Done | `attachments` object store (DB v3): keyed by `hash`, stores `enc:<JSON>` ciphertext. |
| `server/src/db/migrations/004_attachments.sql` | ✅ Done | `attachments` table: `(hash TEXT, user_id UUID)` primary key; stores `encrypted_data TEXT`, `mime_type`, `size_bytes`. |
| `server/src/db/queries/attachments.ts` | ✅ Done | `upsertAttachment`, `getAttachment`, `getExistingHashes`, `deleteAttachment`, `deleteAllAttachments`. |
| `server/src/routes/attachments.ts` | ✅ Done | `POST /api/attachments/check`, `PUT /api/attachments/:hash`, `GET /api/attachments/:hash`, `DELETE /api/attachments/:hash`. |
| `routes/note/[id]/+page.svelte` | ✅ Done | File attachment card: custom TipTap node (`fileAttachment`), download button, preview trigger (PDF/text/code). |
| `routes/note/[id]/+page.svelte` | ✅ Done | Image resize: drag handle on selected image; persists `style="width:Xpx"` into TipTap node attributes. |
| `routes/note/[id]/+page.svelte` | ✅ Done | File preview modal: PDF shown via `<iframe>`, text/code shown in scrollable `<pre>`. Triggered by clicking file icon or name for previewable types. |

### Attachment sync design

- **Content-addressed**: SHA-256 of the **plaintext** data URI is the key. Same file on any device → same hash → single server record.
- **Upload: once only**: the server `PUT /api/attachments/:hash` uses `ON CONFLICT DO NOTHING`. Normal note saves never re-upload attachment blobs — only the tiny placeholder text travels with the note body.
- **Cross-device**: when `rehydrateAttachments()` finds a hash not in local IndexedDB, it calls `GET /api/attachments/:hash`, caches the encrypted blob in IndexedDB, then decrypts it. Subsequent loads are fully offline.
- **Deletion**: server attachment records are deleted only when the user explicitly calls `DELETE /api/attachments/:hash` (e.g. when removing a file card). Account deletion cascades via `ON DELETE CASCADE` on `user_id`.
- **Encryption**: everything stored on the server is `enc:<JSON {iv,ct}>` (AES-256-GCM with the user's DEK). The server never sees plaintext. If the vault is locked, placeholders remain in the editor.
- **Bandwidth**: large binary blobs only travel once (upload) or on first cross-device access (download). Regular autosaves only carry the placeholder text.

---

## Appearance / theming

| File | Status | Notes |
| --- | --- | --- |
| `lib/stores/theme.svelte.ts` | ✅ Done | Dark/light theme toggle; persisted to localStorage; `data-theme` attribute on `<html>`; flash-free via inline script in `app.html`. |

---

## Notes on IDs

Note IDs are `crypto.randomUUID()` — generated client-side at creation time. They are random UUIDs (e.g. `f47ac10b-58cc-4372-a567-0e02b2c3d479`), not sequential integers. The URL for a note is `/note/<uuid>`.

Topic and Folder IDs are also `crypto.randomUUID()`.

**SSR note:** Demo data uses static hardcoded UUID-format strings (e.g. `a1000000-0000-0000-0000-000000000001`) rather than calling `crypto.randomUUID()` at module evaluation time, because the SvelteKit SSR process (Node.js) does not have `crypto` available in the same way and would throw a 500 error on page load. Real notes created at runtime use `crypto.randomUUID()` inside event handlers, which is safe.

When the backend is integrated (Phase 2), the server will accept and store the client-generated UUID as the note's primary key. The server does not generate note IDs.
