# Bedroc — Public VPS Deployment Guide

This guide covers deploying the Bedroc **backend** on a public VPS so that it is reachable from the internet over HTTPS, behind Cloudflare DNS proxy.

The **frontend** is hosted on Vercel at `https://bedroc.cagancalidag.com` — you do not need to self-host the frontend. Users point the app at your backend URL.

---

## Architecture

```text
Client browser  ──▶  Cloudflare (DNS proxy + edge TLS)
                         │
                    HTTPS to origin (port 443)
                         │
                         ▼
               ┌────────────────────────────────────────────┐
               │  Caddy (on the host)                        │
               │  bedrocapi.cagancalidag.com → 127.0.0.1:3000│
               │  - TLS termination (Let's Encrypt)          │
               │  - Security headers                         │
               │  - Reverse proxy                            │
               └────────────────────────────────────────────┘
                         │
                         ▼
               ┌────────────────────────────────────────────┐
               │  Docker network (internal only)             │
               │  ┌──────────┐ ┌───────┐ ┌──────────┐       │
               │  │ postgres │ │ redis │ │  server  │ :3000  │
               │  └──────────┘ └───────┘ └──────────┘       │
               └────────────────────────────────────────────┘
```

**Key security properties:**

- PostgreSQL and Redis are on an internal Docker network — **no host ports exposed**
- The Fastify server binds to `127.0.0.1:3000` — only Caddy can reach it
- Caddy handles TLS termination with a real Let's Encrypt certificate
- Cloudflare provides DDoS protection, edge caching of static content, and hides the origin IP
- CORS is locked to the exact frontend origin (`https://bedroc.cagancalidag.com`)
- All data is end-to-end encrypted — the server never sees plaintext note content

---

## Prerequisites

- A VPS running **Ubuntu 22.04+ LTS** (Debian-based)
- A domain with an **A record** pointing to your VPS IP (e.g. `bedrocapi.cagancalidag.com → 203.0.113.42`)
- The domain managed in **Cloudflare DNS** (free plan is fine)
- Ports **80** and **443** open in your cloud provider's firewall
- Docker and Docker Compose v2 installed

### Install Docker (if not already installed)

```bash
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker $USER
# Log out and back in, or run: newgrp docker
```

---

## Step 1 — Harden the server

### Update the OS and install security tools

```bash
sudo apt-get update && sudo apt-get upgrade -y
sudo apt-get install -y ufw fail2ban unattended-upgrades
```

Enable automatic security updates:

```bash
sudo dpkg-reconfigure -plow unattended-upgrades
# Select "Yes" to enable automatic security updates
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

> **Do NOT** open any other ports. PostgreSQL (5432), Redis (6379), and the Fastify server (3000) must never be accessible from the internet.

### Harden SSH

Edit `/etc/ssh/sshd_config`:

```text
PermitRootLogin no
PasswordAuthentication no
PubkeyAuthentication yes
MaxAuthTries 3
AllowUsers your_username
```

Restart SSH:

```bash
sudo systemctl restart sshd
```

> **Only do this after confirming your SSH key login works.** Locking yourself out requires VPS console access.

### Enable fail2ban

```bash
sudo systemctl enable --now fail2ban
```

Default config blocks IPs that fail SSH auth too many times.

---

## Step 2 — Configure Cloudflare DNS

1. Go to your Cloudflare dashboard → DNS → add an **A record**:
   - **Name**: `bedrocapi` (or your chosen subdomain)
   - **Content**: your VPS IP address
   - **Proxy status**: **Proxied** (orange cloud) — this hides your origin IP and enables Cloudflare's DDoS protection

2. Go to **SSL/TLS** → set the mode to **Full (strict)**:
   - This means Cloudflare connects to your origin (Caddy) over HTTPS with a valid certificate
   - Caddy's Let's Encrypt cert satisfies this requirement
   - **Never use "Flexible"** — it sends traffic from Cloudflare to your origin over plain HTTP, which is insecure

3. Go to **SSL/TLS → Edge Certificates** → enable **Always Use HTTPS**

4. Go to **SSL/TLS → Edge Certificates** → set **Minimum TLS Version** to **TLS 1.2**

### About logging with Cloudflare proxy

When Cloudflare is proxied, your server sees Cloudflare's IP in the TCP connection, not the client's real IP. However:

- Cloudflare sets `CF-Connecting-IP` and `X-Forwarded-For` headers with the real client IP
- Caddy passes these headers through to the backend
- Fastify has `trustProxy: true`, so `req.ip` and rate limiting use the real client IP from `X-Forwarded-For`
- The access log (`logs/access.log`) records the real client IP correctly

---

## Step 3 — Install Caddy

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

## Step 4 — Clone the repo and configure the stack

### Get the code

```bash
cd /opt
sudo git clone https://github.com/MrBiscuitTR/Bedroc.git
sudo chown -R $USER:$USER Bedroc
cd Bedroc
```

### Create the environment file

```bash
cp .env.example .env.public
```

Edit `.env.public` — **replace every placeholder** with real values:

```env
# PostgreSQL — generate a strong random password
POSTGRES_PASSWORD=<run: openssl rand -hex 32>
DATABASE_URL=postgres://bedroc_app:<SAME_PASSWORD_AS_ABOVE>@postgres:5432/bedroc

