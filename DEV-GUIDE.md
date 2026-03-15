# Bedroc — Developer & Contributor Guide

This guide is for developers who want to build, fork, modify, or deploy Bedroc from source.

---

## Repository layout

```text
Bedroc/
├── bedroc/          SvelteKit frontend (TypeScript, Svelte 5, TailwindCSS)
│   ├── src/
│   │   ├── lib/
│   │   │   ├── crypto/      WebCrypto wrappers (PBKDF2, AES-GCM, SRP-6a)
│   │   │   ├── db/          IndexedDB offline layer
│   │   │   ├── sync/        WebSocket client (websocket.ts)
│   │   │   └── stores/      Svelte 5 rune-based state (auth, notes)
│   │   └── routes/          SvelteKit pages (+page.svelte)
│   ├── static/              PWA icons, manifest, sw.js (service worker)
│   ├── Dockerfile           Multi-stage: Node build → nginx static serve
│   ├── nginx-static.conf    nginx config inside the bedroc container
│   └── vercel.json          SPA rewrite rule for Vercel deployment
│
├── server/          Fastify backend (TypeScript, Node 22)
│   ├── src/
│   │   ├── db/
│   │   │   ├── client.ts        pg pool + migration runner
│   │   │   ├── migrations/      SQL migration files (001_init.sql, …)
│   │   │   └── queries/         Typed pg query functions
│   │   ├── middleware/auth.ts   JWT verification helper
│   │   ├── plugins/redis.ts     Redis singleton
│   │   └── routes/
│   │       ├── auth.ts          Register, SRP login, logout, sessions, change-password
│   │       ├── notes.ts         CRUD for notes, topics, folders
│   │       ├── attachments.ts   Encrypted attachment upload/download
│   │       └── sync.ts          WebSocket real-time sync
│   └── Dockerfile
│
├── docker/
│   ├── nginx/nginx.conf     Outer reverse proxy (TLS termination, WireGuard bind)
│   ├── nginx-static.conf    (canonical copy — also copied to bedroc/)
│   ├── postgres/init.sql    First-boot DB user + permissions
│   └── ssl/                 TLS certs (git-ignored)
│
├── docker-compose.yml       Production stack
├── .env.example             All required env vars with documentation
├── GUIDE.md                 End-user self-hosting guide
└── DEV-GUIDE.md             This file
```

---

## Running locally for development

### Prerequisites

- Node.js 22+
- Docker + Docker Compose (for postgres + redis)
- `openssl` (for generating dev SSL cert)

### 1. Start backing services

```bash
# From repo root — starts postgres and redis only
docker compose up -d postgres redis
```

### 2. Run the backend

```bash
cd server
npm install

# Create a dev .env (copy and fill in)
cp ../.env.example .env
# Edit .env: set DATABASE_URL, REDIS_URL, JWT secrets
# For dev, you can use:
#   HOST=0.0.0.0
#   DATABASE_URL=postgres://bedroc_app:devpassword@localhost:5432/bedroc
#   REDIS_URL=redis://localhost:6379
#   JWT_ACCESS_SECRET=dev-access-secret-at-least-32-chars
#   JWT_REFRESH_SECRET=dev-refresh-secret-at-least-32-chars

npm run dev
# Server starts on http://localhost:3000
```

### 3. Run the frontend

```bash
cd bedroc
npm install
npm run dev
# Frontend starts on http://localhost:5173
```

Open `http://localhost:5173`, tap "Server" on the login page, and enter `http://localhost:3000`.

---

## Building for production

### Frontend (static SPA)

```bash
cd bedroc
npm run build
# Output: bedroc/build/
```

The output is a plain static site — serve it from any static host (Vercel, nginx, S3+CloudFront, etc.).

### Backend (Docker)

```bash
# From repo root
docker compose build server
```

Or build and push manually:

```bash
cd server
docker build -t your-registry/bedroc-server:latest .
docker push your-registry/bedroc-server:latest
```

### Full stack

```bash
# From repo root
cp .env.example .env
# Fill in .env
docker compose up -d --build
```

---

## Deploying the frontend to Vercel

The frontend is a static SPA — deploy it to Vercel by connecting the repo and setting:

- **Root directory:** `bedroc`
- **Build command:** `npm run build`
- **Output directory:** `build`
- **Install command:** `npm install`

The `vercel.json` in `bedroc/` handles SPA routing (all paths → `index.html`).

No environment variables are needed on Vercel — the frontend is fully client-side and connects to whichever backend URL the user provides at login.

---

## Deploying the frontend to a custom domain (nginx)

After `npm run build`, copy `bedroc/build/` to your server and serve with nginx:

