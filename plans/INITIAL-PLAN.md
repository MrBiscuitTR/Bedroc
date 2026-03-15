# Bedroc — Initial Implementation Plan

## Context

Bedroc is an open-source, self-hostable, end-to-end encrypted (E2EE) real-time notes application. The goal is to give users a fully private alternative to Google Keep / Notion, where the server never sees note contents. This plan covers the entire project from stack selection through deployment.

---

## Tech Stack

### Frontend
- **SvelteKit** (not React — user wants to learn something new; Svelte compiles to vanilla JS, works great as a PWA, and can be wrapped in Electron later via `@sveltejs/adapter-static`)
- **Vite** (bundler, included with SvelteKit)
- **TypeScript** throughout
- **Tailwind CSS** (utility-first, responsive, no CDN — installed as a local npm dep)

### Backend
- **Node.js** with **Fastify** (fast, low overhead, excellent TypeScript support, better than Express for new projects)
- **PostgreSQL** (primary database — stores only encrypted blobs, user metadata, sync state)
- **Redis** (optional but recommended — rate limiting, session store, WebSocket pub/sub for multi-instance sync)
- **WebSockets** via `ws` package (real-time sync channel)

### Encryption (Client-Side Only)
- **WebCrypto API** (native browser — no third-party lib required)
- **PBKDF2** (key derivation from password, 600,000 iterations, SHA-256) — upgradeable to Argon2 in WASM if desired
- **AES-256-GCM** (symmetric encryption for note content)
- **X25519** (asymmetric key exchange for future sharing features)
- **OPAQUE or SRP** protocol consideration for password-authenticated key exchange (no password ever sent to server)

### Infrastructure
- **Docker + docker-compose** (PostgreSQL, Redis, Node backend, optional Nginx reverse proxy)
- **Nginx** (reverse proxy, TLS termination)

---

## Project Directory Structure

> **Confirmed layout (Option B — Docker at root).** This is the standard pattern for self-hostable apps (Gitea, Immich, n8n). A user clones the repo, copies `.env.example` → `.env`, edits a few lines, and runs `docker-compose up -d`. No hunting in subfolders.

```
Bedroc/                              ← root git repo
├── bedroc/                          ← SvelteKit frontend source
│   ├── src/
│   │   ├── lib/
│   │   │   ├── crypto/
│   │   │   │   ├── keys.ts          # Key derivation, wrapping, storage
│   │   │   │   ├── encrypt.ts       # AES-GCM encrypt/decrypt
│   │   │   │   └── srp.ts           # SRP auth (no password to server)
│   │   │   ├── db/
│   │   │   │   └── indexeddb.ts     # Local offline storage
│   │   │   ├── sync/
│   │   │   │   ├── websocket.ts     # Real-time sync client
│   │   │   │   └── conflict.ts      # Conflict resolution
│   │   │   ├── stores/
│   │   │   │   ├── auth.ts          # Auth state (server URL, session)
│   │   │   │   └── notes.ts         # Notes state
│   │   │   └── utils/
│   │   │       └── export.ts        # JSON export with security warning
│   │   ├── routes/
│   │   │   ├── +layout.svelte       # Root layout (sidebar/bottom nav)
│   │   │   ├── +page.svelte         # Notes list (home)
│   │   │   ├── login/
│   │   │   │   └── +page.svelte     # Login + server URL picker
│   │   │   ├── register/
│   │   │   │   └── +page.svelte     # Register + server URL picker
│   │   │   ├── note/[id]/
│   │   │   │   └── +page.svelte     # Note editor
│   │   │   └── settings/
│   │   │       └── +page.svelte     # Settings
│   │   ├── service-worker.ts        # Offline cache, background sync
│   │   ├── app.html                 # HTML shell (PWA meta, iOS fixes)
│   │   └── app.css                  # Global styles, design tokens
│   ├── static/
│   │   ├── manifest.webmanifest     # PWA manifest
│   │   ├── icons/                   # App icons (all sizes)
│   │   └── robots.txt
│   ├── svelte.config.js
│   ├── vite.config.ts
│   └── package.json
├── server/                          ← Fastify backend (future phase)
│   ├── src/
│   │   ├── routes/
│   │   │   ├── auth.ts              # Register, login (SRP), logout, refresh
│   │   │   ├── notes.ts             # CRUD for encrypted note blobs
│   │   │   └── sync.ts              # WebSocket upgrade + sync handler
│   │   ├── db/
│   │   │   ├── client.ts            # PostgreSQL connection pool
│   │   │   ├── migrations/
│   │   │   │   └── 001_init.sql
│   │   │   └── queries/
│   │   │       ├── users.ts
│   │   │       └── notes.ts
│   │   ├── middleware/
│   │   │   ├── auth.ts              # JWT verification
│   │   │   ├── ratelimit.ts         # Redis-backed rate limiting
│   │   │   └── csrf.ts              # CSRF protection
│   │   ├── plugins/
│   │   │   ├── redis.ts
│   │   │   └── websocket.ts
│   │   └── index.ts                 # Server entry point
│   ├── package.json
│   └── tsconfig.json
├── docker/                          ← Docker internals (not the compose file)
│   ├── nginx/
│   │   ├── nginx.conf
│   │   └── ssl/                     # TLS certs (Let's Encrypt or self-signed)
│   └── postgres/
│       └── init.sql
├── docker-compose.yml               ← at root — production
├── docker-compose.dev.yml           ← at root — development (hot reload)
├── .env.example                     ← at root — copy to .env and edit
├── GUIDE.md                         ← self-hosting guide (Docker, Tailscale, WireGuard/UFW)
├── docs/                            ← generated documentation
├── plans/                           ← planning and decision documents
├── README.md
├── TODO.md
├── LICENSE
└── .gitignore
```

