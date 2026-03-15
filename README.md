# Bedroc

End-to-end encrypted, self-hostable, real-time notes app. The server never sees your note contents.

## Features

- **Zero-knowledge encryption** — AES-256-GCM per note, PBKDF2 (600k iterations) key derivation, SRP-6a authentication (password never sent to server)
- **Offline-first** — IndexedDB primary store; full read/write without connectivity; syncs when back online
- **Real-time sync** — WebSocket push with conflict detection; manual conflict resolution (keep local / keep server / custom merge)
- **Rich text editor** — TipTap (ProseMirror): headings, lists, task lists, tables, images, links, font color/size, highlights, code blocks, and more
- **PWA** — installable on iOS and Android; service worker for offline shell caching
- **Self-hostable** — Docker Compose stack (Fastify + PostgreSQL + Redis + nginx); or point the frontend at any backend URL

## Self-hosting

See [GUIDE.md](GUIDE.md) for the full Docker setup, WireGuard/Tailscale access, TLS, and backup instructions.

Quick start:

```bash
cp .env.example .env
# edit .env — set JWT_SECRET, POSTGRES_PASSWORD, etc.
docker compose up -d
```

## Development

```bash
# Frontend
cd bedroc
npm install
npm run dev        # http://localhost:5173

# Backend
cd server
npm install
npm run dev        # http://localhost:3000
```

See [DEV-GUIDE.md](DEV-GUIDE.md) for architecture details, API routes, and crypto implementation notes.

## Tech stack

| Layer | Tech |
| --- | --- |
| Frontend | SvelteKit 2, Svelte 5 (runes), TypeScript, Tailwind CSS 4, TipTap |
| Backend | Fastify, Node 22, TypeScript |
| Database | PostgreSQL |
| Cache / pub-sub | Redis |
| Crypto | WebCrypto API (PBKDF2, AES-256-GCM), SRP-6a (pure BigInt) |
| Deployment | Docker Compose, nginx |

## License

MIT
