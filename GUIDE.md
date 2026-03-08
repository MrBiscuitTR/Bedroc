# Bedroc — Self-Hosting Guide

This guide walks you through running your own Bedroc server so only you (and people you invite via VPN) can access your notes. No programming experience required.

> **What you get:** Your notes are encrypted on your device before they leave it. Even the server cannot read them. This guide sets up the server component — a place to store and sync those encrypted blobs.

---

## What you need

- A computer or VPS (Virtual Private Server) to act as the server
  - Any Linux VPS from DigitalOcean, Hetzner, Linode, Vultr, etc. works — the cheapest tier (~$5/month) is plenty
  - You can also self-host on a home server or a spare machine
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
   - Choose "Apple Chip" if you have an M1/M2/M3 Mac, or "Intel Chip" otherwise
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

---

## Part 2 — Set up WireGuard (recommended for private access)

Bedroc's default setup uses [WireGuard](https://www.wireguard.com/) — a modern VPN. This means your notes server is **invisible to the public internet** and only reachable from devices you've personally authorised.

If you just want to test locally or on a LAN, you can skip this and come back to it later. Jump to Part 3 — but note that without WireGuard or a domain with HTTPS, the setup will use plain HTTP.

### Install WireGuard on your server (Linux)

```bash
sudo apt-get install -y wireguard
```

### Generate server keys

```bash
wg genkey | sudo tee /etc/wireguard/server_private.key | wg pubkey | sudo tee /etc/wireguard/server_public.key
sudo chmod 600 /etc/wireguard/server_private.key
```

### Create `/etc/wireguard/wg0.conf`

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

### Start WireGuard

```bash
sudo systemctl enable wg-quick@wg0
sudo systemctl start wg-quick@wg0
```

Verify it's running:
```bash
sudo wg show
```

### Open the WireGuard port in your firewall

If using `ufw`:
```bash
sudo ufw allow 51820/udp
```

If your VPS has a cloud firewall (DigitalOcean, Hetzner, etc.), also open UDP port 51820 in the control panel.

### Adding a device (phone, laptop, etc.)

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
- iPhone/iPad: [App Store](https://apps.apple.com/app/wireguard/id1441195209)
- Android: [Play Store](https://play.google.com/store/apps/details?id=com.wireguard.android)
- Windows/Mac: [wireguard.com/install](https://www.wireguard.com/install/)

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

Even with WireGuard, the app needs HTTPS so the browser allows access to encrypted storage (IndexedDB, Service Workers, etc.). A self-signed certificate is fine — WireGuard peers trust it because they're connecting over an already-encrypted tunnel.

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
| `CORS_ORIGIN` | `https://10.66.66.1` (or your domain: `https://notes.yourdomain.com`) |

Leave everything else as-is unless you know what you're changing.

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

1. Connect your device to the WireGuard VPN
2. Open the Bedroc app (or visit `https://10.66.66.1` in your browser)
3. Your browser will warn about the self-signed certificate — this is expected. Click "Advanced" → "Proceed" (Chrome) or "Accept the Risk and Continue" (Firefox)
4. On the login/register page, the "Server" field should already show `https://10.66.66.1`
5. Register an account and start using Bedroc

### If using a public domain

1. Point your domain's DNS A record to your VPS IP
2. Generate a real SSL certificate with Certbot:
   ```bash
   sudo apt-get install -y certbot
   sudo certbot certonly --standalone -d notes.yourdomain.com
   sudo cp /etc/letsencrypt/live/notes.yourdomain.com/fullchain.pem docker/ssl/cert.pem
   sudo cp /etc/letsencrypt/live/notes.yourdomain.com/privkey.pem docker/ssl/key.pem
   ```
3. In `.env`, change `CORS_ORIGIN=https://notes.yourdomain.com`
4. Update `docker/nginx/nginx.conf` — change `10.66.66.1` to `0.0.0.0` in the `listen` directives, and set the `server_name` to your domain
5. Run `docker compose up -d --build`
6. Open `https://notes.yourdomain.com` in your browser

### From the Bedroc app or website

In the Server field on the login/register page, enter your server address in any format:

| What you type | What Bedroc uses |
|---|---|
| `10.66.66.1` | `http://10.66.66.1` |
| `10.66.66.1:3000` | `http://10.66.66.1:3000` |
| `notes.yourdomain.com` | `https://notes.yourdomain.com` |
| `https://notes.yourdomain.com` | `https://notes.yourdomain.com` |

The app saves your server URL so you only need to enter it once.

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

### "Cannot reach server" in the app

1. Make sure you're connected to WireGuard (if using VPN setup)
2. Check that all Docker containers are running: `docker compose ps`
3. Test the health endpoint from your server: `curl http://localhost:3000/health`
4. Check the server logs: `docker compose logs server`

### "Certificate error" / browser warning

Expected with a self-signed certificate. Click through the warning once. The connection is still encrypted — the warning just means the certificate wasn't issued by a public certificate authority.

### Forgot to save my server address

The app shows a "Server" toggle on the login page. Click it to see or change the server URL.

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