---

## Backend Connection Model

The frontend build is **always the same** regardless of where it is accessed from (website, PWA on home screen, Electron app). There are no "modes."

At login and register, a subtle **server URL field** defaults to `https://api.bedroc.app` (the public hosted instance). Users change this to their own server URL to use a self-hosted backend. The chosen URL is saved to localStorage and multiple saved servers are remembered (dropdown switcher).

This transparently covers all use cases:

| Use case | Server URL |
| --- | --- |
| Public / commercial (bedroc.app) | `https://api.bedroc.app` (default) |
| Self-hosted on VPS / public domain | `https://notes.mydomain.com` |
| Self-hosted behind VPN / CGNAT | `https://100.x.x.x` (Tailscale) or `http://192.168.x.x:3000` |

The frontend URL is irrelevant — it is either a website the user visited and added to their home screen, or the Electron desktop app. Only the API endpoint changes.

---

## Encryption Architecture

This is the most critical part of the project. All encryption/decryption happens client-side using the browser's native WebCrypto API. The server only ever stores and relays encrypted ciphertext — it has no cryptographic keys.

### Key Derivation Flow (Registration)

```
User Password
    │
    ▼
PBKDF2 (600,000 iterations, SHA-256, random 32-byte salt)
    │
    ▼
Master Key (AES-256-GCM)
    │
    ├──► Encrypt a randomly generated "Data Encryption Key" (DEK)
    │        DEK is what actually encrypts notes
    │
    └──► Store salt + encrypted DEK in server (safe: DEK is encrypted)
```

**Why this two-layer approach?**
- If the user changes their password, only the DEK wrapper needs to be re-encrypted — not all notes
- The DEK itself never leaves the client in plaintext

### Login Flow

```
User Password + Salt (fetched from server by username)
    │
    ▼
PBKDF2 → Master Key
    │
    ▼
Decrypt the encrypted DEK (fetched from server) → DEK in memory
    │
    ▼
Use DEK to decrypt notes locally
```

The password is never sent to the server. For authentication, we use a challenge-response or SRP (Secure Remote Password) scheme:
- Server stores `verifier = H(salt || H(username || ":" || password))` (SRP v6a)
- Client proves knowledge of password without transmitting it
- If SRP is too complex for MVP, use: hash password client-side with Argon2-WASM before sending, never transmit raw password

