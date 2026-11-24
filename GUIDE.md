# Bedroc — Self-Hosting Guide

This guide walks you through running your own Bedroc server so only you (and people you invite via VPN) can access your notes. No programming experience required.

> **What you get:** Your notes are encrypted on your device before they leave it. Even the server cannot read them. This guide sets up the server component — a place to store and sync those encrypted blobs.

---

## How Bedroc works

Bedroc has two parts:

- **Frontend** — the app itself. Available publicly at `https://bedroc.cagancalidag.com`. You don't need to host this — it works from any browser or as a PWA (add to home screen).
- **Backend** — the server that stores your encrypted notes. This is what you self-host.

When you log in or register, there is a **Server** field that lets you point the app at your own backend. The default is the public hosted server. Change it to your own URL to use your self-hosted instance.

This means you can use the public frontend URL and just change the server — no need to host the frontend at all.

---

## What you need

- A machine to run the server on:
  - A Linux VPS from DigitalOcean, Hetzner, Linode, Vultr, etc. (~$5/month, cheapest tier is plenty)
  - A home server, Raspberry Pi, or spare computer
  - A Windows or macOS machine (for testing; a VPS is better for 24/7 availability)
- **Docker** and **Docker Compose** installed on that machine
- Basic comfort opening a terminal

Pick your platform below:

---

## Part 1 — Install Docker

### Windows

