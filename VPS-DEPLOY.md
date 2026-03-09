# Bedroc — Public VPS Deployment Guide

This guide covers deploying Bedroc on a public VPS (DigitalOcean, Hetzner, Linode, Vultr, etc.) where:

- The server is reachable from the internet over ports 80 and 443
- Other sites or services can share the same ports (using a reverse proxy)
- Security is hardened for public exposure

> **Privacy note:** Making your Bedroc server public means anyone who finds the URL can reach the registration page. All notes are end-to-end encrypted — the server cannot read them regardless. But if you want only yourself to use your server, consider adding HTTP basic auth in front of the registration endpoint, or simply use the WireGuard setup in [GUIDE.md](GUIDE.md) instead.

---

## Architecture

```
Internet
    │  port 80/443
    ▼
┌──────────────────────────────────────────────────────┐
│  Caddy (reverse proxy, TLS, automatic certs)         │
│  Listens on 0.0.0.0:80 and 0.0.0.0:443             │
│                                                      │
│  api.yourdomain.com  ──▶  Bedroc stack (port 3000)  │
│  other.yourdomain.com ──▶  other service             │
└──────────────────────────────────────────────────────┘
    │
    ▼
┌─────────────────────────────────────────────────────┐
│  Docker network (internal only)                      │
│  ┌──────────┐  ┌───────┐  ┌──────────┐              │
│  │ postgres │  │ redis │  │  server  │ port 3000     │
│  └──────────┘  └───────┘  └──────────┘              │
└─────────────────────────────────────────────────────┘
```

We use **Caddy** as the public reverse proxy because it:
- Automatically obtains and renews Let's Encrypt certificates
- Has a simple, readable config format
- Handles HTTP→HTTPS redirect automatically
- Can serve multiple sites on the same ports with zero extra config

The Bedroc Docker stack runs **without** its nginx container — Caddy takes over TLS termination and proxies directly to the Fastify server on an internal port.

---

## Prerequisites

- A VPS running Ubuntu 22.04 LTS (or similar Debian-based Linux)
- A domain name with an A record pointing to your VPS IP
- Ports 80 and 443 open in your firewall / cloud control panel
- Docker and Docker Compose installed (see [GUIDE.md](GUIDE.md) → Part 1)

---

## Step 1 — Harden the server

### Update the OS

```bash
sudo apt-get update && sudo apt-get upgrade -y
sudo apt-get install -y ufw fail2ban
```

### Configure the firewall (UFW)

```bash
# Default: deny incoming, allow outgoing
sudo ufw default deny incoming
sudo ufw default allow outgoing

# SSH (adjust port if you use a non-standard SSH port)
sudo ufw allow 22/tcp

# Web traffic
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp

# Enable
sudo ufw enable
sudo ufw status
```

### Harden SSH

Edit `/etc/ssh/sshd_config`:

```
PermitRootLogin no
PasswordAuthentication no
PubkeyAuthentication yes
AuthorizedKeysFile .ssh/authorized_keys
MaxAuthTries 3
```

Restart SSH: `sudo systemctl restart sshd`

> Only do this after confirming your SSH key login works. Locking yourself out requires console access to the VPS.

### Set up fail2ban (block brute-force)

```bash
sudo systemctl enable fail2ban
sudo systemctl start fail2ban
```

Default config blocks IPs that fail SSH authentication too many times. For extra protection, add a jail for nginx/Caddy logs as well.

---

## Step 2 — Install Caddy

```bash
sudo apt-get install -y debian-keyring debian-archive-keyring apt-transport-https curl
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt-get update
sudo apt-get install -y caddy
```

---

## Step 3 — Configure the Bedroc Docker stack

### Get the code

```bash
git clone https://github.com/MrBiscuitTR/Bedroc.git
cd Bedroc
```

### Create a modified docker-compose for public deployment

Create `docker-compose.public.yml` in the repo root:

```yaml
# docker-compose.public.yml
# Public VPS variant: no nginx container, server exposed on localhost:3000
# Caddy (on the host) handles TLS and proxying.

services:

  postgres:
    image: postgres:16-alpine
    restart: unless-stopped
    environment:
      POSTGRES_DB: bedroc
      POSTGRES_USER: postgres
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD}
      DATABASE_URL: ${DATABASE_URL}
    volumes:
      - postgres_data:/var/lib/postgresql/data
      - ./docker/postgres/init.sh:/docker-entrypoint-initdb.d/init.sh:ro
    networks:
      - internal
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U postgres -d bedroc"]
      interval: 10s
      timeout: 5s
      retries: 5
      start_period: 30s

  redis:
    image: redis:7-alpine
    restart: unless-stopped
    command: redis-server --save 60 1 --loglevel warning
    volumes:
      - redis_data:/data
    networks:
      - internal
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 10s
      timeout: 3s
      retries: 5

  server:
    build:
      context: ./server
      dockerfile: Dockerfile
    restart: unless-stopped
    environment:
      HOST: 127.0.0.1   # Bind to localhost only — Caddy proxies from the host
      PORT: 3000
      NODE_ENV: production
      DATABASE_URL: ${DATABASE_URL}
      POSTGRES_URL: postgresql://postgres:${POSTGRES_PASSWORD}@postgres:5432/bedroc
      REDIS_URL: ${REDIS_URL}
      JWT_ACCESS_SECRET: ${JWT_ACCESS_SECRET}
      JWT_REFRESH_SECRET: ${JWT_REFRESH_SECRET}
      JWT_ACCESS_EXPIRY: ${JWT_ACCESS_EXPIRY:-15m}
      JWT_REFRESH_EXPIRY: ${JWT_REFRESH_EXPIRY:-7d}
      CORS_ORIGIN: ${CORS_ORIGIN}
    ports:
      # Expose server on localhost only — NOT on 0.0.0.0
      - "127.0.0.1:3000:3000"
    networks:
      - internal
    depends_on:
      postgres:
        condition: service_healthy
      redis:
        condition: service_healthy

  bedroc:
    build:
      context: ./bedroc
      dockerfile: Dockerfile
    restart: unless-stopped
    ports:
      # Frontend on localhost:8080 — Caddy proxies to it
      - "127.0.0.1:8080:8080"
    networks:
      - internal

networks:
  internal:
    driver: bridge

volumes:
  postgres_data:
  redis_data:
```

### Create the .env file

```bash
cp .env.example .env
```

Fill in `.env`:

```env
POSTGRES_PASSWORD=<run: openssl rand -hex 32>
DATABASE_URL=postgres://bedroc_app:<same as POSTGRES_PASSWORD>@postgres:5432/bedroc
REDIS_URL=redis://redis:6379
JWT_ACCESS_SECRET=<run: openssl rand -hex 32>
JWT_REFRESH_SECRET=<run: openssl rand -hex 32>
JWT_ACCESS_EXPIRY=15m
JWT_REFRESH_EXPIRY=7d
CORS_ORIGIN=
```

### Start the stack

```bash
docker compose -f docker-compose.public.yml up -d
```

Verify: `docker compose -f docker-compose.public.yml ps` — all services should be healthy/running.

---

## Step 4 — Configure Caddy

Edit `/etc/caddy/Caddyfile`:

```caddy
# /etc/caddy/Caddyfile

# Bedroc API (Fastify backend)
api.yourdomain.com {
    # Proxy API requests to the Fastify server
    reverse_proxy /api/* 127.0.0.1:3000
    reverse_proxy /ws    127.0.0.1:3000
    reverse_proxy /health 127.0.0.1:3000

    # Serve the SvelteKit frontend for all other paths
    reverse_proxy 127.0.0.1:8080

    # Security headers
    header {
        Strict-Transport-Security "max-age=31536000; includeSubDomains; preload"
        X-Content-Type-Options "nosniff"
        X-Frame-Options "SAMEORIGIN"
        Referrer-Policy "strict-origin-when-cross-origin"
        Permissions-Policy "camera=(), microphone=(), geolocation=()"
        Content-Security-Policy "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self' https: wss:; font-src 'self'; object-src 'none'; frame-ancestors 'self';"
        -Server
    }

    # TLS: automatic Let's Encrypt (requires DNS A record pointing here)
    tls {
        protocols tls1.2 tls1.3
    }
}

# Other site on the same server (example)
# other.yourdomain.com {
#     root * /var/www/other
#     file_server
# }
```