### Note Encryption

```
Note plaintext (UTF-8 string)
    │
    ▼
AES-256-GCM encrypt with DEK + random 12-byte IV
    │
    ▼
{ iv: base64, ciphertext: base64, tag: included in GCM }
    │
    ▼
JSON.stringify → send to server
```

### Key Storage (Client)

- During session: DEK stored in memory only (JS variable, NOT localStorage, NOT sessionStorage)
- For "remember me" / persistent login: DEK wrapped with a device-specific key derived from a random value stored in IndexedDB, then the wrapped key is stored in IndexedDB. This means keys are tied to the device and cleared if IndexedDB is cleared.
- On logout: zero out all key material, clear IndexedDB session data, clear service worker cache

---

## Offline-First Architecture (IndexedDB)

Bedroc must remain **fully usable offline** — not just "viewable" but also writable, with all features working. This applies to the website/PWA on mobile (iOS Safari, Chrome, Firefox) and desktop browsers. IndexedDB is the primary local data store; the server is the sync target, not the source of truth while offline. Conflicts must be resolved easily, git-like structure that allows manual, or accept local/remote options. if no conflict, sync to server.

### IndexedDB as the Primary Store

IndexedDB serves three roles (not just one):

| Role | Description |
| --- | --- |
| **Primary read store** | All note list and editor views read from IndexedDB first — zero server round-trips for rendering |
| **Primary write store** | All saves write to IndexedDB immediately (after local encryption) — the user never waits for a server |
| **Sync queue** | Changes made offline are queued and flushed to the server when connectivity returns |

This architecture works identically on:

- iOS Safari in standalone PWA mode (Add to Home Screen)
- Chrome/Chromium on Android, Windows, macOS, Linux
- Firefox on all platforms
- Any browser that supports IndexedDB (all modern browsers)

### IndexedDB Schema

```
DB name: bedroc
Version: 1

Object stores:
  notes           — keyPath: id (UUID)
    id            : string (UUID, client-generated)
    encryptedBlob : string (JSON: { iv, ciphertext }) — PLACEHOLDER: plaintext in Phase 0–1
    topicId       : string | null
    createdAt     : number (Unix ms)
    updatedAt     : number (Unix ms)
    syncedAt      : number | null (null = not yet synced to server)
    serverVersion : number (for optimistic locking)

  topics          — keyPath: id (UUID)
    id            : string
    name          : string
    color         : string

  syncQueue       — keyPath: id (autoincrement)
    noteId        : string
    op            : 'upsert' | 'delete'
    payload       : string (encrypted blob or null for delete)
    queuedAt      : number

  keyMaterial     — keyPath: id (single record 'session')
    wrappedDek    : ArrayBuffer
    dekSalt       : ArrayBuffer
    deviceKey     : ArrayBuffer
```

### Sync Strategy

1. On app start (online): fetch `/api/notes/sync?since=<last_sync_ts>` — get any notes changed on other devices, write to IndexedDB, decrypt and display.
2. On save: write to IndexedDB immediately → add to `syncQueue` → attempt server push; if it fails (offline), leave in queue.
3. Service worker `sync` event (Background Sync API): flush `syncQueue` when connectivity returns. Falls back to polling on browsers without Background Sync support (Firefox).
4. On note open: read from IndexedDB. If a newer server version exists (detected during sync), show a merge/conflict notice.

### Service Worker Cache Strategy

- **App shell** (HTML, JS, CSS, icons): Cache-first — works fully offline after first load.
- **API calls**: Network-first with IndexedDB fallback — if offline, serve from local store.
- **No external CDN requests**: The app has no external font/script/image requests, so no special CDN caching is needed.

---

## Database Schema (PostgreSQL)

