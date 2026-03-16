# Bedroc — Claude Session Plans

This file records architectural decisions and session plans made during development conversations with Claude. Append new sessions at the bottom.

---

## Session 1 — Initial Planning

**Decisions made:**
- Tech stack: SvelteKit + TypeScript + Tailwind CSS (frontend), Fastify + Node.js (backend), PostgreSQL + Redis, WebSockets
- Encryption: WebCrypto API only (no third-party crypto libs), PBKDF2 → Argon2id (upgrade path), AES-256-GCM, SRP auth
- Two-layer key architecture: password → Master Key → encrypted DEK → notes
- Self-hosting: Docker + docker-compose, Nginx, Tailscale + WireGuard/UFW guides
- Full implementation plan written to `plans/INITIAL-PLAN.md`
- Security Q&A written to `plans/QA.md`

---

## Session 2 — Structure Decision + UI Shell Plan

### Repository Structure (confirmed: Option B — Docker at root)

```
Bedroc/                      ← root git repo
├── bedroc/                  ← SvelteKit frontend source
├── server/                  ← Fastify backend (future)
├── docker/                  ← nginx config, postgres init sql, ssl/
├── docker-compose.yml       ← at root, orchestrates everything
├── docker-compose.dev.yml
├── .env.example             ← at root
├── GUIDE.md                 ← self-hosting guide, at root
├── docs/                    ← all generated documentation
├── plans/                   ← planning and decision docs
├── LICENSE
└── README.md
```

**Why Option B (flat, Docker at root):**
The standard pattern for self-hostable open-source apps (Gitea, Immich, n8n, etc.). User clones repo, copies `.env.example` → `.env`, edits 3–4 lines, runs `docker-compose up -d`. No hunting in subfolders. Frontend source in `bedroc/`, backend source in `server/`, Docker internals in `docker/`, compose file at root.

The `self-hosting/` folder that was created is superseded by this structure — docker files live at root level.

---

### Backend Connection Model (confirmed)

There are no "modes" — there is one field: **server URL**.

- The frontend build is identical regardless of how it is accessed (website, PWA on home screen, Electron app).
- Login and register screens have a subtle **server URL field** defaulting to `https://bedrocapi.cagancalidag.com`.
- Users change it to their own server URL to use a self-hosted backend. The URL is saved to localStorage. Multiple saved servers are remembered (Bitwarden-style switcher).
- This transparently covers all three use cases:
  1. **Public/commercial** — leave default URL, create account on bedroc.app
  2. **Self-hosted on VPS/public IP** — enter `https://notes.mydomain.com`
  3. **Self-hosted behind VPN/CGNAT** — enter Tailscale IP `https://100.x.x.x` or LAN `http://192.168.x.x:3000`
- Frontend URL is irrelevant — it is either a website the user visited and added to home screen, or the Electron app.
- The server URL field is subtle: small text "Server: bedrocapi.cagancalidag.com ▾" that expands on tap/click to a text input + saved server dropdown.

---

### Design System

**Philosophy:** Calm, dense, trustworthy. Obsidian / Linear aesthetic — not a marketing page.

**Color tokens (CSS custom properties):**
```
--bg:          #0f1117   deep dark background
--bg-elevated: #16181f   cards, sidebar, panels
--bg-hover:    #1e2028   hover states
--border:      #2a2d37   subtle borders
--text:        #e2e4ed   primary text
--text-muted:  #8b8fa8   secondary text, labels
--text-faint:  #4a4d5e   disabled, placeholders
--accent:      #6b8afd   primary blue (actions, links, focus rings)
--accent-dim:  #3d5299   accent hover/pressed
--danger:      #e05c5c   destructive actions
--success:     #4caf87   confirmations
```

**Typography:** System font stack, no CDN. 14px base, 16px inputs (prevents iOS zoom on focus).

**Layout:**
- Desktop (≥768px): 240px fixed sidebar left + main content right
- Mobile (<768px): top header + bottom nav bar, full-width content

---

### UI Shell Files (Phase 0 — styles only, no logic)

- `bedroc/src/app.html` — PWA meta, iOS fixes, viewport, theme-color
- `bedroc/src/app.css` — global CSS, custom properties
- `bedroc/src/routes/+layout.svelte` — sidebar (desktop) + bottom nav (mobile)
- `bedroc/src/routes/+page.svelte` — notes list
- `bedroc/src/routes/login/+page.svelte` — login + server URL field
- `bedroc/src/routes/register/+page.svelte` — register + server URL field
- `bedroc/src/routes/note/[id]/+page.svelte` — note editor
- `bedroc/src/routes/settings/+page.svelte` — settings shell
- `bedroc/static/manifest.webmanifest` — PWA manifest
- `docs/frontend-shell.md` — documentation of all above

---

### Notes

- No `.git` inside `bedroc/` — root `.git` is the only git repo.
- User uses GitHub Desktop for commits — do not run git commands.
- Tailwind installed via `npx sv add tailwindcss` (requires clean working directory — user commits before running this).
- All code changes must be documented to `/docs/` with properly named `.md` files immediately after writing.