```nginx
server {
    listen 443 ssl;
    server_name notes.yourdomain.com;
    ssl_certificate     /path/to/cert.pem;
    ssl_certificate_key /path/to/key.pem;

    root /var/www/bedroc;
    index index.html;

    location / {
        try_files $uri $uri/ /index.html;
    }
}
```

---

## Security checklist before going public

These values **must** be changed from their defaults before running in production:

| What | Where | How |
| --- | --- | --- |
| `JWT_ACCESS_SECRET` | `.env` | `openssl rand -hex 32` |
| `JWT_REFRESH_SECRET` | `.env` | `openssl rand -hex 32` (different from above) |
| `POSTGRES_PASSWORD` | `.env` | Strong random password |
| `DATABASE_URL` password | `.env` | Must match `POSTGRES_PASSWORD` |
| TLS certificate | `docker/ssl/cert.pem` + `key.pem` | Self-signed (WireGuard) or Let's Encrypt (public) |

Run this twice to get two different secrets:

```bash
openssl rand -hex 32
```

Never commit `.env` to git. It is listed in `.gitignore`.

---

## Database migrations

Migrations run automatically on every server startup (`runMigrations()` in `server/src/db/client.ts`). They are idempotent — safe to run multiple times.

Migration files live at `server/src/db/migrations/` and are numbered sequentially:

```text
001_init.sql              — users, sessions, notes, topics, folders tables
002_session_refresh_hash  — adds refresh_token_hash to sessions (token rotation)
003_session_metadata      — adds login_ip and last_used_at to sessions
```

To add a migration:

1. Create `server/src/db/migrations/004_description.sql`
2. Add the filename to the `migrations` array in `server/src/db/client.ts`
3. The migration runs automatically on next server start

To run migrations manually (e.g. for inspection):

```bash
docker compose exec postgres psql -U postgres -d bedroc -f /path/to/migration.sql
```

---

## Architecture overview

### End-to-end encryption model

```text
User password
  └─ PBKDF2(password, dekSalt, 600k rounds, SHA-256)
        └─ Master Key (AES-256, never stored)
              └─ AES-GCM.decrypt(encryptedDek)
                    └─ DEK — Data Encryption Key (in memory only)
                          └─ AES-GCM.encrypt(note title + body)
                                └─ Ciphertext (stored on server)
```

- The server stores `encrypted_dek` (DEK wrapped with Master Key) and `dek_salt`.
- The server **cannot** decrypt notes — it never sees the plaintext DEK or Master Key.
- If the user forgets their password, their data is permanently inaccessible — by design.

### Authentication (SRP-6a)

The password is **never sent to the server** in any form. SRP-6a lets the client prove knowledge of the password using zero-knowledge cryptography. See `server/src/routes/auth.ts` and `bedroc/src/lib/crypto/srp.ts` for the implementation.

Key properties:

- Server stores only an SRP verifier (cannot be used to log in or reverse the password)
- Mutual authentication: both client and server prove they know the password
- Implemented with the 3072-bit MODP group (RFC 3526) — no external SRP libraries

### Offline-first data flow

```text
Write:
  1. Encrypt (client)
  2. Write to IndexedDB (instant, works offline)
  3. Enqueue to syncQueue in IndexedDB
  4. Attempt server PUT (if online)
  5. On success: mark synced, dequeue
  6. On failure: leave in queue, retry on next flush

Read:
  1. Load from IndexedDB (instant)
  2. Delta sync from server (notes updated since last sync)
  3. Decrypt + merge into reactive store
  4. Conflict detection: if local has unsynced edits AND server is newer → store conflict, preserve local
```

### API routes

All endpoints are at `/api/...`.

| Method | Path | Auth | Description |
| --- | --- | --- | --- |
| `GET` | `/health` | None | Health check (nginx proxies this to Fastify — used by the frontend to confirm backend is alive) |
| `POST` | `/api/auth/register` | None | Create account |
| `POST` | `/api/auth/login/init` | None | SRP step 1 |
| `POST` | `/api/auth/login/verify` | None | SRP step 2 + issue JWT |
| `POST` | `/api/auth/refresh` | Cookie | Refresh access token |
| `POST` | `/api/auth/logout` | JWT | Revoke session |
| `POST` | `/api/auth/change-password` | JWT | Change password + re-encrypt DEK |
| `GET` | `/api/auth/sessions` | JWT | List active sessions |
| `DELETE` | `/api/auth/sessions/:id` | JWT | Revoke specific session |
| `POST` | `/api/auth/sessions/revoke-all` | JWT | Revoke all sessions |
| `DELETE` | `/api/auth/account` | JWT | Delete account + all data |
| `GET` | `/api/notes` | JWT | Get all notes (encrypted) |
| `GET` | `/api/notes/sync` | JWT | Delta sync (notes updated since timestamp) |
| `PUT` | `/api/notes/:id` | JWT | Create/update note |
| `DELETE` | `/api/notes/:id` | JWT | Delete note |
| `GET` | `/api/topics` | JWT | Get all topics |
| `PUT` | `/api/topics/:id` | JWT | Create/update topic |
| `DELETE` | `/api/topics/:id` | JWT | Delete topic |
| `GET` | `/api/folders` | JWT | Get all folders |
| `PUT` | `/api/folders/:id` | JWT | Create/update folder |
| `DELETE` | `/api/folders/:id` | JWT | Delete folder |
| `GET` | `/ws` | JWT (query param) | WebSocket real-time sync |

