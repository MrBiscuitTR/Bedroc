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
│   ├── Dockerfile           Multi-stage: Node build → unprivileged nginx static serve
│   ├── nginx-static.conf    nginx config inside the bedroc container
│   └── vercel.json          SPA rewrite rule for Vercel deployment
│
├── desktop/         Electron wrapper (main.js, preload.js, electron-builder config)
│   ├── main.js              Main process: local HTTP server + BrowserWindow
│   ├── preload.js           Context bridge (minimal — no Node APIs exposed)
│   ├── package.json         electron-builder config (win/mac/linux targets)
│   └── build-resources/     App icons (icon.png, icon.ico)
│
├── server/          Fastify backend (TypeScript, Node 22)
│   ├── src/
│   │   ├── config.ts            Env validation (fails fast on insecure settings)
│   │   ├── migrate.ts           One-shot migration runner (the `migrate` container)
│   │   ├── crypto/srp.ts        Server-side SRP-6a math (unit-tested vs the client)
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
│   ├── test/                Unit + integration tests (see "Tests")
│   └── Dockerfile           npm ci, non-root, npm removed from the runtime image
│
├── docker/
│   ├── nginx/               Outer reverse proxy image (nginx.conf baked in; TLS, BIND_IP)
│   ├── nginx-static.conf    (canonical copy — also copied to bedroc/)
│   ├── postgres/            Postgres image with init.sh baked in (first-boot app user + grants)
│   └── ssl/                 TLS certs (git-ignored)
│
├── bedroc.sh                Operator CLI: setup / check / up / update / backup / restore / …
├── docker-compose.yml       Self-contained private stack (WireGuard/Tailscale/LAN)
├── docker-compose.public.yml  Public VPS stack (API only, behind a host reverse proxy)
├── .env.example             All env vars with documentation
├── GUIDE.md / VPS-DEPLOY.md / UPGRADING.md / MANAGEMENT-GUIDE.md / TROUBLESHOOTING.md
└── DEV-GUIDE.md             This file
```

---

## Running locally for development

### Prerequisites

- Node.js 22+
- Docker + Docker Compose (for postgres + redis)
- `openssl` (for generating dev SSL cert)

### 1. Start backing services

The compose stacks keep Postgres and Redis on an internal network with no host ports, so for development run throwaway instances bound to localhost:

```bash
docker run -d --name bedroc-dev-pg -p 127.0.0.1:5432:5432 \
  -e POSTGRES_DB=bedroc -e POSTGRES_PASSWORD=devpass postgres:16-alpine
docker run -d --name bedroc-dev-redis -p 127.0.0.1:6379:6379 redis:7.4-alpine \
  redis-server --requirepass devredis --save ''
# server env: DATABASE_URL=postgres://postgres:devpass@127.0.0.1:5432/bedroc
#             REDIS_URL=redis://:devredis@127.0.0.1:6379   CORS_ORIGIN=http://localhost:5173
```

(Remove them with `docker rm -f bedroc-dev-pg bedroc-dev-redis`.)

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
# From repo root (any mode)
bash bedroc.sh compose build server
```

Or build and push manually:

```bash
cd server
docker build -t your-registry/bedroc-server:latest .
docker push your-registry/bedroc-server:latest
```

### Full stack

```bash
bash bedroc.sh setup     # creates the env file with generated secrets
bash bedroc.sh up
```

### Container hardening (keep it when changing compose files)

- Every service uses the `x-hardening` anchor: `no-new-privileges`, `cap_drop: [ALL]`, bounded json-file logs. Only postgres (`CHOWN DAC_OVERRIDE FOWNER SETGID SETUID`) and the outer nginx (`+ NET_BIND_SERVICE`) add capabilities back, so their official entrypoints can drop to their own users.
- `read_only: true` everywhere; writable paths are `tmpfs` (plus the data volume and `./logs`).
- Networks: `backend` (internal; postgres, redis, migrate, server), `web` (internal; nginx, frontend, server), `edge` (only for publishing ports). Postgres and Redis never get internet access or host ports.
- The API server gets `RUN_MIGRATIONS=false` and never sees `POSTGRES_URL`. The `migrate` service runs `node dist/migrate.js` first (`service_completed_successfully`), trying the app role before the superuser.
- Redis: password from `REDIS_PASSWORD` written to a tmpfs config file (not argv), no persistence, `CONFIG`/`DEBUG`/`MODULE`/replication commands disabled.
- **Never rename services or the `postgres_data` volume**: operators' data and cron jobs depend on `<project>_postgres_data` and `<project>-postgres-1`.

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

