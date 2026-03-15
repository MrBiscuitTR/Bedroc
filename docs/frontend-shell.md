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

```text
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
| `--sidebar-w` | `200px` | Desktop sidebar width |
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

The sidebar is hidden. A top header (`min-height: --nav-h`, grows to accommodate safe-area-inset-top on notch devices) shows the current page title and a context action button (e.g. "New note" on the list page). A bottom nav bar with icon + label provides the same navigation as the desktop sidebar. Safe area inset padding is applied to the bottom nav for iOS home indicator clearance (`env(safe-area-inset-bottom, 0px)`).

The global mobile header is **hidden entirely on the `/note/*` route** (`{#if !isNoteRoute}`) because the note editor has its own full-width toolbar that occupies the same visual space with the same fixed height.

**Notes list mobile drawer:** The left topics panel (hidden at `< 900px`) becomes a slide-in drawer toggled by a hamburger button in the notes list header. Tapping a topic or folder closes the drawer and filters the note list. A backdrop tap also closes it.

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
  customOrder: number;       // position in custom sort order within topic group
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
| `createNote(topicId?)` | Create note, assigns `customOrder` as max+1 within topic group, returns UUID |
| `saveNote(note)` | Upsert note, bumps `updatedAt` |
| `deleteNote(id)` | Remove note |
| `reorderNote(id, afterId)` | Move note after `afterId` in custom sort order (same topic group); `afterId = null` moves to top |
| `getFolders()` | All folders sorted by `order` |
| `getTopics()` | All topics sorted by `order` |
| `getNotes(mode?)` | All notes sorted by `mode`: `'recent'` (default, `updatedAt` desc), `'alpha'` (title A→Z), `'custom'` (`customOrder` asc) |
| `getNotesByTopic(topicId, mode?)` | Notes for a single topic, same sort modes |
| `relativeTime(ms)` | Human-readable relative timestamp |

### Autosave store

```typescript
autosave.interval   // number — ms; 0 = disabled
autosave.set(ms)    // update + persist to localStorage
```

Persisted to `localStorage` under key `bedroc_autosave_ms`. Uses the class-instance pattern (not `export let`) because Svelte 5 forbids exporting reassignable `$state` from `.svelte.ts` modules (`state_invalid_export` compiler error).

### Sort mode store

```typescript
type SortMode = 'recent' | 'alpha' | 'custom';

sortModeStore.value       // SortMode — current active sort
sortModeStore.set(mode)   // update + persist to localStorage
```

Persisted to `localStorage` under key `bedroc_sort_mode`. Same class-instance pattern as `autosave`. Defaults to `'recent'` if no value is stored.

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

- Header with section title, sort controls, and "New note" button.
- Sort controls: three icon buttons grouped together — clock icon (`recent`, last modified), A→Z icon (`alpha`, alphabetical by title), reorder icon (`custom`, drag-to-reorder). Active mode has accent background. Persisted across sessions.
- When `custom` sort is active, a "Drag notes to reorder" hint appears and note cards become individually draggable within their topic group.
- Search input filtering notes by title and stripped body text.
- Note cards: topic tag (colored dot + name), title, relative timestamp, 2-line body preview.
  - Notes without a topic show a grey dotted-border "Uncategorised" tag instead (`color: var(--text-faint); border-style: dashed`).
- Empty state shown when no notes match filter or topic.

**Title deduplication:**

No two notes in the same topic (or both uncategorised) may share the same title. When saving, `dedupTitle(base, topicId, ownId)` checks sibling notes and appends "(2)", "(3)", etc. if a collision exists. This also applies to the default `Untitled` title.

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

**Desktop:** Back button (←) in the toolbar navigates to `/`. Toolbar is always visible at the top.

**Mobile:** A drawer-toggle button (☰) replaces the "Edit note" text in the toolbar. Tapping it opens the notes side drawer (see below). The global mobile header is hidden on this route — the editor's own toolbar takes that role, matching `--nav-h` exactly.

**Editor library:** [TipTap](https://tiptap.dev/) (ProseMirror wrapper), MIT-licensed, fully bundled (no CDN), zero telemetry. The editor is instantiated in `onMount` with a plain `let editor: Editor | null = null` — **not** `$state` — because Svelte's reactive proxy breaks ProseMirror's internal state. A separate `editorReady = $state(false)` boolean is set to `true` after `new Editor(...)` returns, so `$effect` blocks that interact with the editor wait for it.

**Extensions loaded:**

| Extension | Package | Purpose |
| --- | --- | --- |
| StarterKit | `@tiptap/starter-kit` | Bold, italic, strike, code, blockquote, headings, lists, history, hard break, horizontal rule |
| Underline | `@tiptap/extension-underline` | `<u>` underline |
| TextStyle | `@tiptap/extension-text-style` | Base mark for inline CSS (required by Color + FontSize) |
| Color | `@tiptap/extension-text-style` | `color` CSS property on TextStyle mark |
| FontSize | `@tiptap/extension-text-style` | `font-size` CSS property on TextStyle mark; stored WITH unit (e.g. `"16px"`) |
| TextAlign | `@tiptap/extension-text-align` | Left / center / right / justify on headings and paragraphs |
| Subscript | `@tiptap/extension-subscript` | `<sub>` |
| Superscript | `@tiptap/extension-superscript` | `<sup>` |
| Highlight | `@tiptap/extension-highlight` | Multi-color `<mark>` highlight |
| Typography | `@tiptap/extension-typography` | Smart quotes, em-dashes, ellipsis substitution on typing |
| TaskList | `@tiptap/extension-task-list` | `<ul data-type="taskList">` |
| TaskItem | `@tiptap/extension-task-item` | Individual task items with nested support |
| CharacterCount | `@tiptap/extension-character-count` | Character + word count via `editor.storage.characterCount` |
| Link | `@tiptap/extension-link` | `<a>` with `openOnClick: false`; `rel="noopener noreferrer"` |
| Table | `@tiptap/extension-table` | Resizable table (named export, no default export) |
| TableRow | `@tiptap/extension-table` | Table rows (named export from same package) |
| TableHeader | `@tiptap/extension-table` | `<th>` cells |
| TableCell | `@tiptap/extension-table` | `<td>` cells |
| Image | `@tiptap/extension-image` | Inline images; `allowBase64: true` for device upload |
| Placeholder | `@tiptap/extension-placeholder` | "Start writing…" placeholder via CSS `::before` |

**Toolbar (scrollable horizontally on narrow viewports):**

- Back/drawer-toggle button (left), blue dot indicator for unsaved changes, Save button (disabled when clean), delete button with inline confirm step (right).
- Title input: borderless, 20px, fills the full width.
- **Text style row:** Undo / Redo | Bold, Italic, Underline, Strikethrough | Subscript, Superscript | Inline Code
- **Block row:** Heading dropdown (Paragraph / H1 / H2 / H3 / H4) | Bullet list, Ordered list, Task list | Blockquote, Code block
- **Format row:** Text align (left / center / right / justify) | Highlight color swatch + panel | Font color swatch + panel | Font size dropdown
- **Insert row:** Link button (opens inline URL dialog; clicking again on a link removes it) | Image button (opens file picker; uploaded as base64 data URI, no server upload) | Table insert button (inserts 3×3 table)
- **Table context row** (only visible when cursor is inside a table): Add row above / below, Delete row, Add column left / right, Delete column, Delete table

All toolbar buttons use `onmousedown` with `e.preventDefault()` to prevent the editor losing focus/selection.

**Format state tracking:** `updateFormatState()` is called on every `onUpdate`, `onSelectionUpdate`, and `onFocus` event. It reads active marks/nodes via `editor.isActive(...)` and `editor.getAttributes('textStyle')`:

- Color: `tsAttrs.color ?? ''`
- Font size: `(tsAttrs.fontSize ?? '').replace('px', '')` — strips the unit stored by FontSize extension to show a plain number in the dropdown

**Body:** TipTap mounts into `<div class="body-editor-wrap" bind:this={editorEl}>`. ProseMirror creates a `<div class="ProseMirror">` inside it. All editor CSS uses `:global(.ProseMirror)` selectors.

**Autosave:** After `autosave.interval` ms of inactivity (from store, default 1000ms, 0 = off). New notes get a UUID and navigate to `/note/<uuid>` on first save.

**`id === 'new'`** creates a new note on first save; navigates to its UUID with `replaceState`. Navigating back from a new unsaved note discards it.

**Cursor preservation on save:** `editor.state.selection.anchor` (integer ProseMirror position) is captured before save; restored after with `editor.commands.setTextSelection(pos)` inside `requestAnimationFrame`. Same pattern used in `applyExternalUpdate` for real-time sync.

**Notes side drawer (mobile):**

- Slides in from the left, overlapping the editor. Backdrop tap closes it.
- Shows all folders (collapsible), topics (with their notes indented), and a flat "All notes" section.
- Tapping a note: saves the current note if unsaved, closes the drawer, navigates to the selected note via `goto()`.
- Active note is highlighted in the drawer.
- On desktop, this drawer is hidden; back navigation + the notes list page serve the same purpose.

**Note storage format:** TipTap outputs semantic HTML. The decrypted `body` field is a string like:

```html
<h2>Heading</h2>
<p>Hello <span style="font-size:24px;color:#6b8afd;">world</span></p>
<ul data-type="taskList"><li data-checked="true"><p>Done</p></li></ul>
<table><tbody><tr><th><p>Cell</p></th></tr></tbody></table>
```

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
- Icon slots for 72, 96, 128, 144, 152, 192, 384, 512px. PNG files placed in `static/icons/` (e.g. `appicon-512.png`). The 192px and 512px entries include `"purpose": "any maskable"`.
- Favicons also served from `static/icons/` (e.g. `favicon.ico`, `appicon-16.png`, `appicon-32.png`). All favicon `<link>` tags in `app.html` reference `/icons/…` paths.
- The app icon (96px) is shown in the desktop sidebar replacing the placeholder letter mark.

---

## iOS-Specific Behaviour

| Issue | Fix |
| --- | --- |
| Text field zoom on focus | All inputs/textareas use `font-size: 16px`; editor toolbar `<select>` uses `font-size: 16px` on mobile |
| Rubberbanding / full-page scroll | `position: fixed; overflow: hidden` on `body` + `overscroll-behavior: none` on `html` and `.app-shell`; only scrollable regions use `overscroll-behavior: contain` |
| Status bar / Dynamic Island overlap | Mobile header uses `padding-top: env(safe-area-inset-top)` and `align-items: flex-end` so content sits below the status bar |
| Home indicator clearance | `padding-bottom: env(safe-area-inset-bottom, 0px)` on bottom nav |
| Landscape font scaling | `-webkit-text-size-adjust: 100%` on `html` |
| Container scroll when keyboard opens | App shell uses `height: 100dvh; overflow: hidden`; only `.main-content` and `.body-editor` scroll |
| iPad notch in landscape (sidebar) | Sidebar logo uses `padding-top: max(20px, env(safe-area-inset-top))` |
| Double-tap zoom / pinch zoom | `maximum-scale=1, user-scalable=no` in viewport meta (set in `app.html`) |
| Topic tap requires double-tap | `ontouchend` only calls `preventDefault()` when a long-press drag was initiated; normal taps fall through to `onclick` |

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