# Redis (internal network, no auth needed — not exposed on any host port)
REDIS_URL=redis://redis:6379

# JWT — generate TWO DIFFERENT secrets (min 32 chars each)
JWT_ACCESS_SECRET=<run: openssl rand -hex 32>
JWT_REFRESH_SECRET=<run: openssl rand -hex 32>
JWT_ACCESS_EXPIRY=15m
JWT_REFRESH_EXPIRY=30d

# CORS — MUST match the exact frontend origin, including https:// and NO trailing slash.
# This prevents other websites from making API requests to your backend.
# For the public Bedroc instance:
CORS_ORIGIN=https://bedroc.cagancalidag.com

# Access logging — records login/register events with IP and username
ENABLE_ACCESS_LOG=true
```

Generate secrets:

```bash
# Run these and paste the output into .env.public
openssl rand -hex 32   # → POSTGRES_PASSWORD
openssl rand -hex 32   # → JWT_ACCESS_SECRET
openssl rand -hex 32   # → JWT_REFRESH_SECRET
```

> **Never commit `.env.public` to git** — it is in `.gitignore`.

### Create the logs directory with correct permissions

The server runs as a non-root user (`uid 1001`) inside Docker. The `logs/` directory is mounted from the host, so the host directory must be writable by that uid:

```bash
mkdir -p ~/opt/Bedroc/logs
sudo chown -R 1001:1001 ~/opt/Bedroc/logs
```

> Skip this if the directory already exists and logging works. If `logs/access.log` never appears after logins, this is almost certainly why.

### Install the helper command

All stack operations use several flags (`-p`, `-f`, `--env-file`). Install a wrapper so you never forget them:

```bash
sudo tee /usr/local/bin/bedroc-public >/dev/null <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
cd /home/biscuit/opt/Bedroc
exec docker compose -p bedroc-public -f docker-compose.public.yml --env-file .env.public "$@"
EOF
sudo chmod +x /usr/local/bin/bedroc-public
```

> Adjust the `cd` path to wherever your repo lives. The `-p bedroc-public` flag is **critical** — see the isolation note below.

### Start the stack

```bash
bedroc-public up -d
```

Verify all services are healthy:

```bash
bedroc-public ps
```

All three services (`postgres`, `redis`, `server`) should show `healthy` or `running`.

Test the API locally:

```bash
curl http://127.0.0.1:3000/health
# → {"ok":true}
```

### Why `-p bedroc-public` matters

Docker Compose derives a project name from the directory name by default. If the directory is called `Bedroc`, the project name becomes `bedroc` — which collides with any other Compose stack in the same directory (e.g. a previous WireGuard/private deployment). A collision means Compose reuses existing volumes (old Postgres data, wrong passwords) instead of creating fresh ones.

Always use `-p bedroc-public` explicitly. With the helper script this is automatic.

Resources created with the correct project name:

- Containers: `bedroc-public-server-1`, `bedroc-public-postgres-1`, `bedroc-public-redis-1`
- Volumes: `bedroc-public_postgres_data`, `bedroc-public_redis_data`
- Network: `bedroc-public_internal`

If you accidentally started without `-p bedroc-public` and ended up with stale volumes, stop the stack, identify the rogue volumes with `docker volume ls`, and remove them (`docker volume rm <name>`) before restarting with the correct project name.

---

## Step 5 — Configure Caddy

Edit `/etc/caddy/Caddyfile`:

```caddy
# /etc/caddy/Caddyfile
#
# IMPORTANT: Replace bedrocapi.cagancalidag.com with YOUR subdomain.
# Each site block gets its own Let's Encrypt certificate automatically.
# Other sites on this VPS get their own blocks — Caddy routes by hostname.