Migrations run before every start: in Docker via the one-shot `migrate` service (`server/src/migrate.ts`); outside Docker on server startup unless `RUN_MIGRATIONS=false`. They are idempotent, so they're safe to run multiple times. They run as the app role (`DATABASE_URL`) and fall back to `POSTGRES_URL` only on a privilege error (older installs where `postgres` owns the tables).

Migration files live at `server/src/db/migrations/` and are numbered sequentially:

```text
001_init.sql              — users, sessions, notes, topics, folders tables
002_session_refresh_hash  — adds refresh_token_hash to sessions (token rotation)
003_session_metadata      — adds login_ip and last_used_at to sessions
004_attachments           — encrypted attachment blobs
005_security_hardening    — srp_kdf_version, refresh-token reuse detection columns
```

Keep migrations **additive** (new nullable/defaulted columns, `IF NOT EXISTS`) so the previous server version still runs on the migrated schema. That's what makes rollback safe (UPGRADING.md).

To add a migration:

1. Create `server/src/db/migrations/006_description.sql`
2. Add the filename to the `MIGRATIONS` array in `server/src/db/client.ts`
3. The migration runs automatically on next server start

To run migrations manually (e.g. for inspection):

```bash
bash bedroc.sh psql
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
| `POST` | `/api/auth/login/init` | None | SRP step 1 → `{ challengeId, salt, B, kdf }` |
| `POST` | `/api/auth/login/verify` | None | SRP step 2 `{ challengeId, A, M1, upgrade? }` → JWT + `M2` |
| `POST` | `/api/auth/refresh` | Cookie | Rotate refresh token, issue access token (409 = concurrent-tab race, retry) |
| `POST` | `/api/auth/logout` | JWT or cookie | Revoke session |
| `POST` | `/api/auth/change-password` | JWT + SRP proof | Change password + re-wrap DEK; revokes all other sessions |
| `GET` | `/api/auth/sessions` | JWT | List active sessions |
| `DELETE` | `/api/auth/sessions/:id` | JWT | Revoke specific session |
| `POST` | `/api/auth/sessions/revoke-all` | JWT | Revoke all sessions |
| `DELETE` | `/api/auth/account` | JWT + SRP proof | Delete account + all data (body `{ proof: { challengeId, A, M1 } }`) |
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
| `PUT` | `/api/attachments/:hash` | JWT | Upload encrypted attachment (idempotent, `ON CONFLICT DO NOTHING`) |
| `GET` | `/api/attachments/:hash` | JWT | Download encrypted attachment |
| `DELETE` | `/api/attachments/:hash` | JWT | Delete attachment |
| `GET` | `/ws` | JWT (first message) | WebSocket real-time sync |

---

## Frontend deployment model

Bedroc uses a **"public frontend, self-hosted backend"** model:

- The frontend (this repo's `bedroc/` directory) is stateless — it has no server-side component.
- It can be hosted anywhere: Vercel, GitHub Pages, nginx, Electron, etc.
- At login/register, the user specifies their backend URL (defaults to `https://bedrocapi.cagancalidag.com`).
- The backend URL is saved to localStorage so users don't re-enter it.

This means:

- Users who want privacy can point the public frontend at their own backend.
- Self-hosters only need to run the backend stack — they can use the public frontend.
- The frontend URL is irrelevant to security — all data security is in the encryption layer.

### CORS on the backend

`CORS_ORIGIN` in `.env` is **required**: a comma-separated list of exact origins (`http://localhost:*` is allowed as a port wildcard for the desktop app). The server refuses to boot with `*`. Besides CORS, an `onRequest` hook in `server/src/index.ts` rejects any request whose `Origin` is not on the list with `403 origin_not_allowed`. That matters because "simple" cross-site POSTs (e.g. `/api/auth/refresh`) would otherwise still run even when CORS blocks the response. The 403 is readable by the blocked page, so the frontend can tell the user which origin to add.

---

