# Bedroc — Public VPS Deployment Guide

This guide covers deploying the Bedroc **backend** on a public VPS (DigitalOcean, Hetzner, Linode, Vultr, etc.) so that it is reachable from the internet over HTTPS.

The **frontend** is already hosted on Vercel at `https://bedroc.cagancalidag.com` — you do not need to self-host the frontend. Users point the app at your backend URL.

---

## Architecture

```text
Internet
    │  HTTPS port 443
    ▼
┌──────────────────────────────────────────────────────┐
│  Caddy (on the host — handles TLS + reverse proxy)   │
│  api.yourdomain.com  ──▶  127.0.0.1:3000             │
└──────────────────────────────────────────────────────┘
    │
    ▼
┌─────────────────────────────────────────────────────┐
│  Docker network (internal only)                      │
│  ┌──────────┐  ┌───────┐  ┌──────────┐              │
│  │ postgres │  │ redis │  │  server  │ :3000         │
│  └──────────┘  └───────┘  └──────────┘              │
└─────────────────────────────────────────────────────┘
```

**Caddy** runs on the host (not in Docker). It:
- Automatically obtains and renews Let's Encrypt TLS certificates
- Proxies HTTPS traffic to the Fastify backend on `127.0.0.1:3000`
- Handles HTTP→HTTPS redirect automatically

The Bedroc Docker stack is **API-only** — no nginx, no frontend container. The frontend on Vercel talks to your backend via the domain you configure.

---

## Prerequisites

- A VPS running Ubuntu 22.04 LTS (or similar Debian-based Linux)
- A domain name — add an **A record** pointing to your VPS's public IP (e.g. `api.yourdomain.com` → `203.0.113.42`)
- Ports 80 and 443 open in your cloud firewall / control panel
- Docker and Docker Compose v2 installed

### Install Docker (if not already installed)

```bash
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker $USER
newgrp docker
```

---

## Step 1 — Harden the server

### Update the OS

```bash
sudo apt-get update && sudo apt-get upgrade -y
sudo apt-get install -y ufw fail2ban
```

### Configure the firewall (UFW)

```bash
sudo ufw default deny incoming
sudo ufw default allow outgoing
sudo ufw allow 22/tcp    # SSH
sudo ufw allow 80/tcp    # HTTP (Caddy ACME challenge + redirect)
sudo ufw allow 443/tcp   # HTTPS
sudo ufw enable
sudo ufw status
```

### Harden SSH

Edit `/etc/ssh/sshd_config`:

```text
PermitRootLogin no
PasswordAuthentication no
PubkeyAuthentication yes
MaxAuthTries 3
```

Restart SSH: `sudo systemctl restart sshd`

> Only do this after confirming your SSH key login works. Locking yourself out requires VPS console access.

### Enable fail2ban

```bash
sudo systemctl enable --now fail2ban
```

Default config blocks IPs that fail SSH auth too many times. This also applies to repeated failed login attempts.

---

## Step 2 — Install Caddy

```bash
sudo apt-get install -y debian-keyring debian-archive-keyring apt-transport-https curl
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
  | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
  | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt-get update
sudo apt-get install -y caddy
```

---

## Step 3 — Clone the repo and configure the stack

### Get the code

```bash
git clone https://github.com/MrBiscuitTR/Bedroc.git
cd Bedroc
```

### Create the environment file

Create `.env.public` (separate from `.env` so you can run both stacks side-by-side if needed):

```bash
cp .env.example .env.public
```

Edit `.env.public` and fill in every value:

```env
# PostgreSQL
POSTGRES_PASSWORD=<openssl rand -hex 32>
DATABASE_URL=postgres://bedroc_app:<same as POSTGRES_PASSWORD>@postgres:5432/bedroc

# Redis
REDIS_URL=redis://redis:6379

# JWT — generate two different secrets
JWT_ACCESS_SECRET=<openssl rand -hex 32>
JWT_REFRESH_SECRET=<openssl rand -hex 32>
JWT_ACCESS_EXPIRY=15m
JWT_REFRESH_EXPIRY=30d

# CORS — set to your frontend origin for strict mode, or leave empty to allow any
# Recommended for a public server: allow the official Bedroc frontend
CORS_ORIGIN=https://bedroc.cagancalidag.com

# Access log — set by docker-compose.public.yml automatically; leave as-is
ENABLE_ACCESS_LOG=true
```