bedrocapi.cagancalidag.com {
    # Proxy all requests to the Fastify backend
    reverse_proxy 127.0.0.1:3000

    # Security headers (defense in depth — Fastify also sets these via helmet)
    header {
        Strict-Transport-Security "max-age=31536000; includeSubDomains; preload"
        X-Content-Type-Options    "nosniff"
        X-Frame-Options           "DENY"
        Referrer-Policy           "strict-origin-when-cross-origin"
        Permissions-Policy        "camera=(), microphone=(), geolocation=()"
        # Remove the Server header to avoid leaking software info
        -Server
    }

    # TLS — Let's Encrypt automatic. Caddy handles renewal.
    tls {
        protocols tls1.2 tls1.3
    }

    # Structured access log — set to WARN to avoid noise.
    # For debugging, temporarily change to INFO.
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
sudo journalctl -u caddy --since "5 minutes ago"
# Look for: "certificate obtained successfully"
```

> **Note**: If Cloudflare proxy is enabled, Caddy obtains the certificate via the HTTP-01 ACME challenge. Cloudflare passes port 80 traffic through to your origin for this. If cert issuance fails, check that port 80 is open in your firewall.

Test the API through Caddy (locally):

```bash
curl -k https://127.0.0.1/health -H "Host: bedrocapi.cagancalidag.com"
# → {"ok":true}
```

Test through Caddy locally (SNI-correct method):

```bash
curl --resolve bedrocapi.cagancalidag.com:443:127.0.0.1 https://bedrocapi.cagancalidag.com/health
# → {"ok":true}
```

Test through the public URL (after Cloudflare DNS propagates):

```bash
curl https://bedrocapi.cagancalidag.com/health
# → {"ok":true}
```

---

## Step 6 — Connect from the app

1. Open `https://bedroc.cagancalidag.com`
2. Tap the server URL field (or go to Settings)
3. Enter `https://bedrocapi.cagancalidag.com`
4. Register and start using Bedroc

The server URL is saved in the browser — you won't need to enter it again on that device.

---

## Sharing port 443 with other APIs/sites

Caddy routes requests by hostname. Each site block gets its own TLS certificate. Other APIs on the same VPS are completely isolated — requests to `bedrocapi.cagancalidag.com` only reach the Bedroc backend, never other services.

```caddy
bedrocapi.cagancalidag.com {
    reverse_proxy 127.0.0.1:3000
    # ... headers as above
}

other-api.yourdomain.com {
    reverse_proxy 127.0.0.1:4000
}

blog.yourdomain.com {
    root * /var/www/blog
    file_server
}
```

**Cross-contamination is not possible** because:

1. Caddy only forwards requests to the backend whose hostname matches the `Host` header
2. The Docker containers bind to `127.0.0.1` on different ports — they cannot reach each other
3. CORS on the Bedroc server rejects requests from any origin other than the configured `CORS_ORIGIN`
4. Even if someone crafts a request with a spoofed `Origin` header (e.g. via curl), all authenticated endpoints require a valid JWT — there is no way to access data without a valid token
5. Cloudflare proxy hides your origin IP, so attackers cannot bypass Caddy by connecting directly

---

## Access logs

When `ENABLE_ACCESS_LOG=true`, every successful login and registration is appended to `./logs/access.log`:

```text
[2025-06-14T18:42:01.234Z] login    alice                    203.0.113.42
[2025-06-14T18:42:05.991Z] register bob                     198.51.100.7
```

Fields: `[timestamp]  event  username  ip-address`

- IPs are the **real client IPs** from Cloudflare's `X-Forwarded-For` header — not Cloudflare edge IPs
- Events: `login` (successful auth) or `register` (new account)

### Read the log

```bash
tail -f logs/access.log                        # live feed
grep alice logs/access.log                     # all events for a user
awk '{print $4}' logs/access.log | sort | uniq -c | sort -rn   # IP frequency
```

### Log rotation

Create `/etc/logrotate.d/bedroc`:

```text
/opt/Bedroc/logs/access.log {
    daily
    rotate 30
    compress
    missingok
    notifempty
    copytruncate
}
```

`copytruncate` truncates the file in-place without needing to signal the Node process.

### Privacy note

The log records **usernames and IP addresses** of authentication events only. Notes are end-to-end encrypted — neither the log nor the server can read note contents. If you run a public server, inform users that login IPs are logged per your privacy policy.

---

## Updating Bedroc

```bash
cd ~/opt/Bedroc
git pull
bedroc-public build --no-cache server
bedroc-public up -d
```

> `bedroc-public up -d` (without `down` first) does a rolling update — it only recreates containers whose image or config changed, leaving the database untouched.

---

## Changing the maximum attachment size

The default maximum file size for uploaded attachments is **15 MB per file**. To change it, edit two places in `server/src/routes/attachments.ts`:

**1. HTTP body limit:**

```typescript
bodyLimit: 20 * 1024 * 1024,   // change 20 to your desired MB ceiling
```

**2. Zod validation schema:**

```typescript
const MAX_ENCRYPTED_DATA_LENGTH = 19_000_000;  // ≈ sizeBytes * 1.37 + overhead
sizeBytes: z.number().int().min(0).max(15_000_000),  // max plaintext size
```

The relationship: `sizeBytes` max = max plaintext file size. `MAX_ENCRYPTED_DATA_LENGTH` ≈ `sizeBytes × 1.37` (base64 + AES-GCM overhead). `bodyLimit` = `MAX_ENCRYPTED_DATA_LENGTH` + ~1 MB margin.

After editing, rebuild:

```bash
bedroc-public build --no-cache server
bedroc-public up -d server
```

---

## Security architecture

### What protects the server

| Layer | Protection | Details |
| --- | --- | --- |
| **Cloudflare** | DDoS, bot detection, origin IP hiding | Free plan is sufficient. "Full (strict)" SSL mode required |
| **UFW firewall** | Port isolation | Only 22, 80, 443 open. DB/Redis/app ports blocked |
| **fail2ban** | SSH brute-force prevention | Bans IPs after repeated auth failures |
| **Caddy** | TLS termination, hostname routing | Routes by `Host` header — other VPS services are unreachable via Bedroc's domain |
| **Docker networking** | Service isolation | PostgreSQL and Redis on internal-only bridge network, no host ports |
| **127.0.0.1 binding** | Localhost-only API | The Fastify server port is only reachable from the host (by Caddy) |
| **CORS** | Browser origin enforcement | Only `CORS_ORIGIN` can make credentialed requests from a browser |
| **Rate limiting** | Brute-force protection | 500 req/min global, 10/min on login, 5/min on register (per IP) |
| **SRP-6a auth** | Zero-knowledge password proof | Server never sees or stores passwords — only a verifier |
| **E2E encryption** | Data protection | Notes encrypted client-side with AES-256-GCM; server stores ciphertext only |
| **JWT auth** | Session security | Short-lived access tokens (15min) + httpOnly refresh cookies |
| **Helmet** | HTTP security headers | HSTS, X-Content-Type-Options, X-Frame-Options, CSP |

### What attackers cannot do

- **Read notes**: all note data is AES-256-GCM encrypted client-side. The server stores only ciphertext.
- **Steal passwords**: SRP-6a zero-knowledge proof — the server never receives the plaintext password.
- **Bypass CORS from a browser**: `CORS_ORIGIN` is checked strictly. Browsers enforce this.
- **Bypass CORS from curl/scripts**: all authenticated endpoints require a valid JWT. Without a valid session, you get 401.
- **Reach other APIs on the VPS**: Caddy routes strictly by hostname. A request to `bedrocapi.cagancalidag.com` only reaches port 3000.
- **Reach the database directly**: PostgreSQL and Redis are on an internal Docker network with no host ports.
- **Connect to the origin directly**: Cloudflare proxy hides the origin IP. Even if discovered, the firewall blocks all ports except 22/80/443, and Caddy requires a matching hostname.

### What is NOT protected by CORS (and why that's OK)

CORS is a **browser-only** protection. A determined attacker with curl can send requests with any `Origin` header. This is fine because:

1. All data-modifying endpoints require a valid JWT (issued only after SRP-6a authentication)
2. The refresh token is in an httpOnly cookie — it cannot be stolen via XSS
3. Rate limiting caps brute-force attempts at 10/min per IP for login
4. SRP-6a means even a successful interception of the auth handshake reveals nothing about the password
5. All note content is encrypted before leaving the client — the server cannot read it

---

## Security hardening checklist

### Server-level

- [ ] SSH root login disabled (`PermitRootLogin no`)
- [ ] SSH password auth disabled (`PasswordAuthentication no`)
- [ ] SSH restricted to your username (`AllowUsers your_username`)
- [ ] UFW enabled with only ports 22, 80, 443 open
- [ ] fail2ban running (`sudo systemctl status fail2ban`)
- [ ] Automatic security updates enabled (`unattended-upgrades`)
- [ ] OS kept up to date (`sudo apt-get upgrade` regularly)

### Cloudflare

- [ ] Proxy status **enabled** (orange cloud) for the API subdomain
- [ ] SSL/TLS mode set to **Full (strict)**
- [ ] Always Use HTTPS enabled
- [ ] Minimum TLS version set to **1.2**
- [ ] (Optional) Enable **Bot Fight Mode** in Security settings
- [ ] (Optional) Create a firewall rule to challenge requests from unusual countries

### Docker

- [ ] Docker daemon uses Unix socket only (not TCP)
- [ ] Server port bound to `127.0.0.1:3000` — not `0.0.0.0:3000`
- [ ] PostgreSQL and Redis **NOT** exposed on any host port (internal network only)
- [ ] `.env.public` not committed to git

### Application

- [ ] All secrets generated with `openssl rand -hex 32` (never placeholders)
- [ ] `CORS_ORIGIN` set to the exact frontend URL (`https://bedroc.cagancalidag.com`)
- [ ] `JWT_REFRESH_EXPIRY` set to a reasonable window (default `30d`)
- [ ] Access logging enabled (`ENABLE_ACCESS_LOG=true`)

### TLS (Caddy handles automatically)

- [ ] Let's Encrypt certificate issued and valid
- [ ] TLS 1.2/1.3 only (Caddy default)
- [ ] HSTS header set with `preload` directive
- [ ] Certificate auto-renews (Caddy does this automatically)

---

## Backups

Same as the WireGuard setup — see [MANAGEMENT-GUIDE.md](MANAGEMENT-GUIDE.md) for backup commands. Replace any raw `docker compose` invocation with `bedroc-public` to pick up the correct project name and env file.

---

## Troubleshooting

### Certificate not issuing

- Confirm DNS resolves: `dig +short bedrocapi.cagancalidag.com`
- If using Cloudflare proxy, ensure port 80 is open (ACME HTTP-01 challenge goes through Cloudflare to your origin)
- Alternatively, temporarily set the DNS record to **DNS only** (grey cloud) while Caddy issues the cert, then re-enable proxy
- Check Caddy logs: `sudo journalctl -u caddy -f`

### Caddy fails to start — "address already in use" on port 80 or 443

Another web server (nginx, Apache, an old proxy) is holding the port:

```bash
sudo ss -ltnp | awk '$4 ~ /:80$|:443$/ {print}'
```

If nginx is the culprit and you no longer need it:

```bash
sudo systemctl disable --now nginx
sudo systemctl start caddy
```

### "Cannot reach server" from the app

1. Check the stack: `bedroc-public ps`
2. Test locally: `curl http://127.0.0.1:3000/health`
3. Test through Caddy (SNI-correct): `curl --resolve bedrocapi.cagancalidag.com:443:127.0.0.1 https://bedrocapi.cagancalidag.com/health`
4. Test publicly: `curl https://bedrocapi.cagancalidag.com/health`
5. Check Caddy: `sudo systemctl status caddy`

### CORS errors in the browser

- Confirm `CORS_ORIGIN` in `.env.public` matches **exactly** the frontend URL (including `https://`, no trailing slash)
- After changing `.env.public`, restart the server:

  ```bash
  bedroc-public up -d server
  ```

- For local dev testing, use a comma-separated list:

  ```env
  CORS_ORIGIN=https://bedroc.cagancalidag.com,http://localhost:5173
  ```

### Server container keeps restarting

- Check logs: `bedroc-public logs server`
- Common causes: missing or wrong `DATABASE_URL` / `JWT_*` secrets in `.env.public`

### Postgres authentication errors / wrong data in DB

This usually means Compose reused a volume from a different deployment (missing `-p bedroc-public`). Check which volumes exist:

```bash
docker volume ls | grep bedroc
```

If you see `bedroc_postgres_data` (no `public` prefix) alongside `bedroc-public_postgres_data`, you accidentally started the stack without the project flag at some point. Stop the stack and confirm you're always using `bedroc-public` commands.

To start fresh with a clean database (destructive — all data lost):

```bash
bedroc-public down -v   # removes containers AND volumes
bedroc-public up -d
```

### Access log not appearing (`logs/access.log` missing)

The server runs as uid 1001 inside the container. The host `logs/` directory must be owned by that uid:

```bash
sudo chown -R 1001:1001 ~/opt/Bedroc/logs
bedroc-public restart server
```

After the next login or registration, `logs/access.log` should appear.

### Rate limited / 429 errors

- Global limit: 500 requests/minute per IP
- Login: 10 requests/minute per IP
- Register: 5 requests/minute per IP
- If testing, wait 60 seconds or restart the server container

### Adminer (DB GUI) via SSH tunnel

Adminer is not included in the public stack by default. To inspect the database, run a temporary Adminer container attached to the internal network, then tunnel to it:

```bash
# On the VPS — start Adminer temporarily
docker run -d --rm --name adminer-tmp \
  --network bedroc-public_internal \
  -p 127.0.0.1:8080:8080 \
  adminer:latest

# On your local machine — open the tunnel (use a different local port if 8080 is taken)
ssh -L 18080:127.0.0.1:8080 biscuit@<vps-ip>

# Open http://localhost:18080 in your browser
# System: PostgreSQL | Server: postgres | Username/Password: from .env.public | Database: bedroc

# Stop Adminer when done
docker stop adminer-tmp
```