## Real-time sync (WebSocket)

Multi-device real-time sync is implemented end-to-end:

- **Server** (`server/src/routes/sync.ts`): WebSocket route at `GET /ws`. The client authenticates by sending `{ type: 'auth', token }` as its first message within 10 s (`?token=` is still accepted for old clients but keeps the token out of logs only when unused). Sessions are re-checked every 60 s and revoked sessions are disconnected. Broadcasts `note:updated` / `note:deleted` messages to all other connections for the same user.
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

- **Do NOT use `viewport-fit=cover`** in the viewport meta tag. It causes iOS standalone PWA to missize the viewport, creating a persistent gap at the bottom of the screen that is invisible in Safari or DevTools emulators but visible on real devices. Without it, iOS handles safe areas natively and the viewport fills the screen properly.
- `apple-mobile-web-app-capable: yes` + `apple-mobile-web-app-status-bar-style: black-translucent` is sufficient for full-screen standalone behaviour.
- Safe area insets (`env(safe-area-inset-*)`) still work without `viewport-fit=cover` — use `max(env(safe-area-inset-bottom, 0px), Xpx)` fallback patterns where needed.
- **Safari ITP cookie fix**: `restoreSession()` checks IndexedDB key material even when `tryRefreshToken()` returns `'expired'` (Safari ITP blocks cross-site httpOnly cookies). If key material exists the user sees the unlock prompt instead of a blank login form.

---

## Theme system

`bedroc/src/lib/stores/theme.svelte.ts` provides `theme`, `setTheme()`, `toggleTheme()`, `initTheme()`.

- Persists to `localStorage` under key `bedroc_theme` (`'dark'` | `'light'`).
- Applies `data-theme="light"` on `<html>` — all CSS variables are overridden in `app.css` under `[data-theme="light"]`.
- An inline `<script>` in `app.html` applies the saved theme before first paint (prevents flash).
- `initTheme()` is called in `+layout.svelte` on mount to rehydrate on navigation.
- Toggle is in **Settings → Appearance**.

**Priority order** (highest wins):

1. `localStorage` explicit preference (`bedroc_theme = 'dark'` | `'light'`)
2. OS/browser system preference — detected via `window.matchMedia('(prefers-color-scheme: light)')`
3. Default: **dark**

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
- **SRP**: server math lives in `server/src/crypto/srp.ts` (unit-tested against the client in `server/test/srp.test.ts`). `x` is derived with PBKDF2-SHA256 (600k) for `srp_kdf_version = 2`; legacy v1 accounts are upgraded during their next successful login (`upgrade` field in `/login/verify`). Unknown usernames get a deterministic fake salt and a real challenge, so responses are indistinguishable. Challenges are keyed by a random `challengeId` and are single-use (`GETDEL`).
- **Refresh rotation**: each refresh rotates the token and stores the previous hash. Replaying the previous token within `REFRESH_REUSE_GRACE_SECONDS` (default 30) returns 409 (multi-tab race, client retries). Replaying it later revokes the whole session (theft detection). Revoked or unknown tokens are never re-issued.
- **Refresh cookie path** is `/api/auth` (so logout receives it); the legacy `/api/auth/refresh` cookie is cleared whenever a new one is set.
- **Note ciphertexts** are bound to `bedroc:note:<id>:title|body` via AES-GCM additional data (`v: 2` fields). Legacy fields without `v` still decrypt and are upgraded on the next save.
- **Attachments** fetched from the server must decrypt under the DEK *and* hash to their id, or they are discarded; plaintext is never uploaded.
- **Session metadata**: each session records `login_ip` (`req.ip`, resolved via `TRUST_PROXY` hops) and `last_used_at` (updated on every token refresh). The Settings page shows "This device" next to the current session, login timestamp, IP, and expiry. Older sessions without these fields show gracefully without errors.
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
| `POST /api/auth/refresh` | 60 req/min | Token rotation |
| `POST /api/auth/change-password`, `DELETE /api/auth/account` | 5 req/min | Sensitive, password-gated |
| Per account (Redis `srp:fail:*`) | 10 failed proofs / 15 min | Lockout that does not depend on the attacker's IP |