> Generate secrets with: `openssl rand -hex 32`
> Never commit `.env.public` to git — it is in `.gitignore`.

### Start the stack

```bash
docker compose -f docker-compose.public.yml --env-file .env.public up -d
```

Verify all services are healthy:

```bash
docker compose -f docker-compose.public.yml --env-file .env.public ps
```

All three services (`postgres`, `redis`, `server`) should show `healthy` or `running`.

---

## Step 4 — Configure Caddy

Edit `/etc/caddy/Caddyfile` (replace `api.yourdomain.com` with your actual domain):

```caddy
# /etc/caddy/Caddyfile

api.yourdomain.com {
    # Proxy all requests to the Fastify backend
    reverse_proxy 127.0.0.1:3000

    # Security headers
    header {
        Strict-Transport-Security "max-age=31536000; includeSubDomains; preload"
        X-Content-Type-Options    "nosniff"
        X-Frame-Options           "DENY"
        Referrer-Policy           "strict-origin-when-cross-origin"
        Permissions-Policy        "camera=(), microphone=(), geolocation=()"
        -Server
    }

    # TLS: automatic Let's Encrypt (requires DNS A record pointing to this VPS)
    tls {
        protocols tls1.2 tls1.3
    }

    # Log access to Caddy's structured journal
    log {
        output stderr
        level  WARN
    }
}
```

Reload Caddy:

```bash
sudo systemctl reload caddy
```

Check that the certificate was issued:

```bash
sudo journalctl -u caddy -f
# You should see: certificate obtained successfully
```

Test the API:

```bash
curl https://api.yourdomain.com/health
# → {"ok":true}
```

---

## Step 5 — Connect from the app

1. Open `https://bedroc.cagancalidag.com`
2. Tap **Server: bedrocapi.cagancalidag.com ▾** to expand the server URL field
3. Enter `https://api.yourdomain.com`
4. Register and start using Bedroc

The server URL is saved — you won't need to enter it again on that device.

---

## Access logs

When `ENABLE_ACCESS_LOG=true` (set automatically by `docker-compose.public.yml`), every successful login and registration is appended to `./logs/access.log` on the host:

```text
[2025-06-14T18:42:01.234Z] login    alice                    203.0.113.42
[2025-06-14T18:42:05.991Z] register bob                     198.51.100.7
[2025-06-15T09:11:22.018Z] login    alice                    203.0.113.42
```

Fields: `[timestamp]  event  username  ip-address`

- Events: `login` (successful password auth) or `register` (new account)
- IPs come from the `X-Forwarded-For` header set by Caddy, falling back to the direct connection IP
- One file, append-only — rotate with `logrotate` if needed (see below)

### Read the log

```bash
tail -f logs/access.log                        # live
grep alice logs/access.log                     # all events for a user
awk '{print $4}' logs/access.log | sort | uniq -c | sort -rn   # IP frequency
```

### Log rotation with logrotate

Create `/etc/logrotate.d/bedroc`:

```text
/path/to/Bedroc/logs/access.log {
    daily
    rotate 30
    compress
    missingok
    notifempty
    copytruncate
}
```

Replace `/path/to/Bedroc` with the actual path. `copytruncate` truncates the file in-place without needing to signal the Node process.

### Privacy note

The log records **usernames and IP addresses** of authentication events only. Notes are end-to-end encrypted — neither the log nor the server can read note contents. If you run a public server, inform users that login IPs are logged per your privacy policy.

---

## Updating Bedroc

