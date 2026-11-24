# Upgrading a running Bedroc server

This guide covers updating an existing deployment to a new version. Day-to-day it is two commands:

```bash
cd /opt/Bedroc          # wherever your checkout lives
git pull
bash bedroc.sh update
```

`bash bedroc.sh update` does this, in order, and stops at the first problem:

1. **Checks.** It verifies Docker access, your env file (required values, no placeholders, no `*` in `CORS_ORIGIN`, file permissions), free ports, disk space, and that the database volume it is about to use really is your existing one.
2. **Verified backup.** It runs `pg_dump` into `./backups/`, then reads the dump back to make sure it is usable. If that fails, the update stops and nothing else happens.
3. **Build.** It builds the new images while your current containers keep serving. If the build fails, the old version keeps running.
4. **Restart.** It recreates only what changed. Database migrations run in a one-off container first, then the API starts.
5. **Health check.** It waits until every service reports healthy. If one doesn't, it prints that service's logs and tells you how to roll back.

It never deletes Docker volumes and never edits anything outside the Bedroc directory. When it wants to change something, for example adding a missing setting to your env file, it says exactly what it will do and waits for your "y". Use `--yes` to answer routine questions automatically. A restore always needs you to type the project name, even with `--yes`.

> **Why `bash bedroc.sh` and not `./bedroc.sh`?** It works even if the executable bit was lost (e.g. the repo was committed from Windows) or the filesystem is mounted `noexec`.

---

## First upgrade from a pre-November-2026 version (one-time steps)

Versions before the November 2026 security release differ in a few ways that `bedroc.sh` handles for you. Here is what will happen, so nothing surprises you.

| Change | What you need to do |
| --- | --- |
| **Redis now requires a password** (`REDIS_PASSWORD`) | `bedroc.sh` offers to generate one and append a single line to your env file. It saves a backup copy of the env file first (`.env.public.bak-<timestamp>`, mode 600). |
| **`CORS_ORIGIN` must list exact origins**; `*` is rejected | If yours contains `*`, `bedroc.sh` offers to remove just the `*`. If you use the desktop app, add `http://localhost:*`. |
| `REDIS_URL` is no longer read | Optional: delete that line from your env file. |
| **Access log is off unless enabled** | If your env file says `ENABLE_ACCESS_LOG=true`, nothing changes for you. |
| Login protocol changed | Update the web frontend (Vercel) and desktop app **together with** the server; old clients can't log in to the new server. Existing passwords keep working, and accounts are upgraded to the stronger password hash on their next login. |
| Containers run hardened (read-only, no capabilities), Postgres/Redis lose internet access, migrations run in a separate `migrate` container | Nothing. Your data volume, service names and port 3000 are unchanged. |
| An old Docker network `<project>_internal` and volume `<project>_redis_data` are no longer used | Nothing. They're harmless and left in place. Once you're happy with the update you can remove them with `docker network rm bedroc-public_internal` and `docker volume rm bedroc-public_redis_data`. Redis now keeps nothing on disk. |

The database schema changes are **additive** (new columns with defaults), so the previous server version still works with the upgraded database if you ever need to roll back.

---

## Example: moving `~/opt/Bedroc` → `/opt/Bedroc` while upgrading

This is the exact procedure for a VPS where Bedroc runs as compose project `bedroc-public` from `~/opt/Bedroc`, Docker needs `sudo`, and there's a helper at `/usr/local/bin/bedroc-public`.

The data lives in the Docker volume `bedroc-public_postgres_data`. The volume is selected by the **project name**, not by the directory, so moving the folder is safe as long as the project name stays `bedroc-public` (which `bedroc.sh` uses for `.env.public` automatically).