Client IPs come from `req.ip`, which honours exactly `TRUST_PROXY` proxy hops (default 1). Never use `trustProxy: true`: nginx appends to a client-supplied `X-Forwarded-For`, so trusting every hop lets clients spoof their IP and bypass the limits.

### Tests

```bash
cd server && npm test                       # SRP + AES-GCM unit tests (client code vs server code)
docker build -t bedroc-test-server server   # then the integration suite against real Postgres + Redis:
docker compose -f server/test/docker-compose.test.yml up --abort-on-container-exit --exit-code-from tests
docker compose -f server/test/docker-compose.test.yml down -v
```

To change a per-route limit, update `config: { rateLimit: { max: N, timeWindow: '1 minute' } }` on that route handler. To change the global fallback, update `max` in the `fastifyRateLimit` registration in `server/src/index.ts`.

## Bumping the app version

**Normally you don't run this yourself.** GitHub → Actions → **Release** → Run workflow (patch/minor/major) runs the script, commits `Release vX.Y.Z` to `main`, tags it, builds the desktop apps for all three OSes and publishes the GitHub Release (see DESKTOP-RELEASE.md). Vercel then redeploys with the new version. The UI shows `v<package.json version> <commit hash>`, so the version only changes when a release is cut.

Use the script directly only for local builds.

### What gets updated

| File | Field |
| --- | --- |
| `bedroc/package.json` | `"version"` |
| `desktop/package.json` | `"version"` — controls Electron installer/build filenames (e.g. `Bedroc-1.0.14-Setup.exe`) |
| `server/package.json` | `"version"` |
| `bedroc/static/sw.js` | `CACHE_NAME` and `SHELL_CACHE` constants — changing these forces all clients to re-download the service worker cache on next visit |

| `*/package-lock.json` | the package's own `"version"` (top level and `packages[""]`), kept in sync so `npm ci` stays clean |

### Running the script

From the **repo root**:

```bash
node scripts/bump-version.js 1.0.14
```

From the **`bedroc/` directory**:

```bash
npm run bump-version -- 1.0.14
```

The script validates that the argument is a valid `major.minor.patch` semver string and exits with an error if not.

### When to bump

- Before every production release (commit the version bump as its own commit, e.g. `chore: bump version to 1.0.14`)
- Before building an Electron installer — the version number appears in the installer filename and Windows Add/Remove Programs
- Whenever you deploy a new service worker — the cache name change ensures stale caches are busted on all clients

## Desktop (Electron)

The `desktop/` directory contains an Electron wrapper that ships the SvelteKit static build as a native desktop app.

### How it works

- `main.js` starts a minimal Node.js HTTP server on a free port in the `49152+` range, serving the static build from `resources/app/` (production) or `../bedroc/build` (dev).
- A `BrowserWindow` loads `http://localhost:<port>`. Using `localhost` (not `file://`) means service workers, `fetch()`, cookies, and IndexedDB all behave normally.
- Private-IP TLS bypass: `session.defaultSession.setCertificateVerifyProc` and `app.on('certificate-error')` skip cert verification for RFC-1918, Tailscale CGNAT (`100.64–127.*`), and loopback addresses. Public internet addresses are fully verified.

### Running in dev

```bash
cd bedroc && npm run build   # build frontend first
cd ../desktop && npm start   # launch Electron (DevTools opens automatically)
```

### Building installers

Requires native toolchain for each platform — cross-compilation is not supported by electron-builder.

| Platform | Runner needed | Command | Output |
| --- | --- | --- | --- |
| Windows | Windows | `npm run dist:win` | NSIS installer + portable `.exe` |
| macOS | macOS | `npm run dist:mac` | `.dmg` + `.zip` (x64 + arm64) |
| Linux | Linux | `npm run dist:linux` | `.AppImage` + `.deb` + `.rpm` |

**CI builds**: `.github/workflows/build-desktop.yml` runs `build-linux` on `ubuntu-latest` and `build-mac` on `macos-latest`. Triggered on `v*` tag push or manual `workflow_dispatch`. Windows builds must be done locally (no Windows runner configured). `CSC_IDENTITY_AUTO_DISCOVERY=false` skips macOS code signing in CI — users will need to right-click → Open the first time.

### Right-click context menu

`main.js` handles the `context-menu` event on `mainWindow.webContents`. The menu includes Cut, Copy, Paste, Paste without formatting, and Select All — shown contextually based on whether text is selected and whether the target is editable.

