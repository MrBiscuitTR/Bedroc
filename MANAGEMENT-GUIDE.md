# Bedroc — Management Guide

This guide covers day-to-day operations: viewing and editing database records, creating backups, rotating secrets, and administrative tasks. It applies to both public backend operators (running `api.bedroc.app` or similar) and private self-hosters.

---

## Database Management GUI (Adminer)

Adminer is a lightweight, single-file database management UI included in the Docker stack.

### Accessing Adminer

Adminer is bound to the WireGuard interface only (`10.66.66.1:8080`). You must be connected to WireGuard to access it.

1. Connect to WireGuard
2. Open `http://10.66.66.1:8080` in a browser
3. Fill in the login form:

| Field    | Value              |
|----------|--------------------|
| System   | PostgreSQL         |
| Server   | `postgres`         |
| Username | `postgres`         |
| Password | your `POSTGRES_PASSWORD` from `.env` |
| Database | `bedroc`           |

> **Important:** Log in as `postgres` (the superuser), not as `bedroc_app`. The `bedroc_app` role has limited permissions and cannot view schema structure in Adminer properly.

### Disabling Adminer

If you do not need the GUI, comment out the `adminer` service in `docker-compose.yml`:

```yaml
# adminer:
#   image: adminer:latest
#   ...
```

Then restart: `docker compose up -d`

---

## Key Database Tables

All note content is **encrypted client-side** before it ever reaches the server. The server only stores ciphertext — you cannot read note content from the database.

| Table      | Contents |
|------------|----------|
| `users`    | user ID, username, SRP verifier (password-derived, not the password), encrypted DEK, DEK salt |
| `notes`    | note ID, user ID, encrypted title + body (AES-256-GCM), topic ID, timestamps, version |
| `topics`   | topic ID, user ID, name, color, folder ID, sort order |
| `folders`  | folder ID, user ID, name, parent folder ID, sort order |
| `sessions` | refresh token hash, user ID, expiry, device info |

### Viewing all users

```sql
SELECT id, username, created_at FROM users ORDER BY created_at DESC;
```

### Viewing a user's sessions

```sql
SELECT id, created_at, expires_at, user_agent
FROM sessions
WHERE user_id = '<userId>'
ORDER BY created_at DESC;
```

### Counting notes per user

```sql
SELECT u.username, COUNT(n.id) AS note_count
FROM users u
LEFT JOIN notes n ON n.user_id = u.id AND n.is_deleted = false
GROUP BY u.id, u.username
ORDER BY note_count DESC;
```

---

## Deleting a User (Manual / Admin)

To delete a user and all their data:

```sql
-- Delete everything in order (foreign keys cascade, but explicit is safer)
DELETE FROM sessions WHERE user_id = '<userId>';
DELETE FROM notes WHERE user_id = '<userId>';
DELETE FROM topics WHERE user_id = '<userId>';
DELETE FROM folders WHERE user_id = '<userId>';
DELETE FROM users WHERE id = '<userId>';
```

Or in one statement (if foreign keys use `ON DELETE CASCADE`):

```sql
DELETE FROM users WHERE id = '<userId>';
```

> **Note:** Deleting a user's server record does not wipe their local device IndexedDB. Their notes remain readable offline until they log out or clear site data. This is by design — the client owns its local data.

---

## Revoking All Sessions for a User

```sql
DELETE FROM sessions WHERE user_id = '<userId>';
```

The user's refresh cookie becomes invalid. They will be prompted to log in again on next page load.

---

## Backups

### Automated backup (recommended)

Add a cron job on the host to dump the database daily:

```bash
# /etc/cron.d/bedroc-backup — runs at 2am every day
0 2 * * * root docker exec bedroc-postgres-1 \
  pg_dump -U postgres bedroc | \
  gzip > /var/backups/bedroc/bedroc-$(date +%Y%m%d).sql.gz
```

Create the backup directory first: `mkdir -p /var/backups/bedroc`

### Manual backup

```bash
docker exec bedroc-postgres-1 pg_dump -U postgres bedroc | gzip > bedroc-backup.sql.gz
```

### Restore from backup

```bash
gunzip -c bedroc-backup.sql.gz | docker exec -i bedroc-postgres-1 psql -U postgres bedroc
```

### What to back up

- **`postgres_data` volume** — all user data (notes, topics, sessions). This is the critical backup.
- **`.env` file** — JWT secrets and passwords. Without this, a restored database is inaccessible.
- **`docker/ssl/`** — TLS certificates (only matters if you generated them for this server).

> The notes themselves are encrypted — backing up the database does not expose user content.

---

## Rotating JWT Secrets

Rotating JWT secrets invalidates all active sessions. All users will be logged out.

1. Generate new secrets:
   ```bash
   openssl rand -hex 32   # run twice, once for each secret
   ```

2. Update `.env`:
   ```
   JWT_ACCESS_SECRET=<new_value>
   JWT_REFRESH_SECRET=<new_value>
   ```

3. Restart the server:
   ```bash
   docker compose up -d server
   ```

---