---

## Frontend deployment model

Bedroc uses a **"public frontend, self-hosted backend"** model:

- The frontend (this repo's `bedroc/` directory) is stateless — it has no server-side component.
- It can be hosted anywhere: Vercel, GitHub Pages, nginx, Electron, etc.
- At login/register, the user specifies their backend URL (defaults to `https://api.bedroc.app`).
- The backend URL is saved to localStorage so users don't re-enter it.

This means:

- Users who want privacy can point the public frontend at their own backend.
- Self-hosters only need to run the backend stack — they can use the public frontend.
- The frontend URL is irrelevant to security — all data security is in the encryption layer.

### CORS on the backend

`CORS_ORIGIN` in `.env` controls this:

- Empty/unset → accept any origin (recommended for public self-hosting)
- Specific URL → restrict to that frontend only (recommended for private servers)

---

## Real-time sync (WebSocket)

Multi-device real-time sync is implemented end-to-end:

- **Server** (`server/src/routes/sync.ts`): WebSocket route at `GET /ws`. JWT auth via `?token=` query param. Broadcasts `note:updated` / `note:deleted` messages to all other connections for the same user.
- **Client** (`bedroc/src/lib/sync/websocket.ts`): connects on login, disconnects on logout. Auto-reconnects with exponential backoff (1s → 2s → 4s → … → 60s max). Sends a keepalive ping every 30s. Wired into `+layout.svelte` via `wsConnect()` / `wsDisconnect()`.
- **On message**: `note:updated` or `note:deleted` triggers `syncFromServer()`, which pulls and merges the delta from the server.

---

## Offline / PWA

A service worker (`bedroc/static/sw.js`) caches the app shell for true offline use:

- **Static assets** (JS, CSS, icons): cache-first, updated in background.
- **Navigation** (HTML): network-first, falls back to the cached SPA shell (`/`). SvelteKit handles routing client-side.
- **API / WS**: never cached — always network-only.
- Registered in `+layout.svelte` on mount. Works on iOS Safari 11.3+, Android, all desktop browsers.

### Safari / iOS PWA notes

- `viewport-fit=cover` + `env(safe-area-inset-*)` handles status-bar / home-indicator padding.
- `body { position: fixed; background: var(--bg-elevated); padding-bottom: env(safe-area-inset-bottom) }` fills the gap below the bottom nav in PWA standalone mode.
- **Safari ITP cookie fix**: `restoreSession()` checks IndexedDB key material even when `tryRefreshToken()` returns `'expired'` (Safari ITP blocks cross-site httpOnly cookies). If key material exists the user sees the unlock prompt instead of a blank login form.

---

## Theme system

`bedroc/src/lib/stores/theme.svelte.ts` provides `theme`, `setTheme()`, `toggleTheme()`, `initTheme()`.

- Persists to `localStorage` under key `bedroc_theme` (`'dark'` | `'light'`).
- Applies `data-theme="light"` on `<html>` — all CSS variables are overridden in `app.css` under `[data-theme="light"]`.
- An inline `<script>` in `app.html` applies the saved theme before first paint (prevents flash).
- `initTheme()` is called in `+layout.svelte` on mount to rehydrate on navigation.
- Toggle is in **Settings → Appearance**.

---

## UI layout

### Desktop sidebar

There is **one unified sidebar** per page. On the notes list (`/`) and settings (`/settings`), the `<aside class="topics-panel">` component acts as the full sidebar:

- Logo at top
- "All notes" + "Uncategorised" pinned entries
- Topic separator
- Scrollable folders/topics list
- Bottom footer: user avatar + settings icon + server status dot

The layout (`+layout.svelte`) no longer renders a separate sidebar. Each page manages its own sidebar. The editor (`/note/[id]`) is full-screen with a slide-in topics drawer.

### Mobile

Bottom nav (`Notes` | `Settings`) replaces the sidebar. The settings icon in the topics panel footer is hidden on mobile.

---

## Offline conflict resolution

When a note is edited offline on one device and also updated on the server (from another device), a conflict is detected on next sync:

- **Conflict condition**: `synced: false` AND `clientUpdatedAt > serverUpdatedAt` AND server has a newer `server_updated_at`.
- **Conflict stored**: both the local and server versions are saved to the `conflicts` IndexedDB object store (DB version 2). The local note is **never silently overwritten**.
- **Resolution UI**: a banner appears on the note editor when a conflict is detected. The user can expand it to see both versions side-by-side and choose: keep local, keep server, or write a custom merge.
- **After resolution**: the chosen version is saved locally, pushed to the server, and the conflict record is deleted.

---

## Contributing

1. Fork the repository
2. Create a feature branch: `git checkout -b feature/my-feature`
3. Make your changes
4. Run type-check: `cd bedroc && npm run check`
5. Open a pull request against `main`

### Keeping docs updated

When making changes:

- Update `GUIDE.md` if the self-hosting process changes (env vars, ports, Docker config)
- Update `DEV-GUIDE.md` if the architecture, API, or build process changes
- Update `docs/PLACEHOLDERS.md` when implementing a placeholder feature

---

## Auth / session notes

- **Refresh token cookie** uses `sameSite: 'none'; Secure: true` so it is sent cross-origin from any frontend (e.g. `bedroc.cagancalidag.com` → `https://10.66.66.1`). This is required for the public-frontend / self-hosted-backend model.
- **Session lifetime** defaults to 30 days (`JWT_REFRESH_EXPIRY=30d`). Configure via env var. The access token refreshes silently every 15 minutes (`JWT_ACCESS_EXPIRY=15m`).
- **Offline unlock**: when the server is unreachable (network error, not 401), the app shows an unlock prompt so users can access local IndexedDB notes without connectivity.
- **Session metadata**: each session records `login_ip` (from `X-Forwarded-For` or direct IP) and `last_used_at` (updated on every token refresh). The Settings page shows "This device" next to the current session, login timestamp, IP, and expiry. Older sessions without these fields show gracefully without errors.
- **Device detection**: `parseDeviceInfo()` in `server/src/routes/auth.ts` parses the User-Agent string into a human-readable label. Handles: Edge (desktop `Edg/`, mobile `EdgA/`), Chrome/CrOS, Firefox, Safari, Opera, Samsung Browser, Electron. CrOS is detected before Mac/Linux to avoid false-positive "Linux" labels.

## Rate limits

Rate limits are configured per-route in `server/src/routes/` and globally in `server/src/index.ts`.

| Route | Limit | Reason |
| --- | --- | --- |
| Global fallback | 500 req/min | All other authenticated routes |
| `GET /api/notes/sync` | 200 req/min | 0.5 s minimum sync interval = 120 req/min |
| `PUT /api/notes/:id` | 200 req/min | Rapid typing + short autosave intervals |
| `GET /api/notes`, `GET /api/notes/:id` | 120 req/min | General note reads |
| `PUT /api/topics/:id`, `PUT /api/folders/:id` | 120 req/min | Rapid drag-to-reorder |
| `GET /api/topics`, `GET /api/folders` | 120 req/min | Sync reads |
| `DELETE /api/notes/:id` | 60 req/min | Delete operations |
| `POST /api/attachments/check` | 120 req/min | Pre-upload hash existence check |
| `PUT /api/attachments/:hash` | 60 req/min | Attachment upload (idempotent) |
| `GET /api/attachments/:hash` | 120 req/min | Attachment download |
| `DELETE /api/attachments/:hash` | 30 req/min | Explicit attachment removal |
| `POST /api/auth/register` | 5 req/min | Anti-spam |
| `POST /api/auth/login/init` | 10 req/min | Brute-force protection |
| `POST /api/auth/login/verify` | 10 req/min | Brute-force protection |

To change a per-route limit, update `config: { rateLimit: { max: N, timeWindow: '1 minute' } }` on that route handler. To change the global fallback, update `max` in the `fastifyRateLimit` registration in `server/src/index.ts`.

## Known limitations (current state)

- **Change password** re-derives master key and re-wraps the DEK, but does not revoke existing sessions. Users who want to invalidate all sessions after a password change should also use "Revoke all sessions" in Settings.
- **Rate limiting** on auth routes uses Redis — if Redis is unavailable, the rate limiter falls back to in-memory (single-instance only).
- **iOS push notifications**: the PWA service worker does not support push notifications on iOS (Apple limitation). Real-time sync uses the WebSocket connection instead — it works while the app is open.
- **Attachment deletion UX**: `DELETE /api/attachments/:hash` is available server-side but the client does not yet call it automatically when a file card is removed from a note. Orphaned server-side attachments are cleaned up only on account deletion (CASCADE). Future: track reference counts or call delete when all note references are gone.
- **Self-signed cert (browser)**: browsers block fetch() to HTTPS backends with self-signed certs. Use a domain with a real certificate (Caddy, Let's Encrypt) for the best experience. The Electron desktop app bypasses this restriction for private IPs.