```bash
cd /path/to/Bedroc
git pull
docker compose -f docker-compose.public.yml --env-file .env.public build --no-cache server
docker compose -f docker-compose.public.yml --env-file .env.public up -d
```

---

## Changing the maximum attachment size

The default maximum file size for uploaded attachments (images, PDFs, etc.) is **15 MB per file**. To change it, edit two places in `server/src/routes/attachments.ts`:

**1. HTTP body limit:**

```typescript
bodyLimit: 20 * 1024 * 1024,   // change 20 to your desired MB ceiling
```

**2. Zod validation schema:**

```typescript
const MAX_ENCRYPTED_DATA_LENGTH = 19_000_000;  // ≈ sizeBytes * 1.37 + overhead

sizeBytes: z.number().int().min(0).max(15_000_000),  // max plaintext size
```

The relationship between these numbers:

- `sizeBytes` max = the maximum plaintext file size you want to allow.
- `MAX_ENCRYPTED_DATA_LENGTH` ≈ `sizeBytes × 1.37` + JSON envelope overhead (base64 inflation + AES-GCM wrapping).
- `bodyLimit` = `MAX_ENCRYPTED_DATA_LENGTH` + ~1 MB safety margin.

After editing, rebuild and restart the server container:

```bash
docker compose -f docker-compose.public.yml --env-file .env.public build --no-cache server
docker compose -f docker-compose.public.yml --env-file .env.public up -d server
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

- [ ] Docker daemon NOT exposed on a TCP socket (use Unix socket only)
- [ ] Server port bound to `127.0.0.1:3000` — not `0.0.0.0:3000`
- [ ] postgres and redis NOT exposed on any host port (internal network only)
- [ ] `.env.public` not committed to git

### Application

- [ ] All secrets generated with `openssl rand -hex 32` (never the `CHANGE_THIS_*` placeholders)
- [ ] `CORS_ORIGIN` set to your specific frontend URL (not `*`) for maximum strictness
- [ ] `JWT_REFRESH_EXPIRY` set to a reasonable window (default `30d`)

### TLS (Caddy handles this automatically)

- [ ] Let's Encrypt certificate issued (`sudo caddy list-certificates`)
- [ ] TLS 1.2/1.3 only (Caddy default)
- [ ] HSTS header set with `preload` directive
- [ ] Certificate auto-renews (Caddy does this automatically)

---

## Sharing port 443 with other sites

Caddy supports multiple sites in a single `Caddyfile`. Each block gets its own automatic certificate:

```caddy
api.yourdomain.com {
    reverse_proxy 127.0.0.1:3000
    # ... headers as above
}

blog.yourdomain.com {
    root * /var/www/blog
    file_server
}

another-app.yourdomain.com {
    reverse_proxy 127.0.0.1:4000
}
```

---

## Backups

Same as the WireGuard setup — see [MANAGEMENT-GUIDE.md](MANAGEMENT-GUIDE.md) for backup commands. Use `-f docker-compose.public.yml --env-file .env.public` instead of the default compose invocation.

---

## Troubleshooting

### Certificate not issuing

- Confirm the DNS A record points to your VPS IP: `dig +short api.yourdomain.com`
- Confirm ports 80 and 443 are open: `sudo ufw status`
- Check Caddy logs: `sudo journalctl -u caddy -f`

### "Cannot reach server" from the app

- Confirm the stack is running: `docker compose -f docker-compose.public.yml --env-file .env.public ps`
- Test the API directly: `curl https://api.yourdomain.com/health`
- Check Caddy is running: `sudo systemctl status caddy`

### CORS errors in the browser

- Confirm `CORS_ORIGIN` in `.env.public` matches exactly the frontend URL (including `https://`, no trailing slash)
- For local dev testing, add `http://localhost:5173` to `CORS_ORIGIN` as a comma-separated second value

### Server container keeps restarting

- Check logs: `docker compose -f docker-compose.public.yml --env-file .env.public logs server`
- Common causes: missing or wrong `DATABASE_URL`/`JWT_*` secrets in `.env.public`
