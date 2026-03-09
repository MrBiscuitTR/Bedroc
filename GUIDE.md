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

# Allow running docker without sudo (log out and back in after this)
sudo usermod -aG docker $USER
```

Log out and log back in, then verify:
```bash
docker --version
docker compose version
```

### Linux (Fedora / RHEL / CentOS)

```bash
sudo dnf -y install dnf-plugins-core
sudo dnf config-manager --add-repo https://download.docker.com/linux/fedora/docker-ce.repo
sudo dnf install docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
sudo systemctl enable --now docker
sudo usermod -aG docker $USER
```

Log out and back in, then verify:
```bash
docker --version
docker compose version
```

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

#### 5. Update docker-compose.yml to bind to the Tailscale IP

Open `docker-compose.yml` and change the `nginx` ports section:

```yaml
ports:
  - "100.64.X.X:80:80"     # replace with your actual Tailscale IP
  - "100.64.X.X:443:443"
```

If you enabled Tailscale HTTPS and are using `tailscale serve`, you can skip the nginx binding change and use Tailscale as the TLS terminator instead.

#### 6. Start the server

```bash
docker compose up -d
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

### Create the SSL certificate

Even with WireGuard, the app needs HTTPS so the browser allows access to encrypted storage and service workers (required for offline/PWA functionality). A self-signed certificate is fine — WireGuard peers trust it because they're connecting over an already-encrypted tunnel.

```bash
mkdir -p docker/ssl
openssl req -x509 -newkey rsa:4096 -sha256 -days 3650 -nodes \
  -keyout docker/ssl/key.pem \
  -out docker/ssl/cert.pem \
  -subj "/CN=bedroc" \
  -addext "subjectAltName=IP:10.66.66.1"
```