```sql
-- Users table
CREATE TABLE users (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    username    TEXT UNIQUE NOT NULL,
    -- SRP verifier (not a password hash)
    srp_salt    BYTEA NOT NULL,
    srp_verifier BYTEA NOT NULL,
    -- The user's DEK, encrypted with their Master Key
    encrypted_dek TEXT NOT NULL,
    dek_salt    BYTEA NOT NULL,
    created_at  TIMESTAMPTZ DEFAULT now(),
    updated_at  TIMESTAMPTZ DEFAULT now()
);

-- Notes table (server stores ONLY encrypted blobs)
CREATE TABLE notes (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    -- Encrypted content (AES-GCM ciphertext + IV as JSON)
    encrypted_content TEXT NOT NULL,
    -- Encrypted title (separate so list view can show titles if user chooses)
    encrypted_title   TEXT,
    -- Metadata for sync/conflict resolution (not encrypted)
    client_updated_at TIMESTAMPTZ NOT NULL,
    server_updated_at TIMESTAMPTZ DEFAULT now(),
    created_at  TIMESTAMPTZ DEFAULT now(),
    is_deleted  BOOLEAN DEFAULT false,  -- soft delete for sync
    version     INTEGER DEFAULT 1       -- optimistic locking
);

-- Sessions table
CREATE TABLE sessions (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash  TEXT NOT NULL,          -- hash of JWT, for revocation
    device_info TEXT,
    created_at  TIMESTAMPTZ DEFAULT now(),
    expires_at  TIMESTAMPTZ NOT NULL,
    revoked     BOOLEAN DEFAULT false
);
```

---

## API Endpoints

All endpoints return JSON. All note content is already encrypted by the client before reaching these endpoints.

### Auth
| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/auth/register` | Create account, store SRP verifier + encrypted DEK |
| POST | `/api/auth/login/init` | SRP step 1 — client sends username, server sends salt + challenge |
| POST | `/api/auth/login/verify` | SRP step 2 — client proves password, server issues JWT |
| POST | `/api/auth/logout` | Revoke session token |
| POST | `/api/auth/refresh` | Refresh JWT access token |

### Notes
| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/notes` | List all note metadata (no content) |
| GET | `/api/notes/:id` | Fetch single encrypted note blob |
| POST | `/api/notes` | Create note (send encrypted blob) |
| PUT | `/api/notes/:id` | Update note (send encrypted blob + version for optimistic lock) |
| DELETE | `/api/notes/:id` | Soft-delete note |
| GET | `/api/notes/sync?since=<timestamp>` | Delta sync — get all notes updated since timestamp |

### WebSocket
| Path | Description |
|------|-------------|
| `ws://host/ws` | Authenticated WebSocket for real-time push notifications |

WebSocket message types:
- `note:created` — another device created a note
- `note:updated` — another device updated a note
- `note:deleted` — another device deleted a note
- `ping` / `pong` — keepalive

---

## Authentication Flow (Detailed)

### Registration
1. User enters username + password
2. Client generates: `srp_salt` (random 32 bytes), SRP verifier
3. Client derives Master Key via PBKDF2(password, dek_salt, 600000, SHA-256)
4. Client generates random 32-byte DEK
5. Client encrypts DEK with Master Key → `encrypted_dek`
6. Client sends: `{ username, srp_salt, srp_verifier, encrypted_dek, dek_salt }` to `/api/auth/register`
7. Server stores the above — never sees the password or the DEK

### Login
1. User enters username + password
2. Client calls `/api/auth/login/init` with `{ username }`
3. Server returns `{ srp_salt, server_public_key }` (SRP B value)
4. Client completes SRP handshake, calls `/api/auth/login/verify`
5. Server verifies proof, returns `{ access_token, refresh_token, encrypted_dek, dek_salt }`
6. Client derives Master Key from password + dek_salt
7. Client decrypts `encrypted_dek` → DEK held in memory only
8. All subsequent note operations use this in-memory DEK

### Logout
1. Client calls `/api/auth/logout` (revokes token server-side)
2. Client zeros out DEK from memory
3. Client clears IndexedDB session/key data
4. Client clears service worker caches
5. Redirect to login page

