# Frontend Shell — Documentation

Phase 0 of the Bedroc frontend. This phase establishes the full visual shell with no backend or crypto logic. All data shown is placeholder and will be replaced in Phase 1 and 2.

---

## Stack

| Item | Version | Purpose |
| --- | --- | --- |
| SvelteKit | 2.x | Full-stack web framework (routing, SSR/SPA) |
| Svelte | 5.x | UI component compiler (runes API used throughout) |
| TypeScript | 5.x | Type safety |
| Tailwind CSS | 4.x | Utility classes; also used via `@tailwindcss/vite` plugin |
| Vite | 7.x | Dev server and bundler |

Tailwind v4 does not require a `tailwind.config.ts` or `postcss.config.js`. It is wired directly into Vite via the `@tailwindcss/vite` plugin in [bedroc/vite.config.ts](../bedroc/vite.config.ts).

---

## File Map

```
bedroc/
├── src/
│   ├── app.html                         HTML shell, PWA meta, iOS fixes
│   ├── app.css                          Global styles, design tokens
│   ├── lib/
│   │   └── stores/
│   │       └── notes.svelte.ts          Reactive note/topic/folder store (in-memory, Phase 0)
│   └── routes/
│       ├── +layout.svelte               Root layout (sidebar, bottom nav, split-window)
│       ├── +page.svelte                 Notes list with folder/topic panel and drag-and-drop
│       ├── login/+page.svelte           Login page
│       ├── register/+page.svelte        Register page
│       ├── note/[id]/+page.svelte       Note editor with rich text toolbar
│       └── settings/+page.svelte        Settings page
└── static/
    └── manifest.webmanifest             PWA manifest
```

---

## Design System

All colours are CSS custom properties defined in [bedroc/src/app.css](../bedroc/src/app.css) on `:root`. Tailwind utility classes are used for spacing and layout; colour and typography use the custom properties directly so they can be changed in one place.

### Colour tokens

| Token | Value | Usage |
| --- | --- | --- |
| `--bg` | `#0f1117` | Page background |
| `--bg-elevated` | `#16181f` | Cards, sidebar, panels |
| `--bg-hover` | `#1e2028` | Hover states |
| `--border` | `#2a2d37` | All borders |
| `--text` | `#e2e4ed` | Primary text |
| `--text-muted` | `#8b8fa8` | Secondary text, labels |
| `--text-faint` | `#4a4d5e` | Placeholders, disabled |
| `--accent` | `#6b8afd` | Actions, links, focus rings |
| `--accent-dim` | `#3d5299` | Accent hover/pressed |
| `--danger` | `#e05c5c` | Destructive actions |
| `--success` | `#4caf87` | Confirmations |

### Typography

System font stack — no CDN, no external font requests:

```css
font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Helvetica Neue', Arial, sans-serif;
```

Base size: `14px`. All `input` and `textarea` elements use `font-size: 16px` to prevent iOS auto-zoom on focus.

### Spacing and radius tokens

| Token | Value | Usage |
| --- | --- | --- |
| `--sidebar-w` | `240px` | Desktop sidebar width |
| `--nav-h` | `56px` | Mobile header/bottom nav height |
| `--radius-sm` | `6px` | Inputs, buttons |
| `--radius-md` | `8px` | Cards |
| `--radius-lg` | `12px` | Modals (future) |

---

## Layout

### Desktop (≥ 768px)

Fixed 240px sidebar on the left with logo, nav links, "Split view" button, and user footer. Main content fills the rest. The mobile header and bottom nav are hidden via `display: none`.

**Split-window mode:** When split is active, the main content area splits into two panes separated by a draggable splitter. The primary pane renders `{@render children()}` (the current route). The secondary pane renders an `<iframe src={splitUrl}>` pointing to the same origin, giving it a completely independent navigation stack. Both panes share the same in-memory stores (and will share IndexedDB in Phase 2). Each pane has a minimum width of 20% (clamped), so neither pane can be fully hidden. A close button in the secondary pane's toolbar collapses it.