> If you're using a public domain instead of WireGuard, generate a real certificate with [Let's Encrypt / Certbot](https://certbot.eff.org/) and place `fullchain.pem` → `cert.pem` and `privkey.pem` → `key.pem`.

### Create your `.env` file

```bash
cp .env.example .env
```

Open `.env` in a text editor and fill in:

| Variable | What to put |
|---|---|
| `POSTGRES_PASSWORD` | Any long random string — this is the database admin password |
| `DATABASE_URL` | Replace `CHANGE_THIS_DB_PASSWORD` with the same string you put in `POSTGRES_PASSWORD` |
| `JWT_ACCESS_SECRET` | Run `openssl rand -hex 32` and paste the output |
| `JWT_REFRESH_SECRET` | Run `openssl rand -hex 32` **again** (must be different from above) |
| `CORS_ORIGIN` | Leave **empty** to accept any frontend (recommended), or set to your specific frontend URL for strict mode |

**Leave `CORS_ORIGIN` empty** if you want to use the public Bedroc frontend (`https://bedroc.cagancalidag.com`) or any other frontend with your server. Set it to a specific URL only if you want to restrict access to one frontend.

**How to generate secrets:**

```bash
openssl rand -hex 32
```
Run this twice to get two different secrets for `JWT_ACCESS_SECRET` and `JWT_REFRESH_SECRET`.

### Start the server

```bash
docker compose up -d
```

Docker will download all required images (this takes a few minutes the first time), build the containers, and start everything. To check that all services are healthy:

```bash
docker compose ps
```

All services should show `healthy` or `running`. If any show `unhealthy`, check the logs:

```bash
docker compose logs server
docker compose logs postgres
```

---

## Part 4 — Connect from the app

### If using WireGuard

> **Important:** `10.66.66.1` is your WireGuard VPN IP — it is only reachable from devices connected to WireGuard. You **must** connect to WireGuard first on every device before the app can reach your server.

1. Connect your device to the WireGuard VPN
2. Navigate directly to `https://10.66.66.1` in your browser. Accept the certificate warning ("Advanced → Proceed", "Accept the Risk and Continue", or "Visit Website" depending on browser). This takes you to the Bedroc login page served by your own server.
3. Register an account and start using Bedroc.

> **Why use `https://10.66.66.1` directly?** When your backend has a self-signed certificate, browsers block `fetch()` requests to it from any other origin (including `bedroc.cagancalidag.com`) — this is a hard browser security rule with no workaround. Using the app from `https://10.66.66.1` means all requests are same-origin, so there are no cross-origin restrictions. Once the cert is accepted, bookmark it and install as a PWA from that URL for the best experience.

### If using a public domain

1. Point your domain's DNS A record to your VPS IP
2. Generate a real SSL certificate with Certbot:
   ```bash
   sudo apt-get install -y certbot
   sudo certbot certonly --standalone -d api.yourdomain.com
   sudo cp /etc/letsencrypt/live/api.yourdomain.com/fullchain.pem docker/ssl/cert.pem
   sudo cp /etc/letsencrypt/live/api.yourdomain.com/privkey.pem docker/ssl/key.pem
   ```
3. Update `docker/nginx/nginx.conf` — change `10.66.66.1` to `0.0.0.0` in the `listen` directives, and set the `server_name` to your domain
4. Run `docker compose up -d --build`
5. Open `https://bedroc.cagancalidag.com`, tap **Server**, and enter `https://api.yourdomain.com`

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

### Stopping and starting

```bash
# Stop all services
docker compose down

# Start again
docker compose up -d

# Restart a single service
docker compose restart server
```

### Viewing logs

```bash
# All services
docker compose logs -f

# Just the backend
docker compose logs -f server

# Last 50 lines
docker compose logs --tail=50 server
```

### Updating to a new version

```bash
git pull
docker compose up -d --build
```

Docker rebuilds only what changed. Your data is untouched (it lives in Docker volumes, not in the container).

---

## Backing up your data

All note data is stored in a Docker volume called `bedroc_postgres_data`. To back it up:

```bash
# Create a backup file (timestamped)
docker compose exec postgres pg_dump -U postgres bedroc \
  | gzip > bedroc-backup-$(date +%Y%m%d-%H%M%S).sql.gz
```

The file can be large if you have many notes, but the data is already encrypted — the backup file is safe to store in the cloud (Dropbox, S3, etc.).

### Restoring a backup

```bash
# Stop the server first
docker compose stop server

# Drop and recreate the database
docker compose exec postgres dropdb -U postgres bedroc
docker compose exec postgres createdb -U postgres bedroc

# Restore
gunzip -c bedroc-backup-TIMESTAMP.sql.gz | docker compose exec -T postgres psql -U postgres bedroc

# Start again
docker compose start server
```

### Automating backups (Linux — cron)

```bash
crontab -e
```

Add this line to back up every day at 3am:
```
0 3 * * * cd /path/to/Bedroc && docker compose exec -T postgres pg_dump -U postgres bedroc | gzip > /backups/bedroc-$(date +\%Y\%m\%d).sql.gz
```

---

## Troubleshooting

### "Cannot reach server" / "Unreachable" in the app

**If you're using a WireGuard backend (10.66.66.1):**

- `10.66.66.1` is a VPN-private IP. It is **only reachable from devices connected to WireGuard**. If you open the public Bedroc frontend (`https://bedroc.cagancalidag.com`) on a device that is NOT connected to WireGuard, the app correctly reports "Unreachable" — the browser cannot route to that IP. Connect to WireGuard first.
- If you ARE connected to WireGuard and still see "Unreachable": you may need to accept the self-signed certificate first. Open `https://10.66.66.1` directly in a new tab, click through the certificate warning, then retry.

**General checklist:**

1. Check that the server field shows the correct URL (tap it on the login page)
2. Make sure you're connected to WireGuard (if using VPN setup)
3. Check that all Docker containers are running: `docker compose ps` — all should show `healthy`
4. Test the health endpoint from the server itself: `curl -k https://10.66.66.1/health` (or `curl http://localhost:3000/health` inside the server container)
5. Check the server logs: `docker compose logs server`

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

### Database won't start

Check logs: `docker compose logs postgres`. The most common cause is a permissions issue on the data volume. Try:
```bash
docker compose down -v   # WARNING: this deletes the database
docker compose up -d
```

> Only use `-v` if you don't have data you care about, or have a backup.

### Port conflict: something else is already on port 443 or 80

Edit `docker-compose.yml` and change the host port:
```yaml
ports:
  - "10.66.66.1:8443:443"
  - "10.66.66.1:8080:80"
```
Then connect to `https://10.66.66.1:8443` instead.

---

## Security notes

- Your notes are **end-to-end encrypted** — the server stores only ciphertext. The server operator (you) cannot read notes.
- The JWT secrets in `.env` protect login sessions. Keep them secret and never commit `.env` to git.
- WireGuard means no attack surface on the public internet — the server is literally unreachable without a valid VPN peer key.
- Back up your WireGuard private key (`/etc/wireguard/server_private.key`) separately from the server. If you lose it, connected devices can no longer reach the server until you regenerate and redistribute keys.
- **Password loss = data loss.** The encryption key is derived from your password. There is no account recovery. Use a password manager.
- **CORS:** By default, `CORS_ORIGIN` is empty — any frontend (including the public hosted one) can connect to your server. Security is enforced by JWT tokens, not CORS. Set `CORS_ORIGIN` to a specific URL to restrict to one frontend only.
- You can change your password in Settings → Security → Change Password. This re-derives the master key and re-wraps the encryption key. To invalidate all existing sessions after a password change, also use "Revoke all sessions" in Settings.
