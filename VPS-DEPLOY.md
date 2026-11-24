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
               │  server (API)  127.0.0.1:3000 only          │
               └────────────────────────────────────────────┘
                         │  internal Docker network (no internet)
               ┌────────────────────────────────────────────┐
               │  postgres      redis (password, RAM only)   │
               └────────────────────────────────────────────┘
```

**Key security properties:**

- PostgreSQL and Redis are on an internal Docker network: **no host ports, no internet access**. Redis requires a password and keeps nothing on disk
- Every container: read-only filesystem, all Linux capabilities dropped (Postgres keeps the five its entrypoint needs), `no-new-privileges`, process limits, size-capped logs
- Database migrations run in a one-off container; the long-running API never holds the database superuser password
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

Follow Docker's official instructions for your distribution (GUIDE.md, Part 1, has the Ubuntu/Debian commands). You **don't** need to add your user to the `docker` group: `bash bedroc.sh` uses `sudo` when Docker requires root. Docker-group membership is equivalent to root, so leaving it out keeps a hardened server hardened.

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
- The server trusts exactly `TRUST_PROXY` proxy hops (default `1` = Caddy). With Cloudflare in front, configure Caddy with `trusted_proxies` set to Cloudflare's IP ranges (so Caddy keeps Cloudflare's `X-Forwarded-For`) and set `TRUST_PROXY=2`. Otherwise every user appears to come from a Cloudflare edge IP and shares one rate-limit bucket
- See [Real client IPs behind Cloudflare](#real-client-ips-behind-cloudflare-optional-recommended) below for the Caddy setting

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

## Step 4 — Get the code and set up Bedroc

```bash
sudo mkdir -p /opt/Bedroc && sudo chown "$USER:$USER" /opt/Bedroc
git clone https://github.com/MrBiscuitTR/Bedroc.git /opt/Bedroc
cd /opt/Bedroc
bash bedroc.sh setup
```

Choose **1) public**. Accept port `3000`, or pick another if something else uses it. For the allowed frontend origins, keep `https://bedroc.cagancalidag.com,http://localhost:*` (hosted web app + desktop app) and add your own frontend if you host one. The script writes `.env.public` with **freshly generated, unique secrets** (database superuser, separate app-user password, Redis, both JWT keys) and mode 600. It never overwrites an existing env file. All options are explained in `.env.example`.

> **Already running Bedroc?** Don't run `setup`. Follow [UPGRADING.md](UPGRADING.md) instead.

Optional settings in `.env.public`:

- `ALLOW_REGISTRATION=false` after you've created your account(s), so strangers can't sign up.
- `ENABLE_ACCESS_LOG=true` writes the username and IP of every login to `logs/access.log` (off by default for privacy; `bash bedroc.sh check` sets up the folder permissions it needs).
- `RECORD_LOGIN_IP=false` stops storing IPs with sessions at all.

### Start the stack

```bash
bash bedroc.sh up
```

The script checks Docker access (and uses `sudo` if needed, asking for your password once), the env file, that port 3000 is free and that the data volume is the right one. Then it builds, starts, and waits until `postgres`, `redis` and `server` are healthy. Test locally:

```bash
curl -s http://127.0.0.1:3000/health
# → {"ok":true}
```

### Project name and your data

The script always uses compose project **`bedroc-public`** for `.env.public`. The project name selects the data volume (`bedroc-public_postgres_data`); the directory doesn't, so you can move the checkout without losing anything. If you ever run Compose by hand, keep the same flags:

```bash
bash bedroc.sh compose ps                 # = docker compose -p bedroc-public -f docker-compose.public.yml --env-file .env.public ps
```

