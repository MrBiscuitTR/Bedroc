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
│   └── routes/
│       ├── +layout.svelte               Root layout (sidebar + bottom nav)
│       ├── +page.svelte                 Notes list (home)
│       ├── login/+page.svelte           Login page
│       ├── register/+page.svelte        Register page
│       ├── note/[id]/+page.svelte       Note editor
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

Fixed 240px sidebar on the left with logo, nav links, and user footer. Main content fills the rest. The mobile header and bottom nav are hidden via `display: none`.

### Mobile (< 768px)

The sidebar is hidden. A fixed top header shows the current page title and a context action button (e.g. "New note" on the list page). A bottom nav bar with icon + label provides the same navigation as the desktop sidebar. Safe area inset padding is applied to the bottom nav for iOS home indicator clearance (`env(safe-area-inset-bottom)`).

### Auth pages

`/login` and `/register` bypass the app shell entirely. The root layout detects these routes and renders a bare centred card instead.

---

## Routes

### `/` — Notes list ([+page.svelte](../bedroc/src/routes/+page.svelte))

- Renders placeholder note cards with title, preview, and relative timestamp.
- Includes a search input that filters notes client-side by title and preview text.
- Empty state shown when no notes match the search or no notes exist.
- Desktop: shows a "New" button in the page header row.
- Mobile: the "New" button is in the mobile header (rendered by the layout).

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

- Toolbar with back button, save button, and delete button.
- Save button shows "Saved" (disabled) when clean, "Save" (enabled) when there are unsaved changes. A blue dot appears in the toolbar when unsaved.
- Full-height title input and body textarea with no visible borders — the note content fills the screen.
- `id === 'new'` is used to distinguish a new note from an existing one.
- All save/delete/load logic is a placeholder — wired in Phase 2.

### `/settings` — Settings ([settings/+page.svelte](../bedroc/src/routes/settings/+page.svelte))

- Account section: username and server URL (read-only display).
- Security section: change password and export notes buttons (no-op placeholders).
- Sessions section: placeholder list of active sessions with a revoke button per session.
- Danger zone: log out and delete account, each with an inline confirm step before the destructive action is enabled.
- Version string at the bottom.

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
| Rubberbanding / overscroll | `overscroll-behavior: none` on `body` |
| Container scroll when keyboard opens | App shell uses `height: 100dvh; overflow: hidden`; only `.main-content` scrolls |
| Home indicator clearance | `padding-bottom: env(safe-area-inset-bottom)` on bottom nav |
| Landscape font scaling | `-webkit-text-size-adjust: 100%` on `html` |

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