### Content Security Policy

`main.js` sets a CSP header for every response from the local HTTP server:

```text
frame-src 'self' blob:;
```

`'self'` is required for the split-pane iframe feature (which loads `http://localhost:<port>`). `blob:` is required for PDF preview. **Do not remove `'self'`** — the split pane will show a blank panel with no error visible in the app.

---

## Touch / pointer input

### Hover styles

All CSS `:hover` rules in the app are wrapped in `@media (hover: hover)` so they only activate on real cursor devices (mouse, trackpad, Magic Keyboard). This prevents "sticky hover" on touch devices where:

- Topics/folders/notes remain highlighted after a finger lifts
- Toolbar buttons stay highlighted after a tap
- Topics require two taps to select (first tap activates hover, second tap fires click)

Any new hover rules **must** be wrapped in `@media (hover: hover)`. Do not add bare `:hover` rules — they will break touch UX.

### Drag and drop (touch)

Long-press (400ms) activates drag mode with haptic feedback (`navigator.vibrate(30)`). `onTouchMove` uses `document.elementFromPoint()` for hit-testing.

**Critical**: always guard against self-drops:

- `onTouchEnd` checks `dragId === dropTarget` and skips the action
- `moveFolder()` checks for circular parent references before committing — a folder cannot be moved into itself or any of its descendants

If a folder is accidentally given a circular `parentId` (e.g. by a bug), it becomes invisible in the sidebar (which only renders from `parentId === null`). `loadFromDb()` runs an orphan repair pass on startup: any folder with a circular or missing parentId is reset to `parentId: null`.

---

## Editor enhancements

The note editor (`routes/note/[id]/+page.svelte`) uses TipTap v3 with ProseMirror.

### Toolbar state updates

Toolbar active states (bold, italic, underline, color preview, etc.) update via `onTransaction` — not `onUpdate`. `onTransaction` fires synchronously on every ProseMirror transaction, including cursor moves, ensuring the toolbar always reflects the current selection state immediately.

### Tab key indent

`handleKeyDown` in `editorProps` intercepts the Tab key. Outside list items and table cells, Tab inserts four literal spaces. Inside list items/task items, it falls through to TipTap's default list indent behaviour. Inside tables, it moves to the next cell (default).

### Syntax highlighting

Code blocks use `CodeBlockLowlight` (from `@tiptap/extension-code-block-lowlight`) with `createLowlight(all)` — all highlight.js languages are registered. A custom NodeView renders a `<select>` language picker in the code block header. Token classes use `hljs-*` prefix; CSS in `app.css` styles them for both dark and light themes.

### Highlight color picker

A split button next to the highlight toolbar icon:

- Left side applies the current color immediately.
- Arrow side opens a dropdown with preset swatches (yellow, green, blue, red, purple, orange) plus a native `<input type="color">` for custom colors.
- Selected color is persisted to `localStorage` under `bedroc_highlight_color`.
- Uses `Highlight.configure({ multicolor: true })` so different colors can coexist in the same note.

### Default text color

The text color picker includes a "default" swatch (shown as a slash-circle icon, class `.color-swatch-default`). Clicking it calls `editor.commands.unsetColor()`, removing the `textStyle` color mark so the text inherits the theme's `--text` variable.

### Image alignment

Images support three placement modes: **inline** (default flow), **float left**, and **float right**. Mode is stored as a `data-align` attribute on the `<img>` tag and read back via `parseHTML` in the TipTap extension. A resize handle persists width as `data-width`. Both attributes survive save/reload because they use `parseHTML` + `renderHTML` (not inline styles, which TipTap does not parse back by default).

### Link tooltip

A tooltip appears below a link when:

- The text cursor is positioned inside a link mark (`onSelectionUpdate` detects this via `marks().find(m => m.type.name === 'link')`) — works on all platforms including mobile
- The mouse hovers over a link for 600ms (desktop/Electron only, via `mouseover` listener on the editor element)

The tooltip is `position: absolute` inside `.editor-scroll-area` (which has `position: relative`). This means it scrolls with the content — `showLinkTooltip()` converts viewport coordinates from `coordsAtPos()` to scroll-area-relative coordinates using `getBoundingClientRect()` and `scrollTop`. **Do not change it to `position: fixed`** — it will then stay fixed on screen while the user scrolls, detaching from the link.

