# Bedroc Desktop — Build & Release Guide

The Electron desktop app wraps the SvelteKit frontend in a native window with a
local HTTP server, so the service worker and all web APIs work exactly as in a
browser. No backend is bundled — the user connects to their own server URL just
like on the web app.

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

Create `.github/workflows/desktop-release.yml` to build on all three platforms
in parallel when you push a version tag:

```yaml
name: Desktop Release

on:
  push:
    tags:
      - 'v*'

jobs:
  build:
    strategy:
      matrix:
        os: [windows-latest, macos-latest, ubuntu-latest]

    runs-on: ${{ matrix.os }}

    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-node@v4
        with:
          node-version: '22'

      - name: Build frontend
        run: cd bedroc && npm install && npm run build

      - name: Install desktop deps
        run: cd desktop && npm install

      - name: Build installers
        run: cd desktop && npm run dist
        env:
          # macOS signing (optional — set in GitHub repo secrets)
          CSC_LINK: ${{ secrets.CSC_LINK }}
          CSC_KEY_PASSWORD: ${{ secrets.CSC_KEY_PASSWORD }}

      - name: Upload artifacts
        uses: actions/upload-artifact@v4
        with:
          name: dist-${{ matrix.os }}
          path: desktop/dist/
          retention-days: 7

  release:
    needs: build
    runs-on: ubuntu-latest
    steps:
      - uses: actions/download-artifact@v4
        with:
          path: artifacts

      - name: Create GitHub Release
        uses: softprops/action-gh-release@v2
        with:
          files: artifacts/**/*
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
```

Push a tag to trigger it:
```bash
git tag v0.0.1 && git push origin v0.0.1
```

---

## Updating the version number

The app version is read from `desktop/package.json` → `"version"`.
Update it there before building a new release. The installer filenames
will pick it up automatically.

If you want the web app and desktop app to share the same version, also
update `bedroc/package.json` → `"version"` to match.

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