> **Replace `api.yourdomain.com`** with your actual domain. Make sure the DNS A record for that domain points to your VPS IP.

Reload Caddy:

```bash
sudo systemctl reload caddy
```

Check that the certificate was issued:
```bash
sudo journalctl -u caddy -f
```

---

## Step 5 — Connect from the app

1. Open `https://bedroc.cagancalidag.com` (or any Bedroc frontend)
2. Tap **Server: api.bedroc.app ▾** to expand the server field
3. Enter `https://api.yourdomain.com`
4. Register and start using Bedroc

The server URL is saved — you won't need to enter it again on that device.

---

## Updating Bedroc

```bash
cd /path/to/Bedroc
git pull
docker compose -f docker-compose.public.yml build --no-cache server bedroc
docker compose -f docker-compose.public.yml up -d
```

---

## Security hardening checklist

### Server-level
- [ ] SSH root login disabled (`PermitRootLogin no`)
- [ ] SSH password auth disabled (`PasswordAuthentication no`)
- [ ] UFW enabled with only ports 22, 80, 443 open
- [ ] fail2ban running
- [ ] OS kept up to date (`apt-get upgrade` regularly or unattended-upgrades)

### Docker
- [ ] Docker daemon NOT exposed on a TCP socket (use Unix socket `/var/run/docker.sock` only)
- [ ] Server binds to `127.0.0.1:3000`, NOT `0.0.0.0:3000` — only Caddy can reach it
- [ ] postgres and redis NOT exposed on any host port (internal network only)

### Application
- [ ] All secrets in `.env` are randomly generated (never the `CHANGE_THIS_*` placeholders)
- [ ] `.env` is not committed to git
- [ ] `CORS_ORIGIN` is either empty (open) or set to your specific frontend URL

### TLS (Caddy handles this automatically)
- [ ] Let's Encrypt certificate issued (`sudo caddy list-certificates`)
- [ ] TLS 1.2/1.3 only (Caddy default)
- [ ] HSTS header set with `preload` directive
- [ ] Certificate auto-renews (Caddy does this automatically every 60 days)

---

## Sharing port 443 with other sites

Caddy supports multiple sites in a single `Caddyfile`. Each `domain.com { }` block gets its own automatic certificate. Just add more blocks:

```caddy
api.yourdomain.com {
    # Bedroc backend (as above)
}

notes.yourdomain.com {
    # Bedroc frontend served directly
    reverse_proxy 127.0.0.1:8080
}

blog.yourdomain.com {
    root * /var/www/blog
    file_server
}

another-app.yourdomain.com {
    reverse_proxy 127.0.0.1:4000
}
```

Caddy automatically handles ACME challenges, certificate issuance, and renewal for each domain. No port conflict — all share 80/443.

---

## Backups

Same as the WireGuard setup — see [MANAGEMENT-GUIDE.md](MANAGEMENT-GUIDE.md) for backup commands. Use `docker compose -f docker-compose.public.yml exec postgres ...` instead of `docker compose exec postgres ...`.

---

## Troubleshooting

### Certificate not issuing

- Make sure the DNS A record points to your VPS IP (`dig api.yourdomain.com`)
- Make sure ports 80 and 443 are open in your firewall
- Check Caddy logs: `sudo journalctl -u caddy -f`

### "Cannot reach server" from the app

- Confirm the server is running: `docker compose -f docker-compose.public.yml ps`
- Test the API directly: `curl https://api.yourdomain.com/health`
- Check Caddy is running: `sudo systemctl status caddy`

### App shows "Unreachable" but curl works

The browser may have cached an old certificate warning. Clear site data or try an incognito window.

### Multiple docker-compose files

If you already use the WireGuard setup and want to add public access, keep both compose files. Run the public stack with `-f docker-compose.public.yml`. They use separate containers and ports, so they don't conflict.
