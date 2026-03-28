/**
 * sw.js — Bedroc Service Worker
 *
 * Strategy:
 *   - Static assets (JS, CSS, fonts, icons): Cache-first, update in background
 *   - HTML navigation (SPA shell): Network-first, fall back to cached shell
 *   - API requests (/api/*, /ws): Never cached — always network
 *
 * On install: pre-cache the app shell (index.html + linked assets)
 * On activate: delete old caches
 * On fetch: route requests per strategy above
 *
 * Cross-platform compatibility:
 *   - iOS Safari 11.3+ (service workers supported since iOS 11.3)
 *   - Android Chrome/Firefox/Samsung Browser: full support
 *   - Desktop Chrome/Firefox/Edge/Safari: full support
 *   - PWA add-to-homescreen on all platforms: works correctly
 *
 * Notes:
 *   - iOS does NOT support push notifications from service workers (by design).
 *     Real-time sync is handled by the WebSocket client (websocket.ts) instead.
 *   - IndexedDB is NOT touched here — the main thread owns the data layer.
 *     The service worker only caches the app shell (static files).
 *   - Background Sync API is not used (poor Safari support) — sync is triggered
 *     by the online event in the main thread instead.
 */

const CACHE_NAME = 'bedroc-v8';
const SHELL_CACHE = 'bedroc-shell-v8';

// Files to pre-cache on install. SvelteKit hashes JS/CSS filenames so we
// can't hardcode them — instead we cache the shell on first navigation fetch.
const PRECACHE_URLS = [
  '/',
  '/manifest.webmanifest',
];

// ---------------------------------------------------------------------------
// Install — pre-cache shell
// ---------------------------------------------------------------------------

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const shellCache = await caches.open(SHELL_CACHE);
      // Fetch and cache the shell URLs
      await Promise.all(
        PRECACHE_URLS.map((url) =>
          fetch(url).then((r) => {
            if (r.ok) shellCache.put(url, r.clone());
            return r;
          }).catch(() => null)
        )
      );

      // Pre-cache the JS/CSS bundles referenced in the shell HTML
      // so the app works fully offline (not just the navigation shell).
      try {
        const shellRes = await shellCache.match('/');
        if (shellRes) {
          const html = await shellRes.text();
          const assetUrls = [];
          for (const m of html.matchAll(/(?:src|href)="(\/_app\/[^"]+\.(?:js|css))"/g)) {
            assetUrls.push(m[1]);
          }
          if (assetUrls.length > 0) {
            const assetCache = await caches.open(CACHE_NAME);
            await Promise.allSettled(
              assetUrls.map((url) =>
                fetch(url).then((r) => { if (r.ok) assetCache.put(url, r); }).catch(() => null)
              )
            );
          }
        }
      } catch {
        // Non-fatal — JS/CSS will be cached on first navigation instead
      }

      await self.skipWaiting();
    })()
  );
});

// ---------------------------------------------------------------------------
// Activate — clean up old caches
// ---------------------------------------------------------------------------

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((key) => key !== CACHE_NAME && key !== SHELL_CACHE)
          .map((key) => caches.delete(key))
      )
    ).then(() => self.clients.claim())
  );
});

// ---------------------------------------------------------------------------
// Fetch — routing strategy
// ---------------------------------------------------------------------------

self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // Only handle same-origin requests
  if (url.origin !== self.location.origin) return;

  // Never intercept API or WebSocket upgrade requests
  if (url.pathname.startsWith('/api/') || url.pathname === '/ws') return;

  // Never intercept non-GET requests
  if (request.method !== 'GET') return;

  // HTML navigation — network-first, fall back to shell
  if (request.mode === 'navigate' || request.headers.get('Accept')?.includes('text/html')) {
    event.respondWith(networkFirstWithShellFallback(request));
    return;
  }

  // JS and CSS — network-first so new deploys are always picked up.
  // SvelteKit hashes filenames so stale cache entries are harmless,
  // but a new deploy introduces new hashes — cache-first would serve
  // the old bundle until the SW update cycle completes.
  if (url.pathname.match(/\.(js|css)$/)) {
    event.respondWith(networkWithCacheFallback(request));
    return;
  }

  // Static assets that don't change (images, fonts, icons) — cache-first
  if (url.pathname.match(/\.(png|jpg|jpeg|svg|ico|woff2?|ttf|webmanifest)$/)) {
    event.respondWith(cacheFirst(request));
    return;
  }

  // Everything else — network with cache fallback
  event.respondWith(networkWithCacheFallback(request));
});

// ---------------------------------------------------------------------------
// Strategies
// ---------------------------------------------------------------------------

/**
 * Network-first. On failure, return the cached SPA shell (index.html).
 * This ensures the app loads offline even if the exact URL isn't cached.
 */
async function networkFirstWithShellFallback(request) {
  try {
    const response = await fetch(request);
    // Cache the successful response for future offline use
    if (response.ok) {
      const cache = await caches.open(SHELL_CACHE);
      cache.put(request, response.clone());
    }
    return response;
  } catch {
    // Network failed — return cached shell or root page
    const cached = await caches.match(request);
    if (cached) return cached;
    // Fall back to the root shell (SPA will handle routing client-side)
    const shell = await caches.match('/');
    if (shell) return shell;
    // Last resort — return a minimal offline page
    return new Response(
      '<!DOCTYPE html><html><head><meta charset="utf-8"><title>Bedroc — Offline</title></head>' +
      '<body style="font-family:system-ui;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#0f1117;color:#8b8fa8">' +
      '<div style="text-align:center"><p style="font-size:18px;color:#e2e4ed">Bedroc</p>' +
      '<p>You\'re offline. Open the app while connected to load it into cache.</p></div></body></html>',
      { headers: { 'Content-Type': 'text/html; charset=utf-8' } }
    );
  }
}

/**
 * Cache-first. Serve from cache if available, otherwise fetch and cache.
 */
async function cacheFirst(request) {
  const cached = await caches.match(request);
  if (cached) return cached;

  try {
    const response = await fetch(request);
    if (response.ok) {
      const cache = await caches.open(CACHE_NAME);
      cache.put(request, response.clone());
    }
    return response;
  } catch {
    return new Response('', { status: 503, statusText: 'Service Unavailable' });
  }
}

/**
 * Network with cache fallback. Try network; on failure serve cached version.
 */
async function networkWithCacheFallback(request) {
  try {
    const response = await fetch(request);
    if (response.ok) {
      const cache = await caches.open(CACHE_NAME);
      cache.put(request, response.clone());
    }
    return response;
  } catch {
    const cached = await caches.match(request);
    if (cached) return cached;
    return new Response('', { status: 503, statusText: 'Service Unavailable' });
  }
}
