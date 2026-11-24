# Bedroc Desktop — Build & Release Guide

The Electron desktop app wraps the SvelteKit frontend in a native window with a
local HTTP server, so the service worker and all web APIs work exactly as in a
browser. No backend is bundled — the user connects to their own server URL just
like on the web app.

---

## Releasing — the automatic way (recommended, no local tools needed)

1. On GitHub: **Actions → Release → Run workflow**, choose the bump and click **Run workflow**:
   - `patch` (1.1.0 → 1.1.1) for fixes
   - `minor` (1.1.0 → 1.2.0) for new features or protocol changes
   - `major` (1.1.0 → 2.0.0) for breaking changes
2. Wait about 15 minutes. The workflow:
   - bumps the version everywhere (`bedroc/`, `desktop/`, `server/` package files and lockfiles, plus the service-worker cache name), commits `Release vX.Y.Z` to `main` and tags it. Vercel redeploys `main`, so the web app shows the new version (**Settings → version line**, and the login page).
   - builds the desktop app on **Windows, macOS and Linux** runners.
   - publishes a **GitHub Release** `vX.Y.Z` with all installers and auto-generated notes.

Files in the release: `Bedroc Setup X.Y.Z.exe` (Windows installer), `.dmg`/`.zip` for Intel and Apple Silicon Macs, and `.AppImage`, `.deb`, `.rpm` for Linux. All are unsigned: Windows SmartScreen shows "More info → Run anyway" once, and macOS needs right-click → Open the first time.

**Test builds without releasing:** Actions → **Build Desktop Apps** → Run workflow (pick any branch). The installers appear as downloadable artifacts on the run page (kept for 14 days).

**If the release run fails** after the version commit (e.g. a flaky runner), fix the cause if there is one and click **Re-run failed jobs** on that run. The commit and tag already exist and are reused. Starting a new Release run instead would bump the version again.

**Requirements:** `main` must allow pushes from `github-actions[bot]` (no rule that requires every change to go through a pull request). The workflows use only GitHub's official actions, pinned to exact commits, with read-only permissions except where a job must push the version commit or create the release.

The manual steps below remain for building on your own machine.

---

## Prerequisites

| Tool | Version | Install |
|------|---------|---------|
| Node.js | 20 LTS or 22 LTS | https://nodejs.org |
| npm | 10+ | bundled with Node |
| Python | 3.x | required by some native node-gyp deps |

**Platform-specific:**

- **Windows:** Visual Studio Build Tools (C++ workload) — needed by electron-builder.
  Install via: `npm install --global windows-build-tools` or from VS installer.
- **macOS:** Xcode Command Line Tools — `xcode-select --install`
- **Linux:** `rpm` package (for .rpm builds): `sudo apt install rpm` (Ubuntu/Debian)

**Cross-compilation note:** You can only natively build the installer for your
current OS. To build for all platforms you need either:
- Three machines (Windows, macOS, Linux), or
- GitHub Actions CI (recommended — see below)

---

## Step 1 — Build the frontend

The Electron app bundles the SvelteKit static build from `bedroc/build/`.
You must build it before packaging.

```bash
cd bedroc
npm install
npm run build
cd ..
```

This produces `bedroc/build/` — a fully static site (HTML + JS + CSS).

---

## Step 2 — Install desktop dependencies

```bash
cd desktop
npm install
```

This installs Electron and electron-builder locally (they are large — not
committed to git, gitignored under `desktop/node_modules/`).

---

## Step 3 — Test locally (optional)

Run the app without packaging to verify it works:

```bash
cd desktop
npm start
```

The app opens a window at `http://localhost:49152` (or next available port).
Test that login, note creation, and server URL changes all work correctly.

---

## Step 4 — Build installers

Run from the `desktop/` directory.

### Windows (.exe installer + portable .exe)

```bash
npm run dist:win
```

Output in `desktop/dist/`:
- `Bedroc Setup 0.0.1.exe` — NSIS installer (recommended for distribution)
- `Bedroc 0.0.1.exe` — portable executable (no install required)

### macOS (.dmg + .zip)

```bash
npm run dist:mac
```

Output in `desktop/dist/`:
- `Bedroc-0.0.1.dmg` — disk image for x64 (Intel)
- `Bedroc-0.0.1-arm64.dmg` — disk image for arm64 (Apple Silicon)
- `.zip` variants (for auto-updater, if added later)

**Note on macOS signing:** Without an Apple Developer certificate, macOS will
show a "unidentified developer" warning. Users can right-click → Open to bypass
it. For signed/notarized builds, set these environment variables before building:

```bash
export CSC_LINK=/path/to/certificate.p12
export CSC_KEY_PASSWORD=your-password
export APPLE_ID=you@example.com
export APPLE_ID_PASSWORD=app-specific-password
export APPLE_TEAM_ID=XXXXXXXXXX
npm run dist:mac
```

### Linux (.AppImage, .deb, .rpm)

```bash
npm run dist:linux
```

Output in `desktop/dist/`:
- `Bedroc-0.0.1.AppImage` — universal (runs on any x64 Linux, no install)
- `bedroc_0.0.1_amd64.deb` — Debian/Ubuntu package
- `bedroc-0.0.1.x86_64.rpm` — Fedora/RHEL package

### All platforms at once (requires all toolchains)

```bash
npm run dist:all
```

---

## Step 5 — Icons

electron-builder looks for icons in `desktop/build-resources/`:

| File | Platform | Size |
|------|----------|------|
| `icon.ico` | Windows | 256x256 multi-res ICO |
| `icon.icns` | macOS | 1024x1024 ICNS |
| `icon.png` | Linux | 512x512 PNG |

If these files don't exist, electron-builder uses a default Electron icon.
To generate them from a single PNG:

```bash
# Install icon converter
npm install --global electron-icon-builder

# Generate all formats from a 1024x1024 PNG
electron-icon-builder --input=icon-source.png --output=build-resources
```

---

## Releasing on GitHub Releases

1. **Tag the release:**
   ```bash
   git tag v0.0.1
   git push origin v0.0.1
   ```

2. **Create the release on GitHub:**
   ```bash
   gh release create v0.0.1 \
     --title "Bedroc v0.0.1" \
     --notes "Initial desktop release." \
     desktop/dist/"Bedroc Setup 0.0.1.exe" \
     desktop/dist/"Bedroc 0.0.1.exe" \
     desktop/dist/Bedroc-0.0.1.dmg \
     desktop/dist/Bedroc-0.0.1-arm64.dmg \
     desktop/dist/Bedroc-0.0.1.AppImage \
     desktop/dist/bedroc_0.0.1_amd64.deb \
     desktop/dist/bedroc-0.0.1.x86_64.rpm
   ```

3. Users download from:
   `https://github.com/YOUR_USERNAME/Bedroc/releases/latest`

---

## Releasing on a personal website

Upload the files from `desktop/dist/` to your web server or CDN.
A simple download page linking each file is enough.

Recommended naming convention on the download page:

| Platform | File | Notes |
|----------|------|-------|
| Windows (installer) | `Bedroc-Setup-0.0.1-x64.exe` | Recommended for most users |
| Windows (portable) | `Bedroc-Portable-0.0.1-x64.exe` | No install, run anywhere |
| macOS Intel | `Bedroc-0.0.1-x64.dmg` | Intel Mac |
| macOS Apple Silicon | `Bedroc-0.0.1-arm64.dmg` | M1/M2/M3 Mac |
| Linux AppImage | `Bedroc-0.0.1-x86_64.AppImage` | Universal, no install |
| Linux .deb | `bedroc_0.0.1_amd64.deb` | Ubuntu/Debian |
| Linux .rpm | `bedroc-0.0.1.x86_64.rpm` | Fedora/RHEL |

---

## Automating builds with GitHub Actions

Already set up; see "Releasing — the automatic way" at the top:

- `.github/workflows/build-desktop.yml`: builds Windows + macOS + Linux. Runs manually, on pushed `v*` tags, or when called by the release workflow.
- `.github/workflows/release.yml`: version bump → commit + tag → build → GitHub Release.

---

## Updating the version number

Don't edit versions by hand: the Release workflow does it. For a local build, run `node scripts/bump-version.js X.Y.Z`. It keeps `bedroc/`, `desktop/` and `server/` (package files and lockfiles) plus the service-worker cache name in sync. The web app shows this version together with the git commit hash.

---

## Troubleshooting

**"App not found" error on launch**
The frontend build is missing. Run `cd bedroc && npm run build` first.

**White flash before window appears**
Already handled — the window is hidden until `ready-to-show` fires.

**Service worker not registering**
The app runs on `http://localhost` which is a secure context. If the SW
still fails, open DevTools (View → Toggle DevTools) and check the Console.

**Windows Defender SmartScreen warning**
Expected for unsigned binaries. Users click "More info" → "Run anyway".
Disappears after enough users run the installer (reputation system).

**macOS "cannot be opened because the developer cannot be verified"**
Right-click the app → Open → Open. Or sign + notarize with an Apple
Developer certificate (see Step 4 above).

**Linux AppImage won't run**
Make it executable: `chmod +x Bedroc-*.AppImage` then `./Bedroc-*.AppImage`