If the expected volume doesn't exist but other Bedroc data volumes do, `bedroc.sh` refuses to start instead of silently creating a new, empty database.

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

    # Attachments are up to ~20 MB per upload
    request_body {
        max_size 25MB
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

> If you changed `BEDROC_PORT`, use that port in `reverse_proxy`. `bedroc.sh` never edits your Caddyfile.

### Real client IPs behind Cloudflare (optional, recommended)

With Cloudflare proxying, every request reaches Caddy from a Cloudflare IP. Unless Caddy trusts Cloudflare, Bedroc sees only Cloudflare IPs: all users then share one rate-limit bucket and the session list shows Cloudflare addresses. To fix it, add Cloudflare's published ranges as trusted proxies in Caddy's **global options** (top of the Caddyfile):

```caddy
{
    servers {
        # Paste the current ranges from https://www.cloudflare.com/ips/ (IPv4 and IPv6)
        trusted_proxies static 173.245.48.0/20 103.21.244.0/22 ...
    }
}
```

Then set `TRUST_PROXY=2` in `.env.public` and run `bash bedroc.sh up`. With this in place, a client that bypasses Cloudflare and connects to your origin directly still can't spoof its IP: Caddy only keeps `X-Forwarded-For` from the trusted ranges. This changes your Caddy configuration, so review it before reloading (`caddy validate --config /etc/caddy/Caddyfile`).

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

Off by default. With `ENABLE_ACCESS_LOG=true` in `.env.public`, every successful login and registration is appended to `./logs/access.log`:

```text
[2025-06-14T18:42:01.234Z] login    alice                    203.0.113.42
[2025-06-14T18:42:05.991Z] register bob                     198.51.100.7
```

Fields: `[timestamp]  event  username  ip-address`. The IP is the real client IP only if Caddy trusts Cloudflare (see above); otherwise it's a Cloudflare edge IP.

The server writes the file as uid 1001, so `./logs` must belong to that uid. `bash bedroc.sh check` detects a wrong owner and offers to fix just that directory. Read it with:

```bash
bash bedroc.sh access-log
```

### Log rotation

`/etc/logrotate.d/bedroc` (adjust the path):

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

### Privacy note

The log records **usernames and IP addresses** of authentication events. Notes are end-to-end encrypted, so neither the log nor the server can read their contents. If you run a public server with the access log on, say so in your privacy policy.

---

## Updating Bedroc

```bash
cd /opt/Bedroc
git pull
bash bedroc.sh update
```

`update` takes a verified database backup, builds the new images while the old containers keep running, restarts what changed, runs migrations, and waits for health checks. It stops at the first problem, and your data is never removed. Coming from a version before November 2026, or moving the checkout to another directory? See [UPGRADING.md](UPGRADING.md).

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

After editing, rebuild and restart: `bash bedroc.sh up`. Also raise Caddy's `request_body max_size` if you go above ~20 MB.

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
- [ ] Your user is **not** in the `docker` group (root-equivalent); `bedroc.sh` uses `sudo`
- [ ] Server port bound to `127.0.0.1` (the compose file does this; never change it to `0.0.0.0`)
- [ ] PostgreSQL and Redis **NOT** exposed on any host port (internal network only)
- [ ] `.env.public` is mode 600 and not committed (git-ignored)
- [ ] `bash bedroc.sh check` passes

### Application

- [ ] All secrets generated (by `bash bedroc.sh setup`, or `openssl rand -hex 32`), including `REDIS_PASSWORD`
- [ ] `CORS_ORIGIN` lists exact frontend origins (no `*`)
- [ ] `ALLOW_REGISTRATION=false` once your accounts exist (unless you run an open instance)
- [ ] `TRUST_PROXY` matches your proxy chain (1 = Caddy; 2 = Cloudflare → Caddy with `trusted_proxies`)
- [ ] `JWT_REFRESH_EXPIRY` set to a reasonable window (default `30d`)
- [ ] Access log on only if you need it (and disclosed in your privacy policy)

### TLS (Caddy handles automatically)

- [ ] Let's Encrypt certificate issued and valid
- [ ] TLS 1.2/1.3 only (Caddy default)
- [ ] HSTS header set with `preload` directive
- [ ] Certificate auto-renews (Caddy does this automatically)

---

## Backups

```bash
bash bedroc.sh backup                        # verified dump → ./backups/ (mode 600)
bash bedroc.sh restore backups/<file>.dump   # typed confirmation; takes a backup of the current state first
```

Nightly via cron, plus what else to keep safe: see [MANAGEMENT-GUIDE.md](MANAGEMENT-GUIDE.md#backups). Keep a copy of `.env.public` separately from the dumps.

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

1. Check the stack: `bash bedroc.sh status`
2. Test locally: `curl http://127.0.0.1:3000/health`
3. Test through Caddy (SNI-correct): `curl --resolve bedrocapi.cagancalidag.com:443:127.0.0.1 https://bedrocapi.cagancalidag.com/health`
4. Test publicly: `curl https://bedrocapi.cagancalidag.com/health`
5. Check Caddy: `sudo systemctl status caddy`

### CORS errors in the browser

- Confirm `CORS_ORIGIN` in `.env.public` matches **exactly** the frontend URL (including `https://`, no trailing slash)
- After changing `.env.public`, apply it: `bash bedroc.sh up`

- For local dev testing, use a comma-separated list:

  ```env
  CORS_ORIGIN=https://bedroc.cagancalidag.com,http://localhost:5173
  ```

### Server container keeps restarting

- `bash bedroc.sh logs server` and `bash bedroc.sh logs migrate`
- The server refuses to start on insecure settings and says why in its log, e.g. `CORS_ORIGIN must not contain "*"`, weak or identical JWT secrets, or `TRUST_PROXY=true`.

### Postgres authentication errors / an empty database

See [TROUBLESHOOTING.md](TROUBLESHOOTING.md#database). Never use `down -v` to fix this: it deletes all data.

### Access log not appearing (`logs/access.log` missing)

Check that `ENABLE_ACCESS_LOG=true` is set, then run `bash bedroc.sh check`. It offers to give `./logs` to uid 1001 (the server's user).

### Rate limited / 429 errors

- Global limit: 500 requests/minute per IP
- Login: 10 requests/minute per IP
- Register: 5 requests/minute per IP
- If testing, wait 60 seconds or restart the server container

### Adminer (DB GUI) via SSH tunnel

```bash
# On the VPS
bash bedroc.sh admin start        # listens on 127.0.0.1:8081 only

# On your computer
ssh -L 8081:127.0.0.1:8081 <user>@<vps-ip>
# open http://localhost:8081 — System: PostgreSQL · Server: postgres · User: postgres · Password: POSTGRES_PASSWORD · Database: bedroc

# On the VPS, when done
bash bedroc.sh admin stop
```

More fixes for Docker permissions, port conflicts, umask and SELinux: [TROUBLESHOOTING.md](TROUBLESHOOTING.md).