```bash
# 0. Optional extra safety net: a backup with the OLD version, before touching anything
cd ~/opt/Bedroc
mkdir -p backups && chmod 700 backups
sudo docker exec bedroc-public-postgres-1 pg_dump -U postgres -d bedroc --format=custom > backups/pre-upgrade.dump
ls -l backups/pre-upgrade.dump          # should be a few KB or more, not 0

# 1. Get the new code (still in the old place)
git pull

# 2. Move the whole checkout, keeping owner and permissions.
#    The running containers keep working during the move.
sudo mv ~/opt/Bedroc /opt/Bedroc
cd /opt/Bedroc
ls -la .env.public logs                 # env file and logs came along

# 3. Upgrade. Asks for your sudo password once, then shows each step.
bash bedroc.sh update
```

During step 3, expect these prompts:

- *"Generate a random REDIS_PASSWORD and append it to .env.public?"*: answer **y**.
- *".env.public is readable by other users … chmod 600?"*: appears only if the file is group/world readable. **y** is recommended.
- *"Give ./logs to uid 1001?"*: appears only if `ENABLE_ACCESS_LOG=true` and the folder lost that ownership. **y**, or turn the access log off.

When it finishes you'll see `✓ server is healthy` and the API address. Check from the outside:

```bash
curl -s http://127.0.0.1:3000/health                 # {"ok":true}
curl -s https://<your-api-domain>/health             # {"ok":true} through Caddy/Cloudflare
```

Then log in from the (updated) web app.

**Your `/usr/local/bin/bedroc-public` helper** still points at the old path. `bedroc.sh` doesn't edit files outside the repo, so if you want to keep the helper, change its `cd` line yourself:

```bash
sudo sed -i 's#cd "${HOME}/opt/Bedroc"#cd /opt/Bedroc#' /usr/local/bin/bedroc-public
```

Alternatively, `bash bedroc.sh compose <anything>` does the same job (it runs `docker compose -p bedroc-public -f docker-compose.public.yml --env-file .env.public <anything>`).

**Cron jobs** that run `docker exec bedroc-public-postgres-1 pg_dump …` keep working unchanged: container and service names did not change. Cron jobs with a hard-coded `cd ~/opt/Bedroc` need the new path.

---

## If something goes wrong

The update stops at the first problem and prints why. Your data volume is never removed. Typical cases:

- **A check fails** (red `✗`). Nothing has been changed yet; fix what it says and re-run.
- **The build fails.** The old containers are still running and serving. Usually this is a network or disk problem; see [TROUBLESHOOTING.md](TROUBLESHOOTING.md).
- **A service is unhealthy after the restart.** The script prints the last log lines of each service. To go back to the previous version:

  ```bash
  git log --oneline -5             # find the commit you were on before
  git checkout <that-commit>
  bash bedroc.sh up                # rebuilds and starts the old version against the same data
  ```

  The schema changes are additive, so the old version runs on the upgraded database. If you ever need the data exactly as it was before the update:

  ```bash
  bash bedroc.sh restore backups/<the pre-update file>.dump
  ```

  Restore takes a fresh backup of the current state first, then asks you to type the project name.

Come back to the newest version later with `git checkout main && git pull && bash bedroc.sh update`.

---

## Backups

```bash
bash bedroc.sh backup                         # verified dump → ./backups/<project>-<UTC time>.dump (mode 600)
bash bedroc.sh restore backups/<file>.dump    # also accepts .sql and .sql.gz from older pg_dump cron jobs
```

- Backups contain usernames, SRP verifiers, wrapped keys, plaintext topic/folder names and encrypted notes. Treat them as sensitive. The `backups/` folder is mode 700 and git-ignored.
- **Keep a copy of your env file somewhere safe, separate from the backups.** Without its secrets, a restored database can't be used (sessions and the app database user depend on them).
- Old backups are never deleted automatically. Remove the ones you no longer need.

A nightly backup via cron (as root, because Docker needs root on most servers):

```cron
# /etc/cron.d/bedroc-backup
15 3 * * * root cd /opt/Bedroc && bash bedroc.sh backup >> /var/log/bedroc-backup.log 2>&1
```
