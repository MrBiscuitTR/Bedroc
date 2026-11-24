# Bedroc — Management Guide

This guide covers day-to-day operations: viewing and editing database records, creating backups, rotating secrets, and administrative tasks. It applies to both public backend operators and private self-hosters.

**Running SQL:** `bash bedroc.sh psql` opens a PostgreSQL shell in the right container. The examples below that use `docker exec bedroc-postgres-1 …` assume the compose project is called `bedroc`. Replace the prefix with yours: `bedroc-public` for the public stack (`bedroc-public-postgres-1`), or whatever `bash bedroc.sh status` shows. If Docker needs root on your machine, prefix `docker` with `sudo`.

---

## Database Management GUI (Adminer)

Adminer is a lightweight, single-file database management UI included in the Docker stack.

### Accessing Adminer

Adminer is **not running by default**. Start it only when you need it:

```bash
bash bedroc.sh admin start     # WireGuard stack: http://<BIND_IP>:8080   ·   public stack: http://127.0.0.1:8081
bash bedroc.sh admin stop      # when you're done
```

On the public stack it listens on localhost only. Reach it through an SSH tunnel from your computer:

```bash
ssh -L 8081:127.0.0.1:8081 <user>@<server>      # then open http://localhost:8081
```

Fill in the login form:

| Field    | Value              |
|----------|--------------------|
| System   | PostgreSQL         |
| Server   | `postgres`         |
| Username | `postgres`         |
| Password | your `POSTGRES_PASSWORD` from the env file |
| Database | `bedroc`           |

> **Important:** log in as `postgres` (the superuser), not as `bedroc_app`. The `bedroc_app` role has limited permissions and cannot view schema structure in Adminer properly.

Change the port with `ADMINER_PORT=<port>` in the env file.

---

## Key Database Tables

All note content is **encrypted client-side** before it ever reaches the server. The server only stores ciphertext — you cannot read note content from the database.

| Table | Contents |
| --- | --- |
| `users` | user ID, username, SRP verifier (password-derived, not the password), encrypted DEK, DEK salt |
| `notes` | note ID, user ID, encrypted title + body (AES-256-GCM), topic ID, timestamps, version, `is_deleted` flag |
| `topics` | topic ID, user ID, name, color, folder ID, sort order |
| `folders` | folder ID, user ID, name, parent folder ID, sort order |
| `sessions` | refresh token hash, user ID, expiry, device info |
| `attachments` | SHA-256 hash + user ID (PK), encrypted blob (AES-256-GCM), mime type, size — keyed by content hash, stored once per user |

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

## Cleaning Up Deleted Notes and Orphaned Attachments

Notes are **soft-deleted** — the row stays in the database with `is_deleted = true` so other devices can sync the deletion. Attachments are stored separately and are not automatically cleaned up when a note is deleted (the server stores ciphertext and cannot parse attachment references from note bodies).

Run this periodically to hard-delete old soft-deleted notes and their now-orphaned attachments:

```sql
-- Step 1: Hard-delete soft-deleted notes older than 30 days.
-- Adjust the interval as you prefer (7 days, 30 days, etc.).
DELETE FROM notes
WHERE is_deleted = true
  AND server_updated_at < now() - interval '30 days';

-- Step 2: Delete attachment records that are no longer referenced by any note.
-- Since note bodies are encrypted (ciphertext), the server cannot parse attachment
-- hashes from them. This query deletes all attachments for users who have zero
-- remaining notes — safe only if Step 1 has already run.
--
-- For users who still have notes, orphaned attachments cannot be identified
-- server-side. They will linger until account deletion (which cascades via
-- ON DELETE CASCADE on user_id). This is acceptable — they are encrypted and
-- only readable by the account owner.
DELETE FROM attachments
WHERE user_id NOT IN (SELECT DISTINCT user_id FROM notes WHERE is_deleted = false);
```

> **Safe to run anytime.** Hard-deleting a soft-deleted note cannot cause data loss — clients have already processed the deletion via the sync delta. The 30-day window gives ample time for offline devices to sync before the row is gone.

### Automating cleanup (optional)

Add a daily cron job on the host:

```bash
# /etc/cron.d/bedroc-cleanup — runs at 3am every day
0 3 * * * root docker exec bedroc-postgres-1 psql -U postgres -d bedroc -c \
  "DELETE FROM notes WHERE is_deleted = true AND server_updated_at < now() - interval '30 days'; \
   DELETE FROM attachments WHERE user_id NOT IN (SELECT DISTINCT user_id FROM notes WHERE is_deleted = false);"
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

```bash
bash bedroc.sh backup                         # verified dump → ./backups/<project>-<UTC time>.dump (mode 600)
bash bedroc.sh restore backups/<file>.dump    # replace the database (typed confirmation; takes a backup first)
```

`bash bedroc.sh update` always takes a verified backup before changing anything. Restore also accepts `.sql` / `.sql.gz` files made by plain `pg_dump` (e.g. older cron jobs).

### Automated backup (recommended)

```cron
# /etc/cron.d/bedroc-backup — 03:15 every day, as root (Docker usually needs root)
15 3 * * * root cd /opt/Bedroc && bash bedroc.sh backup >> /var/log/bedroc-backup.log 2>&1
```

Old backups are never deleted automatically. Prune them yourself, e.g. `find /opt/Bedroc/backups -name '*.dump' -mtime +30 -delete`.

### What to back up

- **The database dumps** in `./backups/`: all user data (notes, topics, sessions).
- **The env file** (`.env.public` or `.env`): JWT secrets and passwords. Without it, a restored database can't be used. Store it separately from the dumps.
- **`docker/ssl/`** (WireGuard stack): TLS certificate and key.

> Notes are encrypted, but dumps also contain usernames, password verifiers, wrapped keys and **plaintext topic/folder names**. Treat backups as sensitive.

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

3. Apply: `bash bedroc.sh up`

---

## Rotating the Redis Password

Redis only holds short-lived login challenges, so this is safe at any time:

1. Set a new `REDIS_PASSWORD` in the env file (letters and digits only: `openssl rand -hex 32`).
2. `bash bedroc.sh up`. Redis and the API restart with the new password; logins in progress at that moment must be retried.

---

## Rotating the Database Password

1. Update the password in PostgreSQL (`bash bedroc.sh psql`):
   ```sql
   ALTER USER bedroc_app WITH PASSWORD 'new_password';
   ALTER USER postgres WITH PASSWORD 'new_postgres_password';
   ```
   Changing only the env file does **not** change the passwords inside an existing database, so do this step first.

2. Update `.env`:
   ```
   DATABASE_URL=postgres://bedroc_app:new_password@postgres:5432/bedroc
   POSTGRES_PASSWORD=new_postgres_password
   ```

3. Apply: `bash bedroc.sh up`

---

## Log Access

```bash
bash bedroc.sh logs                 # recent logs of every service
bash bedroc.sh logs server -f       # follow one service (server, postgres, redis, migrate, nginx, bedroc)
bash bedroc.sh access-log           # login access log (public stack, only if ENABLE_ACCESS_LOG=true)
```

Container logs are size-capped (3 × 10 MB per container). For privacy, nginx doesn't write an access log. To debug, temporarily set `access_log /dev/stdout;` in `docker/nginx/nginx.conf` and run `bash bedroc.sh up`.

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
bash bedroc.sh restart server     # restart one service
bash bedroc.sh down               # stop everything (all data is kept)
bash bedroc.sh up                 # start / apply config changes (rebuilds what changed)
bash bedroc.sh update             # after git pull: backup → rebuild → restart → health check
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

Run `bash bedroc.sh setup`, choose **wireguard**, and enter the Tailscale IP (e.g. `100.64.0.5`) as the address to listen on. It's stored as `BIND_IP` in `.env`, and nginx publishes ports 80/443 on that address only. No compose file edits are needed. `bash bedroc.sh check` verifies the address exists on the machine.

Adminer, when started with `bash bedroc.sh admin start`, also listens only on that address.

### Access from clients

1. Install Tailscale on your phone/laptop and sign in with the same account
2. The server appears at its `100.x.x.x` address automatically
3. Open `https://100.64.0.5` (accept the self-signed certificate once), or use the server URL `https://100.64.0.5` in the app

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

Restart with `bash bedroc.sh up`. Add `https://servername.your-tailnet.ts.net` to `CORS_ORIGIN` and open that address.

### Firewall

Nothing extra is needed: nginx is bound to the Tailscale address only, and the API, database and Redis publish no host ports at all.

---

## Security Checklist (for public operators)

- [ ] Adminer is stopped when not in use (`bash bedroc.sh admin stop`); it only ever listens on localhost / `BIND_IP`
- [ ] `POSTGRES_PASSWORD` is a randomly generated secret (not `CHANGE_THIS_*`)
- [ ] `JWT_ACCESS_SECRET` and `JWT_REFRESH_SECRET` are separate 32+ character random secrets
- [ ] Env files are mode 600 and not committed (`.env*` except `.env.example` is git-ignored)
- [ ] `REDIS_PASSWORD` is set; `CORS_ORIGIN` lists exact origins
- [ ] `ALLOW_REGISTRATION=false` once all intended accounts exist
- [ ] `bash bedroc.sh check` passes with no warnings
- [ ] `docker/ssl/key.pem` is not committed to git
- [ ] Backups are running and tested
- [ ] The host OS is kept up to date (`apt upgrade` / `yum update`)
- [ ] Docker daemon is not exposed on a TCP socket (use Unix socket only)