---

## Real-Time Sync Architecture

### Strategy: Last-Write-Wins with Vector Clocks (MVP: timestamps)

**MVP approach (simpler)**:
- Each note has `client_updated_at` (set by the editing device) and `server_updated_at`
- On reconnect or save, client sends note with its `client_updated_at`
- Server accepts if `client_updated_at >= server's stored client_updated_at` for that note
- If conflict (two devices edited offline): server keeps newer `client_updated_at`, older is discarded with a client-side warning

**Real-time push (WebSocket)**:
- On save, server broadcasts `note:updated` event to all other connected sessions for that user
- Receiving clients fetch the updated encrypted note and decrypt locally
- If the local copy has a newer timestamp, it wins and re-saves

**Offline queue (CRITICAL)**:
- Changes made offline are queued in IndexedDB
- Service worker detects reconnect and flushes the queue
- Queue entries include the note blob and timestamp

---

## Service Worker & PWA Architecture

### Service Worker (`service-worker.ts`)
- **Cache strategy**: App shell (HTML, CSS, JS) uses Cache-First. API calls use Network-First with IndexedDB fallback.
- **Background sync**: Uses Background Sync API to flush offline queue when connectivity is restored
- **Push notifications**: Optional future feature for note sharing

### PWA Manifest (`manifest.webmanifest`)
```json
{
  "name": "Bedroc",
  "short_name": "Bedroc",
  "start_url": "/",
  "display": "standalone",
  "background_color": "#0f0f0f",
  "theme_color": "#0f0f0f",
  "icons": [/* 72, 96, 128, 144, 152, 192, 384, 512px */]
}
```

### iOS-Specific Fixes (in `app.html` and CSS)

```html
<!-- Prevent zoom on input focus -->
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1">

<!-- PWA capable -->
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
```

- All input/textarea elements: `font-size: 16px` minimum (prevents iOS zoom)
- App shell uses `position: fixed; height: 100%; overflow: hidden` to prevent container scroll when keyboard opens
- Scrollable areas get `-webkit-overflow-scrolling: touch`
- Non-scrollable areas: `touch-action: none` to prevent rubberbanding
- `touchmove` `preventDefault()` on non-scrollable containers

---

## Implementation Phases

### Phase 0 — Project Scaffolding
- [ ] Initialize pnpm workspace (`package.json` with `workspaces`)
- [ ] Create `apps/web` with SvelteKit + TypeScript + Tailwind
- [ ] Create `apps/server` with Fastify + TypeScript
- [ ] Set up ESLint, Prettier, shared tsconfig
- [ ] Set up Docker and docker-compose (Postgres + Redis)
- [ ] Set up `.env.example` with all required variables
- [ ] Initialize database migrations runner

### Phase 1 — Auth + Encryption Foundation
- [ ] Implement `apps/web/src/lib/crypto/keys.ts`: PBKDF2 key derivation, AES-GCM encrypt/decrypt, DEK generation and wrapping
- [ ] Implement SRP client (`apps/web/src/lib/crypto/srp.ts`)
- [ ] Implement SRP server (`apps/server/src/routes/auth.ts`)
- [ ] Build registration UI (`/register`) — username + password, strength meter, confirm password
- [ ] Build login UI (`/login`) — SRP flow
- [ ] Implement JWT issuance + refresh
- [ ] Implement secure logout (clear keys + IndexedDB + cache)
- [ ] Set up rate limiting (Redis-backed) on auth endpoints

### Phase 2 — Core Notes CRUD (Encrypted)
- [ ] Implement `apps/web/src/lib/crypto/encrypt.ts`: note encrypt/decrypt functions
- [ ] Implement `apps/web/src/lib/db/indexeddb.ts`: local note storage
- [ ] Build note list view (`/`) — fetch, decrypt, display titles
- [ ] Build note editor (`/note/[id]`) — create, edit, auto-save, encrypt on save
- [ ] Implement delete (soft-delete with sync)
- [ ] Implement server-side note CRUD endpoints
- [ ] Add optimistic locking (version field)

