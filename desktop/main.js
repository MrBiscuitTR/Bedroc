/**
 * main.js — Bedroc Electron main process
 *
 * Serves the SvelteKit static build from a local HTTP server, then opens
 * a BrowserWindow pointing at http://localhost:PORT.
 *
 * Why a local HTTP server instead of file:// URLs?
 *   - Service workers require an HTTP(S) origin — file:// doesn't work.
 *   - fetch() with relative URLs works correctly on HTTP.
 *   - IndexedDB, localStorage, and cookies all behave normally on localhost.
 *
 * The app folder (../bedroc/build, bundled into app/ by electron-builder)
 * is resolved relative to process.resourcesPath in production, or relative
 * to __dirname in development (npm start from desktop/).
 */

const { app, BrowserWindow, shell, Menu, MenuItem, nativeImage, session, clipboard, ipcMain } = require('electron');
const http = require('http');
const path = require('path');
const fs = require('fs');

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const DEV_MODE = !app.isPackaged;
// In dev: app files are in ../bedroc/build (relative to desktop/)
// In prod: electron-builder copies bedroc/build to resources/app/ via extraResources,
//          so it lands on disk at process.resourcesPath/app — readable by Node fs.
const APP_DIR = DEV_MODE
  ? path.join(__dirname, '..', 'bedroc', 'build')
  : path.join(process.resourcesPath, 'app');

// Find a free port starting from 49152 (private/ephemeral range)
const START_PORT = 49152;

// ---------------------------------------------------------------------------
// Serve static files
// ---------------------------------------------------------------------------

/**
 * Minimal static file server — no external deps at runtime except Node built-ins.
 * Handles: content-type detection, SPA fallback (serves index.html for unknown paths),
 * basic cache headers.
 */
const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'application/javascript; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg':  'image/svg+xml',
  '.ico':  'image/x-icon',
  '.woff': 'font/woff',
  '.woff2':'font/woff2',
  '.ttf':  'font/ttf',
  '.webmanifest': 'application/manifest+json',
};

function serveFile(res, filePath, isSpaFallback = false) {
  const ext = path.extname(filePath).toLowerCase();
  const contentType = MIME_TYPES[ext] || 'application/octet-stream';

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }
    const headers = { 'Content-Type': contentType };
    // Hashed assets can be cached long-term; everything else no-cache
    if (!isSpaFallback && filePath.includes('/_app/')) {
      headers['Cache-Control'] = 'public, max-age=31536000, immutable';
    } else {
      headers['Cache-Control'] = 'no-cache';
    }
    // CSP for HTML responses — satisfies Electron's security warning.
    // connect-src * is required: users point the app at arbitrary backend URLs.
    // unsafe-inline is required for SvelteKit's hydration scripts and Svelte styles.
    if (ext === '.html') {
      headers['Content-Security-Policy'] =
        "default-src 'self'; " +
        "script-src 'self' 'unsafe-inline'; " +
        "style-src 'self' 'unsafe-inline'; " +
        "img-src 'self' data: blob: https:; " +
        "font-src 'self' data:; " +
        "connect-src *; " +
        "worker-src 'self' blob:; " +
        "object-src blob:; " +
        "frame-src 'self' blob:;";
    }
    res.writeHead(200, headers);
    res.end(data);
  });
}

function createServer(port) {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      // Strip query string and decode URI
      let urlPath = req.url.split('?')[0];
      try { urlPath = decodeURIComponent(urlPath); } catch {}

      // Normalise: /  →  /index.html
      if (urlPath === '/') urlPath = '/index.html';

      const filePath = path.join(APP_DIR, urlPath);

      // Security: prevent directory traversal outside APP_DIR
      if (!filePath.startsWith(APP_DIR + path.sep) && filePath !== APP_DIR) {
        res.writeHead(403);
        res.end('Forbidden');
        return;
      }

      fs.access(filePath, fs.constants.F_OK, (err) => {
        if (!err) {
          serveFile(res, filePath);
        } else {
          // SPA fallback — let SvelteKit client-side router handle the path
          serveFile(res, path.join(APP_DIR, 'index.html'), true);
        }
      });
    });

    server.on('error', (e) => {
      if (e.code === 'EADDRINUSE') {
        // Try next port
        createServer(port + 1).then(resolve).catch(reject);
      } else {
        reject(e);
      }
    });

    server.listen(port, '127.0.0.1', () => {
      resolve({ server, port });
    });
  });
}

// ---------------------------------------------------------------------------
// BrowserWindow
// ---------------------------------------------------------------------------

let mainWindow = null;
let httpServer = null;
let serverPort = null;