## Rotating the Database Password

1. Update the password in PostgreSQL:
   ```sql
   ALTER USER bedroc_app WITH PASSWORD 'new_password';
   ALTER USER postgres WITH PASSWORD 'new_postgres_password';
   ```

2. Update `.env`:
   ```
   DATABASE_URL=postgres://bedroc_app:new_password@postgres:5432/bedroc
   POSTGRES_PASSWORD=new_postgres_password
   ```

3. Restart:
   ```bash
   docker compose up -d server
   ```

---

## Log Access

```bash
# All services
docker compose logs -f

# Specific service
docker compose logs -f server
docker compose logs -f nginx

# nginx access log (mounted volume)
docker exec bedroc-nginx-1 tail -f /var/log/nginx/access.log
```

---

## Monitoring Disk Usage

```bash
# Docker volumes
docker system df -v

# Database size
docker exec bedroc-postgres-1 psql -U postgres -c \
  "SELECT pg_size_pretty(pg_database_size('bedroc'));"

# Per-table sizes
docker exec bedroc-postgres-1 psql -U postgres -d bedroc -c \
  "SELECT relname AS table, pg_size_pretty(pg_total_relation_size(oid)) AS size
   FROM pg_class WHERE relkind = 'r' ORDER BY pg_total_relation_size(oid) DESC;"
```

---

## Stopping and Restarting Services

```bash
# Graceful restart of one service (zero downtime for others)
docker compose restart server

# Full stack restart
docker compose down && docker compose up -d

# Rebuild and restart (after code changes)
docker compose build --no-cache server && docker compose up -d server
```

---

## Tailscale Setup (Alternative to WireGuard)

Tailscale is a simpler alternative to a manually configured WireGuard server. It uses the same WireGuard protocol under the hood but handles key exchange and peer discovery automatically.

### Why Tailscale

- Zero config peer-to-peer VPN — no WireGuard key management
- Works through NAT and CGNAT (useful for home servers, dynamic IPs)
- Each device gets a stable `100.x.x.x` address that never changes
- Built-in ACLs, MagicDNS, and exit nodes
- Free for personal use (up to 3 users)

### Install Tailscale on the server

```bash
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up
```

Follow the URL printed to authenticate the machine to your Tailscale account.

### Get the server's Tailscale IP

```bash
tailscale ip -4
# e.g. 100.64.0.5
```

### Bind Bedroc to the Tailscale interface

In `.env`, set `HOST` to the Tailscale IP so the Fastify server only listens on the Tailscale interface:

```env
HOST=100.64.0.5
PORT=3000
```

Or use `0.0.0.0` if you also want LAN access, and rely on `ufw` to block public internet access to port 3000.

### Adjust docker-compose.yml port binding

Change the server port mapping so it only listens on the Tailscale IP:

```yaml
server:
  ports:
    - "100.64.0.5:3000:3000"   # Tailscale IP only, not public internet
```

Then restart:

```bash
docker compose up -d server
```

### Expose Adminer over Tailscale (optional)

```yaml
adminer:
  ports:
    - "100.64.0.5:8080:8080"
```

Access it at `http://100.64.0.5:8080` from any Tailscale-connected device.

### Access from clients

1. Install Tailscale on your phone/laptop and sign in with the same account
2. The server appears at its `100.x.x.x` address automatically
3. In the Bedroc app, set the server URL to `http://100.64.0.5:3000` (or use MagicDNS: `http://servername:3000`)

### TLS with Tailscale (optional)

Tailscale provides free TLS certificates for `*.ts.net` domains via `tailscale cert`:

```bash
sudo tailscale cert servername.your-tailnet.ts.net
```

This creates `servername.your-tailnet.ts.net.crt` and `.key`. Mount them into nginx:

```bash
mkdir -p docker/ssl
cp servername.your-tailnet.ts.net.crt docker/ssl/cert.pem
cp servername.your-tailnet.ts.net.key docker/ssl/key.pem
```

Then update `nginx.conf` to use them (same as the WireGuard setup). Access at `https://servername.your-tailnet.ts.net`.

### Firewall: block public access to the Bedroc port

If your host has a public IP, ensure the Bedroc port is not reachable from the internet:

```bash
sudo ufw deny 3000/tcp    # block public access to Fastify
sudo ufw allow in on tailscale0 to any port 3000   # allow Tailscale interface only
```

---

## Security Checklist (for public operators)

- [ ] WireGuard is the only way to reach Adminer — it is NOT exposed to the internet
- [ ] `POSTGRES_PASSWORD` is a randomly generated secret (not `CHANGE_THIS_*`)
- [ ] `JWT_ACCESS_SECRET` and `JWT_REFRESH_SECRET` are separate 32+ character random secrets
- [ ] `.env` is not committed to git (it is in `.gitignore`)
- [ ] `docker/ssl/key.pem` is not committed to git
- [ ] Backups are running and tested
- [ ] The host OS is kept up to date (`apt upgrade` / `yum update`)
- [ ] Docker daemon is not exposed on a TCP socket (use Unix socket only)