### Phase 3 — Real-Time Sync
- [ ] Implement WebSocket server (`apps/server/src/routes/sync.ts`)
- [ ] Implement WebSocket client (`apps/web/src/lib/sync/websocket.ts`)
- [ ] Implement conflict resolution (`apps/web/src/lib/sync/conflict.ts`)
- [ ] Delta sync endpoint (`/api/notes/sync?since=...`)
- [ ] Offline queue in IndexedDB + flush on reconnect

### Phase 4 — PWA & Service Worker
- [ ] Write `service-worker.ts` (app shell cache, offline fallback, background sync)
- [ ] Write `manifest.webmanifest`
- [ ] Add all PWA meta tags and iOS-specific fixes to `app.html`
- [ ] Test install on iOS Safari, Android Chrome
- [ ] Fix rubberbanding, keyboard scroll, input zoom

### Phase 5 — Security Hardening
- [ ] CSRF protection on all state-changing endpoints
- [ ] HTTP security headers (CSP, HSTS, X-Frame-Options, etc.) via Nginx + Fastify
- [ ] Input validation and sanitization (server-side, all endpoints)
- [ ] DoS / bot protection: rate limiting, request size limits, login lockout after N failures
- [ ] Session management: device list, remote revoke all sessions
- [ ] Audit: ensure no plaintext note data ever logged or stored server-side
- [ ] Audit: memory hygiene (zero out keys after use where possible in JS)

### Phase 6 — Editor Enhancements ✅ COMPLETE

- [x] Replace `document.execCommand` with TipTap (ProseMirror) — MIT-licensed, bundled, zero telemetry
- [x] Extensions: StarterKit, Underline, TextStyle, Color, FontSize, TextAlign, Subscript, Superscript, Highlight (multi-color), Typography, TaskList, TaskItem (nested), CharacterCount, Link, Table, TableRow, TableHeader, TableCell, Image (base64), Placeholder
- [x] Headings H1–H4 via dropdown; Code, Blockquote, Code block toolbar buttons
- [x] Text alignment (left / center / right / justify)
- [x] Font color — swatch panel + native color picker; color-at-cursor via `editor.getAttributes('textStyle').color`
- [x] Font size — preset dropdown; stored as `"16px"` (with unit) by extension, displayed without unit
- [x] Tables — insert 3×3, contextual add/delete row/column, delete table
- [x] Images — upload from device as base64 data URI (no server upload, fully encrypted)
- [x] Task lists with nested support and strikethrough on completion
- [x] Multi-color highlights via `<mark data-color="...">`
- [x] Link dialog — insert/remove inline links
- [x] Word/character count footer via CharacterCount storage
- [x] Cursor position preserved across saves and real-time sync updates
- [x] Sync, encrypt/decrypt, autosave, conflict resolution all preserved

### Phase 7 — Docker & Self-Hosting Documentation
- [ ] `docker-compose.yml` (production)
- [ ] `docker-compose.dev.yml` (development with hot-reload)
- [ ] Nginx config with TLS
- [ ] `GUIDE.md`:
  - Prerequisites
  - Quick start with Docker
  - Tailscale setup (for users behind CGNAT — no public IP needed)
  - WireGuard + UFW setup (for VPS users with public IP)
  - Let's Encrypt TLS with Certbot
  - Firewall rules
  - Backup and restore database
  - Updating Bedroc

### Phase 8 — Advanced Features (Post-MVP)
- [ ] Markdown rendering (using a self-hosted parser lib, no CDN)
- [ ] File attachments (client-side encrypted before upload)
- [ ] Note labels/folders
- [ ] Shared notes (requires asymmetric key exchange — X25519)
- [ ] Electron.js wrapper for Windows/macOS/Linux

---

## Security Checklist