function createWindow(port) {
  const iconPath = path.join(__dirname, 'build-resources', 'icon.png');
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 480,
    minHeight: 600,
    backgroundColor: '#0f1117',
    icon: fs.existsSync(iconPath) ? iconPath : undefined,
    // Show window only after content has loaded (avoids white flash)
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      // Allow service worker on localhost
      allowRunningInsecureContent: false,
      // Keep the renderer painting even while the window is hidden (show: false).
      // Without this, Chromium may skip compositing frames before show() is called,
      // leaving a stale/blank frame buffer after SPA navigations.
      paintWhenInitiallyHidden: true,
    },
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    autoHideMenuBar: process.platform !== 'darwin',
  });

  mainWindow.loadURL(`http://localhost:${port}`);

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    if (DEV_MODE) mainWindow.webContents.openDevTools();
  });

  // Open external links in the default browser, not a new Electron window
  // Right-click context menu with copy/cut/paste/paste-without-formatting
  mainWindow.webContents.on('context-menu', (event, params) => {
    const menu = new Menu();

    if (params.selectionText) {
      menu.append(new MenuItem({
        label: 'Cut',
        enabled: params.isEditable,
        click: () => mainWindow.webContents.cut(),
      }));
      menu.append(new MenuItem({
        label: 'Copy',
        click: () => mainWindow.webContents.copy(),
      }));
    }

    menu.append(new MenuItem({
      label: 'Paste',
      enabled: params.isEditable,
      click: () => mainWindow.webContents.paste(),
    }));

    menu.append(new MenuItem({
      label: 'Paste without formatting',
      enabled: params.isEditable,
      click: () => mainWindow.webContents.pasteAndMatchStyle(),
    }));

    if (params.selectionText || params.isEditable) {
      menu.append(new MenuItem({ type: 'separator' }));
      menu.append(new MenuItem({
        label: 'Select All',
        enabled: params.isEditable,
        click: () => mainWindow.webContents.selectAll(),
      }));
    }

    if (menu.items.length > 0) menu.popup({ window: mainWindow });
  });

  // Fix: After SvelteKit SPA navigation (login → main page), Electron's
  // renderer can show a blank screen until the window is resized by 1px.
  // Root cause: Chromium skips
  // relayout when `body` is `position: fixed` and the top-level child
  // swaps (auth-shell → app-shell).  A resize forces relayout.
  // We watch for child-list changes on the body's first div (SvelteKit root)
  // and force a relayout by toggling a CSS transform.
  mainWindow.webContents.on('dom-ready', () => {
    mainWindow.webContents.executeJavaScript(`
      (function() {
        const root = document.body.firstElementChild;
        if (!root) return;
        new MutationObserver(() => {
          requestAnimationFrame(() => {
            document.body.style.transform = 'translateZ(0)';
            requestAnimationFrame(() => {
              document.body.style.transform = '';
            });
          });
        }).observe(root, { childList: true });
      })();
    `).catch(() => {});
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (!url.startsWith(`http://localhost:${port}`)) {
      shell.openExternal(url);
      return { action: 'deny' };
    }
    return { action: 'allow' };
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// ---------------------------------------------------------------------------
// Application menu (macOS-style with Edit commands)
// ---------------------------------------------------------------------------

function buildMenu() {
  const isMac = process.platform === 'darwin';
  const template = [
    ...(isMac ? [{
      label: app.name,
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    }] : []),
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
      ],
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'forceReload' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
        ...(DEV_MODE ? [{ type: 'separator' }, { role: 'toggleDevTools' }] : []),
      ],
    },
    {
      label: 'Window',
      submenu: [
        { role: 'minimize' },
        { role: 'zoom' },
        ...(isMac ? [{ type: 'separator' }, { role: 'front' }] : []),
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ---------------------------------------------------------------------------
// App lifecycle
// ---------------------------------------------------------------------------

// Set AppUserModelId so Windows can identify the app consistently
// This fixes issues with taskbar pinning and shortcuts
app.setAppUserModelId('com.bedroc.app');

ipcMain.handle('print', async (event) => {
  try {
    // Prefer renderer window.print() so Chromium can use its standard print UI.
    await event.sender.executeJavaScript('window.print()');
    return { ok: true };
  } catch {
    // Fallback to Electron print API if executeJavaScript is blocked/fails.
    event.sender.print({ printBackground: true });
    return { ok: true };
  }
});

app.whenReady().then(async () => {
  // Allow self-signed TLS certificates for private/local IP addresses.
  // Covers ALL network requests (fetch, WebSocket, navigation) for WireGuard IPs,
  // RFC-1918, Tailscale, and loopback. Public internet addresses remain fully verified.
  //
  // setCertificateVerifyProc covers renderer fetch() / XHR / WebSocket.
  // certificate-error covers navigation-level cert errors.
  // Both are needed — they handle different Chromium code paths.
  function isPrivateHost(hostname) {
    return (
      hostname === 'localhost' ||
      hostname === '127.0.0.1' ||
      /^10\./.test(hostname) ||
      /^192\.168\./.test(hostname) ||
      /^172\.(1[6-9]|2\d|3[01])\./.test(hostname) ||
      /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(hostname) || // Tailscale CGNAT
      /^169\.254\./.test(hostname)
    );
  }

  // Covers fetch(), XHR, WebSocket — the primary path for API calls
  const { session } = require('electron');
  session.defaultSession.setCertificateVerifyProc((request, callback) => {
    try {
      if (isPrivateHost(request.hostname)) {
        callback(0); // 0 = OK, bypass verification
        return;
      }
    } catch {}
    callback(-3); // -3 = use default Chromium verification
  });

  // Covers page navigation cert errors (secondary, belt-and-suspenders)
  app.on('certificate-error', (event, webContents, url, error, certificate, callback) => {
    try {
      const { hostname } = new URL(url);
      if (isPrivateHost(hostname)) {
        event.preventDefault();
        callback(true);
        return;
      }
    } catch {}
    callback(false);
  });

  // Verify the frontend build exists
  if (!fs.existsSync(APP_DIR)) {
    const msg = DEV_MODE
      ? `Frontend build not found at:\n${APP_DIR}\n\nRun: cd bedroc && npm run build`
      : `App files missing from package. Please reinstall.`;
    const { dialog } = require('electron');
    dialog.showErrorBox('Bedroc — Build not found', msg);
    app.quit();
    return;
  }

  // Start local HTTP server
  const result = await createServer(START_PORT);
  httpServer = result.server;
  serverPort = result.port;

  buildMenu();
  createWindow(serverPort);

  // macOS: re-create window when dock icon is clicked and no windows are open
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow(serverPort);
    }
  });
});

// Quit when all windows are closed (except on macOS)
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('before-quit', () => {
  if (httpServer) {
    httpServer.close();
  }
});