1. Go to [docker.com/products/docker-desktop](https://www.docker.com/products/docker-desktop) and download **Docker Desktop for Windows**
2. Run the installer. When prompted, keep "Use WSL 2 instead of Hyper-V" checked
3. After installation, open Docker Desktop and wait for it to say "Engine running" in the bottom-left corner
4. Open **PowerShell** or **Windows Terminal** and run:
   ```
   docker --version
   docker compose version
   ```
   Both should print version numbers. If they do, Docker is ready.

> **Note:** Docker Desktop is fine for testing on your own Windows PC. For a proper server, use a Linux VPS — it's cheaper, always on, and more reliable.

### macOS

1. Go to [docker.com/products/docker-desktop](https://www.docker.com/products/docker-desktop) and download **Docker Desktop for Mac**
   - Choose "Apple Chip" if you have an M1/M2/M3/M4 Mac, or "Intel Chip" otherwise
2. Open the downloaded `.dmg`, drag Docker to Applications, then launch it
3. Wait for the whale icon in the menu bar to stop animating
4. Open **Terminal** and run:
   ```
   docker --version
   docker compose version
   ```
   Both should print version numbers.

### Linux (Ubuntu / Debian — recommended for servers)

Run these commands one at a time in your terminal:

```bash
# Remove old Docker versions if any
sudo apt-get remove -y docker docker-engine docker.io containerd runc 2>/dev/null || true

# Install prerequisites
sudo apt-get update
sudo apt-get install -y ca-certificates curl

# Add Docker's official GPG key and repository
sudo install -m 0755 -d /etc/apt/keyrings
sudo curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
sudo chmod a+r /etc/apt/keyrings/docker.asc

echo \
  "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] \
  https://download.docker.com/linux/ubuntu \
  $(. /etc/os-release && echo "$VERSION_CODENAME") stable" | \
  sudo tee /etc/apt/sources.list.d/docker.list > /dev/null

sudo apt-get update
sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin

```

Verify:
```bash
sudo docker --version
sudo docker compose version
```

> **You don't need to join the `docker` group.** `bash bedroc.sh` detects when Docker needs root and re-runs itself with `sudo` (one password prompt). Membership in the `docker` group is equivalent to root access, so on a server it's safer to leave it out.

### Linux (Fedora / RHEL / CentOS)

```bash
sudo dnf -y install dnf-plugins-core
sudo dnf config-manager --add-repo https://download.docker.com/linux/fedora/docker-ce.repo
sudo dnf install docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
sudo systemctl enable --now docker
```

Verify with `sudo docker compose version`. As on Debian/Ubuntu, you don't need to join the `docker` group.

---

## Part 2 — Set up WireGuard (recommended for private access)

Bedroc's default setup uses [WireGuard](https://www.wireguard.com/) — a modern VPN. This means your notes server is **invisible to the public internet** and only reachable from devices you've personally authorised.

If you just want to test locally or on a LAN, you can skip this and come back to it later. Jump to Part 3 — but note that without WireGuard or a domain with HTTPS, the setup will use plain HTTP.

### Option A — Use the wg-easy web UI (easiest)

[wg-easy](https://github.com/wg-easy/wg-easy) is a Docker container that gives you a web dashboard for managing WireGuard peers. It's the easiest way to get WireGuard running.

```bash
docker run -d \
  --name=wg-easy \
  -e LANG=en \
  -e WG_HOST=YOUR_VPS_PUBLIC_IP \
  -e PASSWORD_HASH='YOUR_BCRYPT_HASH' \
  -v ~/.wg-easy:/etc/wireguard \
  -p 51820:51820/udp \
  -p 51821:51821/tcp \
  --cap-add=NET_ADMIN \
  --cap-add=SYS_MODULE \
  --sysctl="net.ipv4.conf.all.src_valid_mark=1" \
  --sysctl="net.ipv6.conf.all.disable_ipv6=1" \
  --restart unless-stopped \
  ghcr.io/wg-easy/wg-easy
```

Open `http://YOUR_VPS_IP:51821` to manage clients. Download the config file for each device and import it into the WireGuard app.

Make sure UDP port 51820 is open in your firewall.

### Option B — Use Tailscale (easiest, no VPS required)

[Tailscale](https://tailscale.com/) is the simplest option if you:

- Want to run the server on a **home computer, NAS, or Raspberry Pi** instead of a VPS
- Are behind CGNAT (most mobile plans and many ISPs) — you cannot get a public IP, so regular WireGuard won't work
- Want to be up and running in 5 minutes without any networking knowledge

Tailscale creates a private mesh VPN automatically. Your server gets a stable private IP (like `100.x.x.x`) that only your devices can reach. No public IP, no port forwarding, no certificate management.

#### 1. Install Tailscale on your server machine

**Ubuntu / Debian:**
```bash
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up
```

Follow the link it prints and log in with your Tailscale account (free for personal use).

**Other Linux / Windows / macOS / Raspberry Pi:** See [tailscale.com/download](https://tailscale.com/download)

#### 2. Get your server's Tailscale IP

```bash
tailscale ip -4
```

This will be something like `100.64.x.x` or `100.96.x.x`. Write it down.

#### 3. Install Tailscale on each device that needs access

Download the Tailscale app on your phone, laptop, etc., and log in with the same Tailscale account. Your devices will automatically find each other.

#### 4. Generate an SSL certificate for the Tailscale IP

When using Tailscale with a plain IP (not a Tailscale domain), you'll need a self-signed cert. Run this on the server machine, substituting your actual Tailscale IP:

```bash
mkdir -p docker/ssl
openssl req -x509 -newkey rsa:4096 -sha256 -days 3650 -nodes \
  -keyout docker/ssl/key.pem \
  -out docker/ssl/cert.pem \
  -subj "/CN=bedroc" \
  -addext "subjectAltName=IP:100.64.X.X"
```

> **Tailscale HTTPS (optional):** If you enable [Tailscale HTTPS](https://tailscale.com/kb/1153/enabling-https/) (`tailscale serve`), you get a real Let's Encrypt certificate for a `*.ts.net` domain. You can then use that domain instead of the raw IP — browsers will trust it without a warning. This is the cleanest option if you want it. See the Tailscale docs for setup.

#### 5. Set up Bedroc on the Tailscale IP

Run `bash bedroc.sh setup` (see Part 3), choose **wireguard**, and enter your Tailscale IP (`100.x.y.z`) as the address to listen on. No compose file edits are needed: the address lives in `.env` as `BIND_IP`.

#### 6. Start the server

```bash
bash bedroc.sh up
```

#### 7. Connect from your devices

Make sure Tailscale is active on the device, then:

- Open `https://100.64.X.X` in a browser (accept the certificate warning)
- Or, if using Tailscale HTTPS, open `https://your-machine-name.tail-xxxx.ts.net`

On the Bedroc login page, set the Server URL to your Tailscale IP or domain.

> **Important:** Tailscale must be running on both the server machine and your device for them to connect. If you turn off Tailscale on either end, the connection breaks. For 24/7 access, the server machine must be always on (or at least running Tailscale when you need it).

---

### Option C — Manual WireGuard (more control)

#### Install WireGuard on your server (Linux)

```bash
sudo apt-get install -y wireguard
```

#### Generate server keys

```bash
wg genkey | sudo tee /etc/wireguard/server_private.key | wg pubkey | sudo tee /etc/wireguard/server_public.key
sudo chmod 600 /etc/wireguard/server_private.key
```

#### Create `/etc/wireguard/wg0.conf`

Replace `YOUR_SERVER_PRIVATE_KEY` with the contents of `/etc/wireguard/server_private.key`:

```ini
[Interface]
Address = 10.66.66.1/24
ListenPort = 51820
PrivateKey = YOUR_SERVER_PRIVATE_KEY
PostUp = iptables -A FORWARD -i wg0 -j ACCEPT; iptables -t nat -A POSTROUTING -o eth0 -j MASQUERADE
PostDown = iptables -D FORWARD -i wg0 -j ACCEPT; iptables -t nat -D POSTROUTING -o eth0 -j MASQUERADE

# Add a [Peer] block for each device you want to grant access
# (See "Adding devices" below)
```

> If your network interface is not `eth0`, replace it with the correct name (`ip link` to check).

#### Start WireGuard

```bash
sudo systemctl enable wg-quick@wg0
sudo systemctl start wg-quick@wg0
```

Verify it's running:
```bash
sudo wg show
```

#### Open the WireGuard port in your firewall

If using `ufw`:
```bash
sudo ufw allow 51820/udp
```

If your VPS has a cloud firewall (DigitalOcean, Hetzner, etc.), also open UDP port 51820 in the control panel.

#### Adding a device (phone, laptop, etc.)

On the **server**, generate a key pair for the new device:

```bash
wg genkey | tee /tmp/peer_private.key | wg pubkey | tee /tmp/peer_public.key
```

Add a `[Peer]` block to `/etc/wireguard/wg0.conf`:

```ini
[Peer]
# Label (just for your reference — put the device name here)
# Phone
PublicKey = PEER_PUBLIC_KEY_HERE
AllowedIPs = 10.66.66.2/32
```

Each device needs a unique IP — use `10.66.66.2`, `10.66.66.3`, etc.

Reload WireGuard:
```bash
sudo wg syncconf wg0 <(sudo wg-quick strip wg0)
```

On the **device**, install the WireGuard app:

- iPhone/iPad: App Store → "WireGuard"
- Android: Play Store → "WireGuard"
- Windows/Mac: [wireguard.com/install](https://www.wireguard.com/install/)
- Linux: `sudo apt install wireguard` or equivalent

Create a tunnel with this config (replace the placeholders):

```ini
[Interface]
PrivateKey = PEER_PRIVATE_KEY_FROM_ABOVE
Address = 10.66.66.2/32
DNS = 1.1.1.1

[Peer]
PublicKey = YOUR_SERVER_PUBLIC_KEY
Endpoint = YOUR_VPS_PUBLIC_IP:51820
AllowedIPs = 10.66.66.1/32
PersistentKeepalive = 25
```

Once connected to the VPN, your device can reach the server at `10.66.66.1`.

---

## Part 3 — Configure Bedroc

### Get the code

```bash
git clone https://github.com/MrBiscuitTR/Bedroc.git
cd Bedroc
```

Or download and extract the ZIP from GitHub.

### Run the setup

```bash
bash bedroc.sh setup
```

Choose **2) wireguard**, enter your WireGuard/Tailscale/LAN IP (default `10.66.66.1`), and accept the suggested origins. The script:

- creates `.env` (mode 600) with **freshly generated secrets**. Nothing needs to be copied or pasted, and every secret is unique.
- offers to create a self-signed TLS certificate for that IP in `docker/ssl/`. Even inside a VPN the browser needs HTTPS for encrypted storage, service workers and installing as an app; a self-signed certificate is fine over an already-encrypted tunnel.
- never overwrites an existing env file.

> Prefer to do it by hand? Copy `.env.example` to `.env`, fill in every `CHANGE_THIS` value (`openssl rand -hex 32`), set `BIND_IP`, run `chmod 600 .env`, and put `cert.pem` + `key.pem` into `docker/ssl/`.

**About `CORS_ORIGIN`:** it is required and must not be `*`. The login cookie is sent cross-site, so allowing every origin would let any website you visit take over your session. It must list every place you open Bedroc from: this server's own address (`https://10.66.66.1`, plus `:port` if not 443), the public frontend (`https://bedroc.cagancalidag.com`) if you use it, and `http://localhost:*` for the desktop app. If an origin is missing, the app shows *"This server does not accept requests from …"*. Add it and run `bash bedroc.sh up`.

### Start the server

```bash
bash bedroc.sh up
```

The script first checks everything: Docker access, env file, that `BIND_IP` exists on this machine, free ports, certificate, disk space. Then it builds the images (a few minutes the first time), starts the stack and waits until every service is healthy. If something is wrong it says what and how to fix it. See [TROUBLESHOOTING.md](TROUBLESHOOTING.md) for details.

What runs, and how it's locked down:

| Container | Role | Reachable from |
| --- | --- | --- |
| `nginx` | TLS, serves the app, proxies `/api` | **only** `BIND_IP:80/443` |
| `bedroc` | static frontend (unprivileged nginx) | nginx only |
| `server` | API | nginx only |
| `postgres`, `redis` | database, login challenges | the API only, no internet access |
| `migrate` | runs database migrations, then exits | — |

Every container runs with a read-only filesystem, no Linux capabilities (except the few nginx/Postgres need to drop to their own users), `no-new-privileges`, process limits and size-capped logs. The API server never receives the database superuser password, and Redis is password-protected.

---

## Part 4 — Connect from the app

### If using WireGuard

> **Important:** `10.66.66.1` is your WireGuard VPN IP — it is only reachable from devices connected to WireGuard. You **must** connect to WireGuard first on every device before the app can reach your server.

1. Connect your device to the WireGuard VPN
2. Navigate directly to `https://10.66.66.1` in your browser. Accept the certificate warning ("Advanced → Proceed", "Accept the Risk and Continue", or "Visit Website" depending on browser). This takes you to the Bedroc login page served by your own server.
3. Register an account and start using Bedroc.

> **Why use `https://10.66.66.1` directly?** When your backend has a self-signed certificate, browsers block `fetch()` requests to it from any other origin (including `bedroc.cagancalidag.com`) — this is a hard browser security rule with no workaround. Using the app from `https://10.66.66.1` means all requests are same-origin, so there are no cross-origin restrictions. Once the cert is accepted, bookmark it and install as a PWA from that URL for the best experience.

### If using a public domain

Use the **public** stack instead: it runs only the API on `127.0.0.1` behind a reverse proxy such as Caddy, which handles certificates automatically. Follow [VPS-DEPLOY.md](VPS-DEPLOY.md). Don't bind the WireGuard stack to `0.0.0.0`.

### Entering your server URL

On the login/register page, tap the **"Server: ..."** line to expand it. Type your server address in any format:

| What you type | What Bedroc uses |
|---|---|
| `10.66.66.1` | `https://10.66.66.1` |
| `10.66.66.1:3000` | `https://10.66.66.1:3000` |
| `api.yourdomain.com` | `https://api.yourdomain.com` |
| `https://api.yourdomain.com` | `https://api.yourdomain.com` |
| `http://10.66.66.1` | `http://10.66.66.1` (kept as-is) |
| `100.64.1.5` (Tailscale IP) | `https://100.64.1.5` |

The app saves your server URL so you only need to enter it once. Multiple saved servers are remembered.

### Using Bedroc as a PWA (add to home screen)

Bedroc works as an installable app on any device:

- **iOS (Safari):** Open `https://bedroc.cagancalidag.com` → tap the Share button → "Add to Home Screen"
- **Android (Chrome):** Open the site → tap the three-dot menu → "Add to Home Screen" or "Install App"
- **Desktop (Chrome/Edge):** Click the install icon in the address bar, or menu → "Install Bedroc"

Once installed, the app works offline and loads instantly from cache. Notes you've already opened are available without a network connection. New notes written offline are queued and synced automatically when you reconnect.

---

## Managing the server

Everything goes through `bash bedroc.sh` (run `bash bedroc.sh help` for the full list):

```bash
bash bedroc.sh status            # containers, health, data volume, latest backup
bash bedroc.sh logs server -f    # follow the API log (also: nginx, postgres, redis, migrate, bedroc)
bash bedroc.sh restart server    # restart one service
bash bedroc.sh down              # stop everything (data is kept)
bash bedroc.sh up                # start again / apply env changes
bash bedroc.sh admin start       # Adminer DB GUI on BIND_IP:8080 (stop with: admin stop)
bash bedroc.sh compose <args>    # any docker compose command with the right project + env file
```

### Updating to a new version

```bash
git pull
bash bedroc.sh update
```

It takes a verified backup, rebuilds, restarts and health-checks; if anything fails, it stops and tells you how to roll back. Details and the one-time notes for older installs are in [UPGRADING.md](UPGRADING.md).

### Changing the maximum attachment size

The default maximum file size for uploaded attachments (images, PDFs, etc.) is **15 MB per file**. To change it, edit two places:

**1. Server route body limit** — `server/src/routes/attachments.ts`:

```typescript
// Find this line and change the multiplier:
bodyLimit: 20 * 1024 * 1024,   // 20 MB HTTP body limit
```

**2. Zod validation schema** — same file, a few lines above:

```typescript
const MAX_ENCRYPTED_DATA_LENGTH = 19_000_000;  // ~19 MB for base64-encoded 14 MB file

const UploadSchema = z.object({
  encryptedData: z.string().min(10).max(MAX_ENCRYPTED_DATA_LENGTH),
  ...
  sizeBytes: z.number().int().min(0).max(15_000_000),  // 15 MB plaintext
});
```

The relationship between these numbers:
- `sizeBytes` max = the max **plaintext** file size you want to allow.
- `MAX_ENCRYPTED_DATA_LENGTH` ≈ `sizeBytes * 1.37` (base64 overhead) + a few hundred bytes for the JSON envelope.
- `bodyLimit` = `MAX_ENCRYPTED_DATA_LENGTH` + ~1 MB safety margin.

After changing, rebuild and restart: `bash bedroc.sh up`.

---

## Backing up your data

All data lives in the Docker volume `<project>_postgres_data` (`bash bedroc.sh status` shows the name).

```bash
bash bedroc.sh backup                        # verified dump into ./backups/ (mode 600)
bash bedroc.sh restore backups/<file>.dump   # replaces the database; asks you to type the project name
```

Restore first takes a backup of the current state, so it can be undone. It also accepts `.sql` / `.sql.gz` files from older `pg_dump` cron jobs.

The dump contains encrypted notes, but also usernames, password verifiers and plaintext topic/folder names. Keep backups private, and **keep a copy of your `.env` separately**: a restored database is useless without its secrets.

Nightly backups (cron, as root):

```cron
# /etc/cron.d/bedroc-backup
15 3 * * * root cd /path/to/Bedroc && bash bedroc.sh backup >> /var/log/bedroc-backup.log 2>&1
```

### Adjusting rate limits

Rate limits protect the server from abuse and brute-force attacks. The defaults are generous for normal use. If you are hitting limits (e.g. getting 429 errors), you can increase them.

**Global fallback** — covers all authenticated routes not listed below. Edit `server/src/index.ts`:

```ts
await app.register(fastifyRateLimit, {
  max: 500,          // ← change this number
  timeWindow: '1 minute',
```

**Per-route limits** — defined on individual route handlers in `server/src/routes/notes.ts` and `server/src/routes/auth.ts`. Look for `config: { rateLimit: { max: N } }` on the route you want to change:

```ts
// Example: increase note sync limit
{
  method: 'GET',
  url: '/api/notes/sync',
  config: { rateLimit: { max: 200, timeWindow: '1 minute' } },  // ← change max here
  ...
}
```

Current defaults:

| Route | Default limit |
| --- | --- |
| Global fallback (all auth routes) | 500 req/min |
| `GET /api/notes/sync` | 200 req/min |
| `PUT /api/notes/:id` | 200 req/min |
| `GET /api/notes` | 120 req/min |
| `PUT /api/topics/:id`, `PUT /api/folders/:id` | 120 req/min |
| `GET /api/topics`, `GET /api/folders` | 120 req/min |
| `DELETE /api/notes/:id` | 60 req/min |
| `POST /api/auth/register` | 5 req/min |
| `POST /api/auth/login/init` and `/verify` | 10 req/min per IP, plus a per-account lock after 10 failed passwords in 15 min |

After changing limits, rebuild: `bash bedroc.sh up`.

---

## Troubleshooting

### "Cannot reach server" / "Unreachable" in the app

**If you're using a WireGuard backend (10.66.66.1):**

- `10.66.66.1` is a VPN-private IP. It is **only reachable from devices connected to WireGuard**. If you open the public Bedroc frontend (`https://bedroc.cagancalidag.com`) on a device that is NOT connected to WireGuard, the app correctly reports "Unreachable" — the browser cannot route to that IP. Connect to WireGuard first.
- If you ARE connected to WireGuard and still see "Unreachable": you may need to accept the self-signed certificate first. Open `https://10.66.66.1` directly in a new tab, click through the certificate warning, then retry.

**General checklist:**

1. Check that the server field shows the correct URL (tap it on the login page)
2. Make sure you're connected to WireGuard (if using VPN setup)
3. Check the stack: `bash bedroc.sh status` (all should show `healthy`)
4. Test the health endpoint from the server itself: `curl -k https://10.66.66.1/health`
5. Check the server logs: `bash bedroc.sh logs server`

### "Certificate error" / browser warning

Expected with a self-signed certificate. Click through the warning once. The connection is still encrypted — the warning just means the certificate wasn't issued by a public certificate authority.

On iOS/Safari, you may need to go to Settings → General → VPN & Device Management → trust the certificate.

### App won't install as PWA on iOS

The app must be served over HTTPS for PWA installation to work. If you're using a self-signed cert on WireGuard, you need to trust the certificate first (see above). Once trusted, the "Add to Home Screen" option will work.

### Offline notes not syncing when back online

The app syncs automatically when it detects a network connection. If sync is stuck:

1. Open the app and wait a moment — sync runs on page load and when reconnecting
2. Check Settings → the server status indicator should turn green when online
3. If the server is unreachable, check your WireGuard connection or VPS status

### Conflict resolution

If you edited the same note on two devices while offline, the app will detect the conflict when syncing. A conflict notice will appear on the note, letting you choose which version to keep (or manually merge changes). Conflicts are never silently discarded.

### Forgot to save my server address

The server field is on the login page. Tap the "Server: ..." line to see or change it.

### Database won't start, ports in use, permission errors, …

See [TROUBLESHOOTING.md](TROUBLESHOOTING.md). It covers Docker permissions, port conflicts, missing `BIND_IP`, umask and SELinux, and database password mismatches. Don't use `docker compose down -v` to "fix" a database problem: it deletes all data.

---

## Images and file attachments

Bedroc supports embedding images and file attachments (PDF, code files, zip, etc.) directly in notes.

- **How it works:** When you upload an image or attach a file, it is encrypted on your device with your DEK (the same key that encrypts your notes) before being stored anywhere. The server receives and stores only AES-256-GCM ciphertext — never plaintext.
- **Cross-device sync:** Attachments are uploaded to the server once (identified by content hash). When you open the same note on another device, the attachment is fetched from the server, cached locally, and decrypted — so every device can view it.
- **Bandwidth-efficient:** Regular autosaves only transmit a tiny `attachment:<hash>` placeholder in the note body. The actual binary blob is only uploaded once, and only downloaded once per new device.
- **File previews:** Click the file icon or name on an attached file card to preview it directly in the app — no download required. PDFs open in an inline viewer. Text, code, CSV, and JSON files show in a scrollable preview pane with selectable text.
- **Storage:** Attachment data is stored in the `attachments` table in the same PostgreSQL database as your notes. There is no separate object storage required.
- **Deletion:** Removing a file card from a note removes it from the editor, but the encrypted blob persists on the server until you delete your account (which cascades all data). A future release will support explicit attachment pruning.

## Security notes

- Your notes are **end-to-end encrypted** — the server stores only ciphertext. The server operator (you) cannot read notes.
- The JWT secrets in `.env` protect login sessions. Keep them secret and never commit `.env` to git.
- WireGuard means no attack surface on the public internet — the server is literally unreachable without a valid VPN peer key.
- Back up your WireGuard private key (`/etc/wireguard/server_private.key`) separately from the server. If you lose it, connected devices can no longer reach the server until you regenerate and redistribute keys.
- **Password loss = data loss.** The encryption key is derived from your password. There is no account recovery. Use a password manager.
- **CORS:** `CORS_ORIGIN` must list the exact frontend origins allowed to use your server (no `*`). Requests from any other website are rejected before they reach the API.
- **Registration:** set `ALLOW_REGISTRATION=false` once your account(s) exist so strangers cannot sign up on your server.
- You can change your password in Settings → Security → Change Password. The server requires proof of your current password, and every other session is signed out automatically.