- [ ] Passwords never transmitted or stored in plaintext
- [ ] All note content encrypted client-side before leaving the device
- [ ] Server cannot decrypt any user data
- [ ] Encryption keys never stored in localStorage/sessionStorage (only IndexedDB with wrapping, or memory-only)
- [ ] Keys zeroed from memory on logout
- [ ] SRP or equivalent — no password equivalent on the wire
- [ ] PBKDF2 with ≥600,000 iterations (NIST 2023 recommendation)
- [ ] AES-256-GCM with unique random IVs per encryption operation
- [ ] JWT tokens short-lived (15 min access, 7 day refresh)
- [ ] Refresh tokens rotated on use (rotation attack prevention)
- [ ] All sessions revocable from device list
- [ ] Rate limiting on all sensitive endpoints
- [ ] CSRF tokens on all state-changing requests
- [ ] Strict CSP preventing inline scripts and external resources
- [ ] HSTS enforced
- [ ] No sensitive data in URL parameters
- [ ] HTTP request logging must NOT log request bodies (contain encrypted blobs)
- [ ] DoS: request body size limits, connection limits
- [ ] Post-quantum: plan migration to CRYSTALS-KYBER (ML-KEM) for key encapsulation when WebCrypto support matures

---

## Environment Variables (`.env.example`)

```env
# Server
PORT=3000
NODE_ENV=production

# Database
DATABASE_URL=postgresql://bedroc:password@localhost:5432/bedroc

# Redis
REDIS_URL=redis://localhost:6379

# JWT
JWT_ACCESS_SECRET=<random 64-byte hex>
JWT_REFRESH_SECRET=<random 64-byte hex>
JWT_ACCESS_EXPIRY=15m
JWT_REFRESH_EXPIRY=7d

# CORS
CORS_ORIGIN=https://yourdomain.com

# Rate limiting
RATE_LIMIT_MAX=100
RATE_LIMIT_WINDOW=60000
LOGIN_MAX_ATTEMPTS=5
LOGIN_LOCKOUT_DURATION=900000
```

---

## Docker Compose (Production Sketch)

```yaml
services:
  postgres:
    image: postgres:16-alpine
    restart: unless-stopped
    environment:
      POSTGRES_DB: bedroc
      POSTGRES_USER: bedroc
      POSTGRES_PASSWORD: ${DB_PASSWORD}
    volumes:
      - postgres_data:/var/lib/postgresql/data
    networks: [bedroc]

  redis:
    image: redis:7-alpine
    restart: unless-stopped
    networks: [bedroc]

  server:
    build: ./apps/server
    restart: unless-stopped
    env_file: .env
    depends_on: [postgres, redis]
    networks: [bedroc]

  web:
    build: ./apps/web
    restart: unless-stopped
    networks: [bedroc]

  nginx:
    image: nginx:alpine
    restart: unless-stopped
    ports:
      - "80:80"
      - "443:443"
    volumes:
      - ./docker/nginx/nginx.conf:/etc/nginx/nginx.conf:ro
      - ./docker/nginx/ssl:/etc/nginx/ssl:ro
    depends_on: [server, web]
    networks: [bedroc]

volumes:
  postgres_data:

networks:
  bedroc:
    driver: bridge
```

---

## Verification Plan

After each phase:
1. **Phase 0**: `pnpm install` succeeds, `docker-compose up` starts Postgres + Redis, both apps compile with no TypeScript errors
2. **Phase 1**: Register a user, log in, log out — verify no password appears in network tab, verify DB has only verifier hash
3. **Phase 2**: Create/edit/delete notes — verify DB column contains only ciphertext, decryption works correctly after page reload
4. **Phase 3**: Open two browser tabs, edit in one — verify change appears in other tab within <1s; go offline, edit, come back online — verify sync
5. **Phase 4**: Install on iOS Safari and Android Chrome home screen; verify no zoom on input focus, no container scroll on keyboard open
6. **Phase 5**: Run OWASP ZAP scan; check security headers with securityheaders.com; test rate limiting with curl
7. **Phase 7**: Follow GUIDE.md on a fresh Ubuntu VPS from scratch and verify it works end-to-end