Visibility logic uses three flags (`_cursorInLink`, `_mouseOnLink`, `_mouseOnTooltip`) to prevent the tooltip from disappearing while the user moves the cursor from the link to the tooltip. `scheduleLinkTooltipHide()` checks all three flags before fading out.

### Trailing paragraph

A `TrailingParagraph` ProseMirror plugin (`appendTransaction`) ensures there is always a clickable empty paragraph after the last block node (table, image, code block, etc.). This prevents the cursor from being "trapped" with no way to place it after a block.

### Print layout (A4 page mode)

Toggleable per note via the page icon button in the toolbar (left of Save). Setting is stored in `localStorage` (`bedroc_print_layout_notes` — a JSON array of enabled noteIds).

**When enabled:**

- Editor content is fixed at **794px wide** (A4 = 210mm at 96 DPI), centered in the scroll area with a paper-like shadow
- Content renders identically on every device regardless of screen dimensions — what you see is what prints
- JS-computed page-break guide lines (dashed blue) appear at content-aware positions every ~1123px (A4 page height)
  - `computePageBreaks()` measures each ProseMirror child via `getBoundingClientRect()` + `scrollTop` to get scroll-area-relative coordinates
  - If a child element straddles a page boundary, the break line shifts above it to avoid splitting content
  - Lines are `position: absolute` inside `.editor-scroll-area` and scroll with content
  - Recomputed on editor content changes and window resize via `requestAnimationFrame`
- A **Print** button appears in the toolbar, triggering the browser's native print dialog

**Print output (`@media print`):**

- All UI chrome is hidden (toolbar, format bar, word count, side drawer, bottom nav, splitter, file preview modal)
- WYSIWYG: when print layout is on, A4 sizing (794px width, 40px padding) is preserved in print output
- Content fills the page with `@page { size: A4; margin: 20mm }` for proper margins
- `break-inside: avoid` on images, tables, code blocks, file attachments, blockquotes, and task list items
- `break-after: avoid` on headings (keeps headings with following content)
- Print-friendly colors: tables get light borders/headers, code blocks get light backgrounds, all text forced to black/dark
- Image alignment toolbars and resize handles are hidden

**Horizontal scroll prevention:**

- `.body-editor-wrap` has `overflow-x: hidden` — images and tables cannot cause page-level horizontal scroll
- Tables have `max-width: 100%`; columns can be resized by the user but won't overflow
- Images are constrained by `max-width: 100%` on both wrapper and `<img>`

---

## Known limitations (current state)

- **Change password** re-derives master key and re-wraps the DEK, but does not revoke existing sessions. Users who want to invalidate all sessions after a password change should also use "Revoke all sessions" in Settings.
- **Rate limiting** on auth routes uses Redis — if Redis is unavailable, the rate limiter falls back to in-memory (single-instance only).
- **iOS push notifications**: the PWA service worker does not support push notifications on iOS (Apple limitation). Real-time sync uses the WebSocket connection instead — it works while the app is open.
- **Attachment IDB cache**: IDB stores the encrypted blob as a local cache. Stale IDB entries do not cause data loss — if an attachment is missing from IDB, it is transparently re-fetched from the server on next access. No GC is run on IDB; the server is the authoritative record.
- **Attachment retry**: `retryAttachmentUpload(hash, userId, dek)` re-attempts the background server upload on every `doSave()` call and after every note load (via `requestAnimationFrame`). Covers the case where the original fire-and-forget upload silently failed.
- **Attachment cleanup**: orphaned attachments (blobs whose note was deleted) are not automatically removed client-side — client-side detection is unsafe due to multi-device sync races and incomplete note loads. Cleanup is done manually: hard-delete soft-deleted notes via Adminer or a scheduled Postgres script, then rely on account-level `ON DELETE CASCADE` for full teardown. See `MANAGEMENT-GUIDE.md` for the recommended SQL.
- **Self-signed cert (browser)**: browsers block fetch() to HTTPS backends with self-signed certs. Use a domain with a real certificate (Caddy, Let's Encrypt) for the best experience. The Electron desktop app bypasses this restriction for private IPs.