### Mobile (< 768px)

The sidebar is hidden. A fixed top header shows the current page title and a context action button (e.g. "New note" on the list page). A bottom nav bar with icon + label provides the same navigation as the desktop sidebar. Safe area inset padding is applied to the bottom nav for iOS home indicator clearance (`env(safe-area-inset-bottom)`).

Split-window is not shown on mobile — the "Split view" button is hidden at `< 768px`. iOS Split View (iPad's native feature) works naturally because both tabs load the same origin and share IndexedDB.

### Auth pages

`/login` and `/register` bypass the app shell entirely. The root layout detects these routes and renders a bare centred card instead.

---

## Notes / Topics / Folders Store (`notes.svelte.ts`)

Reactive state is held in three `SvelteMap` instances:

| Map | Key | Value type |
| --- | --- | --- |
| `notesMap` | note UUID | `Note` |
| `topicsMap` | topic UUID | `Topic` |
| `foldersMap` | folder UUID | `Folder` |

### Types

```typescript
interface Folder {
  id: string;
  name: string;
  parentId: string | null;   // null = root level
  order: number;             // ascending, lower = higher in list
  collapsed: boolean;
}

interface Topic {
  id: string;
  name: string;
  color: string;             // any valid CSS color
  folderId: string | null;   // null = unfiled
  order: number;             // ascending within folder group
}

interface Note {
  id: string;
  title: string;
  body: string;              // raw HTML from contenteditable
  topicId: string | null;
  createdAt: number;         // Unix ms
  updatedAt: number;         // Unix ms
}
```

### Exported functions

| Function | Description |
| --- | --- |
| `createFolder(name, parentId?)` | Create folder, returns UUID |
| `saveFolder(folder)` | Upsert folder |
| `toggleFolderCollapsed(id)` | Toggle `.collapsed` field |
| `deleteFolder(id)` | Delete folder; child folders reparented to deleted folder's parent; topics inside become unfiled |
| `moveFolder(id, newParentId, afterId?)` | Move + reorder folder |
| `createTopic(name, color, folderId?)` | Create topic, returns UUID |
| `saveTopic(topic)` | Upsert topic |
| `deleteTopic(id)` | Delete topic; notes assigned to it become uncategorised |
| `moveTopic(id, newFolderId, afterId?)` | Move + reorder topic |
| `createNote(topicId?)` | Create note, returns UUID |
| `saveNote(note)` | Upsert note, bumps `updatedAt` |
| `deleteNote(id)` | Remove note |
| `getFolders()` | All folders sorted by `order` |
| `getTopics()` | All topics sorted by `order` |
| `getNotes()` | All notes sorted by `updatedAt` descending |
| `getNotesByTopic(topicId)` | Notes for a single topic |
| `relativeTime(ms)` | Human-readable relative timestamp |

### Autosave store

```typescript
autosave.interval   // number — ms; 0 = disabled
autosave.set(ms)    // update + persist to localStorage
```

Persisted to `localStorage` under key `bedroc_autosave_ms`. Uses the class-instance pattern (not `export let`) because Svelte 5 forbids exporting reassignable `$state` from `.svelte.ts` modules (`state_invalid_export` compiler error).

---

## Routes

### `/` — Notes list ([+page.svelte](../bedroc/src/routes/+page.svelte))

**Left panel (180px, hidden on mobile < 900px):**

- "All notes" entry (shows total count).
- "Uncategorised" entry (notes with `topicId === null`).
- Folders (collapsible, unlimited nesting depth):
  - Chevron to toggle collapse; clicking folder name filters notes to all topics inside it.
  - "+" button on hover to add a topic directly inside the folder.
  - Three-dot menu: rename folder, add sub-folder, delete folder.
  - Child folders rendered recursively via a Svelte 5 `{#snippet folderRow(folder, depth)}` that calls `{@render folderRow(child, depth+1)}`.
- Topics (with colored dot and note count):
  - Shown either under their parent folder or in the unfiled section.
  - Edit button on hover opens the topic editor modal.
  - Folder create/edit modal: name input + parent folder select.
  - Topic editor modal: name, 8 preset color swatches + native color picker, folder assignment.

**Drag-and-drop:**

- Notes can be dragged from the note list onto a topic row to recategorise them.
- Topics can be dragged to reorder within a folder or move between folders.
- Folders can be dragged to reorder within the same parent level.
- Desktop: standard HTML5 Drag and Drop API (`draggable`, `ondragstart`, `ondragover`, `ondrop`).
- Mobile: long-press (500ms `setTimeout`) initiates drag; `ontouchmove` / `ontouchend` cancel or commit. Visual `.drag-active` class added during drag to provide feedback.
- All drop results call the appropriate store mutation (`moveFolder`, `moveTopic`, `saveNote`) which currently writes to in-memory maps only (placeholder — see PLACEHOLDERS.md).

**Right panel:**

- Header with section title and "New note" button.
- Search input filtering notes by title and stripped body text.
- Note cards: topic badge (colored), title, relative timestamp, 2-line body preview.
- Empty state shown when no notes match filter or topic.

### `/login` — Login ([login/+page.svelte](../bedroc/src/routes/login/+page.svelte))

- Username and password fields.
- Password show/hide toggle.
- Server URL row: collapsed by default showing the current URL. Expands on click to a text input with a Save button. Defaults to `https://api.bedroc.app`. Saved to `localStorage` under the key `bedroc_server`.
- Form submission is a no-op placeholder — wired to auth logic in Phase 1.

### `/register` — Register ([register/+page.svelte](../bedroc/src/routes/register/+page.svelte))

- Username, password, confirm password fields.
- Password strength bar (4 segments, colour-coded) using a naive heuristic. Will be replaced by `zxcvbn` in Phase 1.
- Confirm password field turns red on mismatch, green on match.
- Server URL row — identical to login page.
- E2EE notice: informs the user that their password cannot be recovered and they should use a password manager.
- Form submission is a no-op placeholder.

### `/note/[id]` — Note editor ([note/[id]/+page.svelte](../bedroc/src/routes/note/%5Bid%5D/+page.svelte))

- Top toolbar: back button, blue dot indicator for unsaved changes, Save button (disabled when clean), delete button with inline confirm step.
- Title input: borderless, 20px, fills the full width.
- Formatting toolbar (scrollable horizontally on narrow viewports):
  - Undo / Redo
  - Bold, Italic, Strikethrough — toggle buttons with active highlight (via `document.queryCommandState`)
  - Bullet list, Numbered list — toggle buttons
  - Font size select (Small 12px / Normal 15px / Large 20px / Heading 26px) — implemented via `execCommand('fontSize', '7')` then replacing the generated `<font>` tag with a styled `<span>`
  - Text color: 8 preset swatches + native color input, shown in a floating panel
- Body: `contenteditable` div, renders HTML from `execCommand`. Fills remaining height. Scrollable with `overscroll-behavior: contain`.
- Autosave: after `autosave.interval` ms of inactivity (from store, default 1000ms, 0 = off). New notes get a UUID and navigate to `/note/<uuid>` on first save.
- `id === 'new'` creates a new note on first save; navigates to its UUID with `replaceState`.
- All save/delete/load logic is a placeholder — wired in Phase 2.
- PLACEHOLDER: `document.execCommand` is deprecated. Will be replaced by ProseMirror in Phase 6.

### `/settings` — Settings ([settings/+page.svelte](../bedroc/src/routes/settings/+page.svelte))

- Account section: username and server URL (read-only display).
- Editor section: autosave toggle (on/off), autosave interval input (seconds, min 0.5s). Writes to `autosave` store and persists to `localStorage` under `bedroc_autosave_ms`.
- Security section: change password and export notes buttons (no-op placeholders).
- Sessions section: placeholder list of active sessions with a revoke button per session.
- Danger zone: log out and delete account, each with an inline confirm step before the destructive action is enabled.
- Version string at the bottom.

---

## Split-Window

The split-window feature allows two independent app panes side by side on desktop.

**Activation:** "Split view" button in the desktop sidebar. Clicking it sets `splitActive = true` and opens a second pane navigated to `/`.

**Structure:**

```text
┌─────────────────────────────────────────────────────────┐
│ Sidebar │  Primary pane         │ ▌ │  Secondary pane   │
│  240px  │  ({@render children}) │   │  (<iframe src=/>) │
│         │  (100-splitWidth)%    │   │  splitWidth%      │
└─────────────────────────────────────────────────────────┘
```

**Splitter:** 4px wide div between the panes. `onpointerdown` + `setPointerCapture` enables cross-device (mouse and touch) drag. Container `onpointermove` recalculates `splitWidth` as a percentage. Width is clamped so each pane stays at minimum 20% and maximum 80%.

**Secondary pane navigation:** The iframe's `src` tracks the `splitUrl` state variable. Closing the split via the ✕ button sets `splitActive = false`.

**Session isolation:** The iframe is same-origin, so it has its own JavaScript context, own component instances, and own navigation history stack. Both panes share the same in-memory Svelte stores in Phase 0 because they are imported at the module level in the same page load. With IndexedDB in Phase 2, both panes will share the same database naturally via the same-origin policy — changes written by one pane are visible to the other on next read.

**iOS Split View compatibility:** Apple's native iPad Split View opens two independent browser tabs. Since both point to the same origin, they share IndexedDB (Phase 2). No extra wiring is needed for this use case.

---

## PWA

### [app.html](../bedroc/src/app.html)

- `viewport-fit=cover` for edge-to-edge layout on iOS notch/dynamic island devices.
- `apple-mobile-web-app-capable` and related meta tags for home screen installation.
- `theme-color: #0f1117` for Android status bar and browser chrome.
- `format-detection: telephone=no` to prevent phone number linkification.
- Links to `manifest.webmanifest` and Apple touch icon.

### [manifest.webmanifest](../bedroc/static/manifest.webmanifest)

- `display: standalone` — no browser chrome when launched from home screen.
- `orientation: any` — supports portrait and landscape.
- Background and theme colour match `--bg`.
- Icon slots for 72, 96, 128, 144, 152, 192, 384, 512px. Actual PNG files to be created and placed in `static/icons/`.

---

## iOS-Specific Behaviour

| Issue | Fix |
| --- | --- |
| Text field zoom on focus | All inputs/textareas use `font-size: 16px` |
| Rubberbanding / full-page scroll | `position: fixed; overflow: hidden` on `body` + `overscroll-behavior: none` on `html` and `.app-shell`; only scrollable regions use `overscroll-behavior: contain` |
| Status bar / Dynamic Island overlap | Mobile header uses `padding-top: env(safe-area-inset-top)` and `align-items: flex-end` so content sits below the status bar |
| Home indicator clearance | `padding-bottom: env(safe-area-inset-bottom)` on bottom nav |
| Landscape font scaling | `-webkit-text-size-adjust: 100%` on `html` |
| Container scroll when keyboard opens | App shell uses `height: 100dvh; overflow: hidden`; only `.main-content` and `.body-editor` scroll |
| iPad notch in landscape (sidebar) | Sidebar logo uses `padding-top: max(20px, env(safe-area-inset-top))` |

---

## Running Locally

```bash
cd bedroc
npm run dev
```

Open `http://localhost:5173`. All routes are accessible without authentication during the shell phase.

To type-check without running the dev server:

```bash
npm run check
```

Expected output: `0 ERRORS 0 WARNINGS`.

---

## What Is Not Implemented Yet

Everything in this phase is visual only. The following will be added in later phases:

- Authentication (Phase 1)
- Encryption / key derivation (Phase 1)
- Real note data from IndexedDB and server (Phase 2)
- Real-time sync via WebSocket (Phase 3)
- Service worker and offline support (Phase 4)
- Security hardening, CSRF, rate limiting (Phase 5)
- Export and password change (Phase 6)
- Docker and self-hosting (Phase 7)
