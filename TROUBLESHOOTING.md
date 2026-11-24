# Troubleshooting a Bedroc server

Start with:

```bash
bash bedroc.sh check      # all pre-flight checks; changes nothing without asking
bash bedroc.sh status     # containers, health, data volume, latest backup
bash bedroc.sh logs server        # or: postgres, redis, migrate, nginx, bedroc   (add -f to follow)
```

None of the fixes below needs `docker compose down -v`. That command **deletes your database**, and `bedroc.sh` never runs it.

---

## Docker access

### `permission denied while trying to connect to the Docker daemon socket`

Your user isn't in the `docker` group. That's fine and the safer setup: membership in `docker` is equivalent to root. `bedroc.sh` detects this and re-runs itself with `sudo` (one password prompt). Files it creates are handed back to your user.

If `sudo` is not available either, run the script as a user who may use Docker. Adding yourself to the `docker` group (`sudo usermod -aG docker $USER`) also works, but it gives that account root-equivalent power. Don't do it on a hardened server just for convenience.

### `Cannot connect to the Docker daemon … Is the docker daemon running?`

```bash
sudo systemctl start docker
sudo systemctl enable docker      # start on boot (optional)
```

### `Docker Compose v2 is missing` / `docker: 'compose' is not a docker command`

Install the compose plugin: `sudo apt-get install docker-compose-plugin` (Debian/Ubuntu, Docker's apt repo) or `sudo dnf install docker-compose-plugin` (Fedora/RHEL). The old standalone `docker-compose` (v1) is not supported.

### Rootless Docker

This works for the public stack, which only publishes `127.0.0.1:3000`. The WireGuard stack publishes ports 80/443, which rootless Docker can't bind. Set `HTTP_PORT=8080` and `HTTPS_PORT=8443` in `.env` and open `https://<BIND_IP>:8443` (also add that origin to `CORS_ORIGIN`).

### "Compose can now delegate builds to bake…"

This is an informational message from newer Docker Compose versions and can be ignored. `bedroc.sh` builds without Bake on purpose, because Bake can ask for extra filesystem entitlements (`--allow=fs.read=…`) on some systems.

---

## Ports and addresses

### `Port 127.0.0.1:3000 is already used by …` (public stack)

Another service owns that port. Pick a free one in `.env.public`, then point your reverse proxy at it:

```env
BEDROC_PORT=3005
```

```caddy
reverse_proxy 127.0.0.1:3005
```

`bedroc.sh check` names the container or process holding the port. Bedroc's own containers are ignored by the check, so an `update` never flags the port it already uses.

### `Port <BIND_IP>:443 is already used` (WireGuard stack)

Set `HTTP_PORT` / `HTTPS_PORT` in `.env` (e.g. `8080` / `8443`), add `https://<BIND_IP>:8443` to `CORS_ORIGIN`, and open that URL.

### `BIND_IP 10.66.66.1 is not assigned to any interface here`

Docker can only bind to an address the machine actually has. Bring the VPN up (`sudo wg-quick up wg0`, `tailscale up`) or set `BIND_IP` to the right address (`ip -brief addr` lists them).

### Adminer port conflict

`bash bedroc.sh admin start` uses 127.0.0.1:8081 (public) or `<BIND_IP>`:8080 (WireGuard). Change it with `ADMINER_PORT=<port>` in the env file.

---

## Files, permissions, umask

### Restrictive umask (e.g. `umask 077`) or files owned by another user

The images set explicit file modes, `init.sh` and `nginx.conf` are baked into images rather than bind-mounted, and the containers that must read host files (the nginx TLS key) start with the capability to do so. A checkout with mode 600/700 files works; this is tested.

The env file should be mode 600. `bedroc.sh check` offers `chmod 600` when it isn't.

### Access log never appears (`ENABLE_ACCESS_LOG=true`)

The server writes as uid 1001. `./logs` must belong to that uid:

```bash
sudo chown 1001:1001 /opt/Bedroc/logs && sudo chmod 700 /opt/Bedroc/logs
bash bedroc.sh restart server
```

`bedroc.sh check` detects this and offers to do it, touching only that one directory. Read the log with `bash bedroc.sh access-log`. Privacy: the log stores the username and IP of every login. Keep it off unless you need it.

### SELinux (Fedora/RHEL/CentOS): `permission denied` inside containers on mounted files

Label only Bedroc's two mounted directories (nothing else on the system):

```bash
chcon -Rt container_file_t /opt/Bedroc/logs /opt/Bedroc/docker/ssl
```

### `/bin/bash^M: bad interpreter` (Postgres, first start)

That's a Windows line-ending problem from older checkouts. Current versions strip CR characters while building the database image and pin LF endings in `.gitattributes`. Pull the latest version and run `bash bedroc.sh up` again.

---

## Database

### `No database volume named <project>_postgres_data, but other Bedroc-looking data volumes exist`

`bedroc.sh` refuses to start, because doing so would create a **new empty database** next to your real one. Typical causes:

- You started Compose by hand without `-p bedroc-public` at some point, or under a different directory name (WireGuard mode derives the project name from the directory).
- The env file's `BEDROC_PROJECT` / `COMPOSE_PROJECT_NAME` is wrong.

`docker volume ls | grep postgres_data` shows what exists. If your data is in, e.g., `bedroc_postgres_data`, add `BEDROC_PROJECT=bedroc` to the env file. Only if you really want a second, empty database, re-run with `--new-database`.

### `migrate` failed: `password authentication failed` (28P01)

The passwords in `DATABASE_URL` / `POSTGRES_PASSWORD` must match the ones the database was **first created** with. Changing them in the env file later doesn't change them inside an existing database. Put the original values back, or change the password inside Postgres first (see MANAGEMENT-GUIDE.md, "Rotating the database password").

### `migrate` failed: `must be owner of …` (42501)

Migrations first run as the app user and fall back to the superuser if the app user lacks rights. If both fail, `POSTGRES_PASSWORD` doesn't match the database's superuser password (see above).

### Database container restarts / `could not create shared memory segment`

Usually the machine is out of disk or memory. Check `df -h` and `free -m`. `bash bedroc.sh check` warns below 2 GB free.

---

## The app can't connect

### "This server does not accept requests from https://…"

The frontend's origin isn't in `CORS_ORIGIN`. Add it (exact scheme + host + port, comma-separated), then `bash bedroc.sh up`. For the desktop app, add `http://localhost:*`.

### "Cannot reach server"

1. `curl -s http://127.0.0.1:3000/health` on the server (public stack) → `{"ok":true}`?
2. Through the reverse proxy: `curl -s https://<api-domain>/health`.
3. WireGuard stack: is the device connected to the VPN? Open `https://<BIND_IP>` once and accept the self-signed certificate.
4. `bash bedroc.sh logs server`.

### Logins fail for everyone right after an update

The web frontend or desktop app is older than the server (new login protocol). Redeploy the frontend and update the desktop app.

### Everyone shares one rate limit / 429 errors behind Cloudflare

With Cloudflare in front of Caddy, every request reaches Bedroc from a Cloudflare IP unless Caddy is told to trust Cloudflare. See VPS-DEPLOY.md ("Real client IPs behind Cloudflare"), then set `TRUST_PROXY=2`.

---

## Rolling back

See [UPGRADING.md](UPGRADING.md#if-something-goes-wrong). Short version: `git checkout <previous commit>` and `bash bedroc.sh up`; restore a backup only if you need the exact old data.
