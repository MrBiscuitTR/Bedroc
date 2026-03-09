/**
 * lib/stores/auth.svelte.ts — Authentication state and API client.
 *
 * Manages:
 *   - Server URL with saved-server list (persisted in localStorage)
 *   - Access token (in memory only — never written to localStorage)
 *   - DEK (Data Encryption Key) — in memory only, never persisted
 *   - Login flow (SRP-6a two-step)
 *   - Register flow (SRP verifier generation + DEK creation)
 *   - Logout (clears memory state + wipes IndexedDB)
 *   - Token refresh (called automatically on 401)
 *   - apiFetch() — authenticated fetch with auto-refresh
 *
 * Security properties:
 *   - Access token in memory → cleared on page unload / logout
 *   - DEK in memory → derived from password on each login; never written to disk
 *   - Key material (encryptedDek + dekSalt) saved to IndexedDB → allows
 *     restoring the DEK from password without a server round-trip when offline
 *   - Refresh token is httpOnly cookie → not readable from JS
 *   - Server URL saved to localStorage (not sensitive)
 */

import { goto } from '$app/navigation';
import {
  deriveMasterKey,
  generateDek,
  wrapDek,
  unwrapDek,
  randomBytes,
  toHex,
  fromHex,
} from '$lib/crypto/keys.js';
import {
  srpRegister,
  srpClientEphemeral,
  srpClientProof,
  srpVerifyServer,
} from '$lib/crypto/srp.js';
import {
  saveKeyMaterial,
  loadKeyMaterial,
  clearKeyMaterial,
  wipeLocalData,
} from '$lib/db/indexeddb.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_SERVER = 'https://api.bedroc.app';
const LS_SERVERS_KEY = 'bedroc_servers';      // saved server list
const LS_LAST_SERVER_KEY = 'bedroc_last_srv'; // most recently used server URL
const REQUEST_TIMEOUT_MS = 12_000;            // 12s before treating as unreachable

/** Fetch with an AbortController timeout. Throws a user-friendly error on timeout. */
async function fetchWithTimeout(url: string, init: RequestInit = {}): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (err) {
    if ((err as Error).name === 'AbortError') {
      throw new Error('Server did not respond. Check the server URL and your connection.');
    }
    // Network error (DNS failure, connection refused, etc.)
    throw new Error('Cannot reach server. Is it running and the URL correct?');
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// State (Svelte 5 runes)
// ---------------------------------------------------------------------------

let _accessToken = $state<string | null>(null);
let _dek = $state<CryptoKey | null>(null);
let _userId = $state<string | null>(null);
let _username = $state<string | null>(null);
let _serverUrl = $state<string>(loadLastServer());
let _savedServers = $state<string[]>(loadSavedServers());
let _loading = $state(false);
let _error = $state<string | null>(null);

// ---------------------------------------------------------------------------
// Exported reactive getters
// ---------------------------------------------------------------------------

export const auth = {
  get accessToken() { return _accessToken; },
  get dek() { return _dek; },
  get userId() { return _userId; },
  get username() { return _username; },
  get serverUrl() { return _serverUrl; },
  get savedServers() { return _savedServers; },
  get loading() { return _loading; },
  get error() { return _error; },
  get isLoggedIn() { return _accessToken !== null && _dek !== null; },
};

// ---------------------------------------------------------------------------
// Server URL management
// ---------------------------------------------------------------------------

function loadLastServer(): string {
  if (typeof localStorage === 'undefined') return DEFAULT_SERVER;
  return localStorage.getItem(LS_LAST_SERVER_KEY) ?? DEFAULT_SERVER;
}

function loadSavedServers(): string[] {
  if (typeof localStorage === 'undefined') return [DEFAULT_SERVER];
  try {
    const raw = localStorage.getItem(LS_SERVERS_KEY);
    const list = raw ? (JSON.parse(raw) as string[]) : [DEFAULT_SERVER];
    if (!list.includes(DEFAULT_SERVER)) list.unshift(DEFAULT_SERVER);
    return list;
  } catch {
    return [DEFAULT_SERVER];
  }
}

/**
 * Normalise any form of server URL the user might type:
 *   "10.66.66.1"          → "https://10.66.66.1"
 *   "10.66.66.1:3000"     → "https://10.66.66.1:3000"
 *   "192.168.1.5"         → "https://192.168.1.5"
 *   "notes.example.com"   → "https://notes.example.com"
 *   "https://foo.com/"    → "https://foo.com"
 *   "http://foo.com"      → "http://foo.com"
 *
 * Rules:
 *   - If the input already has http:// or https://, keep it as-is.
 *   - Otherwise always default to https:// (browsers block mixed content
 *     when the frontend is served over HTTPS, so http:// backends fail).
 *   - Always strip trailing slash.
 */
export function normaliseServerUrl(raw: string): string {
  const trimmed = raw.trim().replace(/\/$/, '');
  if (!trimmed) return DEFAULT_SERVER;

  // Already has a scheme — keep it (user explicitly chose http:// or https://)
  if (/^https?:\/\//i.test(trimmed)) return trimmed;

  // Everything else: default to https://
  // (covers IPs, localhost, domain names — https is required for mixed-content)
  return `https://${trimmed}`;
}

export function setServerUrl(url: string): void {
  const normalized = normaliseServerUrl(url) || DEFAULT_SERVER;
  _serverUrl = normalized;
  localStorage.setItem(LS_LAST_SERVER_KEY, normalized);

  // Add to saved list if not already there
  if (!_savedServers.includes(normalized)) {
    _savedServers = [normalized, ..._savedServers];
    localStorage.setItem(LS_SERVERS_KEY, JSON.stringify(_savedServers));
  }
}

// ---------------------------------------------------------------------------
// Health check
// ---------------------------------------------------------------------------

export type ServerStatus = 'unknown' | 'checking' | 'online' | 'offline';

let _serverStatus = $state<ServerStatus>('unknown');
export const serverStatus = { get value() { return _serverStatus; } };

/**
 * Returns true if the current server URL is https:// on a bare IP —
 * meaning it is likely using a self-signed certificate that the browser
 * hasn't accepted yet. Used to show a targeted "accept cert" hint.
 */
export function isSelfSignedCandidate(url?: string): boolean {
  const target = url ?? _serverUrl;
  return /^https:\/\/(\d{1,3}\.){3}\d{1,3}(:\d+)?($|\/)/.test(target);
}

/**
 * Ping GET /health on the given (or current) server URL.
 * Updates the reactive _serverStatus.
 * Resolves to true if the server responded OK, false otherwise.
 * Has a 5-second timeout.
 */
async function tryHealthFetch(target: string): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  try {
    const res = await fetch(`${target}/health`, {
      signal: controller.signal,
      cache: 'no-store',
    });
    clearTimeout(timer);
    return res.ok;
  } catch {
    clearTimeout(timer);
    return false;
  }
}

export async function checkServerHealth(url?: string): Promise<boolean> {
  const base = url ? normaliseServerUrl(url) : _serverUrl;
  _serverStatus = 'checking';

  // Try the primary URL (always https:// after normalisation)
  if (await tryHealthFetch(base)) {
    if (base !== _serverUrl) setServerUrl(base);
    _serverStatus = 'online';
    return true;
  }

  // If https:// failed, try http:// as fallback (useful on LAN / WireGuard)
  if (base.startsWith('https://')) {
    const httpFallback = base.replace(/^https:\/\//, 'http://');
    if (await tryHealthFetch(httpFallback)) {
      setServerUrl(httpFallback); // commit the working URL
      _serverStatus = 'online';
      return true;
    }
  }

  _serverStatus = 'offline';
  return false;
}

export function removeSavedServer(url: string): void {
  if (url === DEFAULT_SERVER) return; // never remove default
  _savedServers = _savedServers.filter((s) => s !== url);
  localStorage.setItem(LS_SERVERS_KEY, JSON.stringify(_savedServers));
}

// ---------------------------------------------------------------------------
// HTTP helper
// ---------------------------------------------------------------------------

/**
 * Authenticated fetch with automatic token refresh on 401.
 * Always sends the access token from memory; never from localStorage.
 * Credentials: 'include' sends the httpOnly refresh cookie on all requests.
 */
export async function apiFetch(
  path: string,
  init: RequestInit = {}
): Promise<Response> {
  const url = `${_serverUrl}${path}`;
  const headers = new Headers(init.headers);

  // 'offline' is the sentinel for an offline-unlocked session — no Bearer token yet.
  // Attempt a token refresh first; if that succeeds, use the real token.
  if (_accessToken === 'offline') {
    const refreshed = await tryRefreshToken();
    if (!refreshed) {
      // Still offline — return a synthetic 503 so callers fail gracefully
      return new Response(JSON.stringify({ error: 'Offline' }), {
        status: 503,
        headers: { 'Content-Type': 'application/json' },
      });
    }
  }

  if (_accessToken) {
    headers.set('Authorization', `Bearer ${_accessToken}`);
  }
  headers.set('Content-Type', 'application/json');

  const res = await fetch(url, {
    ...init,
    headers,
    credentials: 'include', // send httpOnly refresh cookie
  });

  // On 401, attempt token refresh once
  if (res.status === 401 && _accessToken) {
    const refreshed = await tryRefreshToken();
    if (refreshed) {
      headers.set('Authorization', `Bearer ${_accessToken}`);
      return fetch(url, { ...init, headers, credentials: 'include' });
    }
    // Refresh failed — force logout
    await logout();
    goto('/login');
  }

  return res;
}

// ---------------------------------------------------------------------------
// Token refresh
// ---------------------------------------------------------------------------

async function tryRefreshToken(): Promise<boolean> {
  try {
    const res = await fetch(`${_serverUrl}/api/auth/refresh`, {
      method: 'POST',
      credentials: 'include',
    });
    if (!res.ok) return false;
    const data = await res.json() as { accessToken: string };
    _accessToken = data.accessToken;
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

/**
 * Register a new account.
 *
 * 1. Generate DEK (random 32 bytes)
 * 2. Derive Master Key from password + random dekSalt
 * 3. Wrap DEK with Master Key → encryptedDek
 * 4. Generate SRP salt + verifier from password
 * 5. POST to /api/auth/register
 * 6. On success, save key material to IndexedDB for offline use
 */
export async function register(username: string, password: string): Promise<void> {
  _loading = true;
  _error = null;

  try {
    // Client-side validation
    if (username.trim().length < 3) throw new Error('Username must be at least 3 characters.');
    if (password.length < 8) throw new Error('Password must be at least 8 characters.');
    // Key material
    const dekSaltBytes = randomBytes(32);
    const dekSaltHex = toHex(dekSaltBytes);
    const masterKey = await deriveMasterKey(password, dekSaltBytes);
    const { dek, dekRaw } = await generateDek();
    const encryptedDek = await wrapDek(dekRaw, masterKey);

    // SRP verifier
    const { salt: srpSalt, verifier } = await srpRegister(username, password);

    // POST to server
    const res = await fetchWithTimeout(`${_serverUrl}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({
        username,
        srpSalt,
        srpVerifier: verifier,
        encryptedDek,
        dekSalt: dekSaltHex,
      }),
    });

    if (!res.ok) {
      const body = await res.json().catch(() => ({})) as { error?: string; message?: string; details?: Record<string, unknown> };
      if (res.status === 409) throw new Error('Username already taken. Choose a different one.');
      if (res.status === 400) {
        const detail = body.details ? ` (${JSON.stringify(body.details)})` : '';
        throw new Error((body.error ?? body.message ?? 'Invalid registration details.') + detail);
      }
      if (res.status >= 500) throw new Error('Server error. Please try again later.');
      throw new Error(body.error ?? body.message ?? 'Registration failed.');
    }

    const data = await res.json() as {
      accessToken: string;
      expiresAt: string;
      userId: string;
      username: string;
      encryptedDek: string;
      dekSalt: string;
    };

    // Store DEK and access token in memory
    _accessToken = data.accessToken;
    _dek = dek;
    _userId = data.userId;
    _username = data.username;

    // Save key material to IndexedDB for next login (allows offline DEK restore)
    await saveKeyMaterial({
      id: 'current',
      username,
      userId: data.userId,
      serverUrl: _serverUrl,
      encryptedDek,
      dekSaltHex,
    });

    setServerUrl(_serverUrl); // persist server URL

  } catch (err) {
    _error = (err as Error).message;
    throw err;
  } finally {
    _loading = false;
  }
}

// ---------------------------------------------------------------------------
// Login (SRP-6a two-step)
// ---------------------------------------------------------------------------

/**
 * Log in with SRP-6a.
 *
 * Step 1: Send username + A to server → receive salt + B
 * Step 2: Compute M1 + session key, send M1 → receive access token + M2
 * Step 3: Verify M2 (proves server knows password)
 * Step 4: Derive master key → unwrap DEK from encryptedDek
 */
export async function login(username: string, password: string): Promise<void> {
  _loading = true;
  _error = null;

  try {
    // --- Step 1: Client ephemeral ---
    const { a, A } = srpClientEphemeral();

    const initRes = await fetchWithTimeout(`${_serverUrl}/api/auth/login/init`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, A }),
    });

    if (!initRes.ok) {
      if (initRes.status === 429) throw new Error('Too many login attempts. Please wait a minute and try again.');
      if (initRes.status >= 500) throw new Error('Server error. Please try again later.');
      // Intentionally vague for 400/404 — don't reveal whether username exists
      throw new Error('Invalid username or password.');
    }

    const initData = await initRes.json() as {
      salt: string;
      B: string;
    };

    // --- Step 2: Client proof ---
    const { M1, sessionKey } = await srpClientProof({
      username,
      password,
      saltHex: initData.salt,
      AHex: A,
      BHex: initData.B,
      a,
    });

    const verifyRes = await fetchWithTimeout(`${_serverUrl}/api/auth/login/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include', // receive httpOnly refresh cookie
      body: JSON.stringify({ username, A, M1 }),
    });

    if (!verifyRes.ok) {
      if (verifyRes.status === 429) throw new Error('Too many login attempts. Please wait a minute and try again.');
      if (verifyRes.status >= 500) throw new Error('Server error. Please try again later.');
      throw new Error('Invalid username or password.');
    }

    const verifyData = await verifyRes.json() as {
      accessToken: string;
      M2: string;
      userId: string;
      username: string;
      encryptedDek: string;
      dekSalt: string; // hex
    };

    // --- Step 3: Verify server proof (mutual authentication) ---
    try {
      await srpVerifyServer(A, M1, sessionKey, verifyData.M2);
    } catch {
      throw new Error('Login failed: server verification error. Please try again.');
    }

    // --- Step 4: Unwrap DEK ---
    const dekSaltBytes = fromHex(verifyData.dekSalt);
    const masterKey = await deriveMasterKey(password, dekSaltBytes);
    const dek = await unwrapDek(verifyData.encryptedDek, masterKey);

    // Store in memory
    _accessToken = verifyData.accessToken;
    _dek = dek;
    _userId = verifyData.userId;
    _username = verifyData.username;

    // Persist key material for offline DEK restore
    await saveKeyMaterial({
      id: 'current',
      username,
      userId: verifyData.userId,
      serverUrl: _serverUrl,
      encryptedDek: verifyData.encryptedDek,
      dekSaltHex: verifyData.dekSalt,
    });

    setServerUrl(_serverUrl);

  } catch (err) {
    _error = (err as Error).message;
    throw err;
  } finally {
    _loading = false;
  }
}

// ---------------------------------------------------------------------------
// Logout
// ---------------------------------------------------------------------------

export async function logout(): Promise<void> {
  const userId = _userId;

  // Clear memory first
  _accessToken = null;
  _dek = null;
  _userId = null;
  _username = null;

  // Clear per-user sync timestamp so next login does a full sync from epoch
  if (typeof localStorage !== 'undefined') {
    if (userId) localStorage.removeItem(`bedroc_last_sync_${userId}`);
    localStorage.removeItem('bedroc_last_sync'); // legacy shared key
  }

  // Revoke server session (best-effort; don't block on failure)
  try {
    await fetch(`${_serverUrl}/api/auth/logout`, {
      method: 'POST',
      credentials: 'include',
    });
  } catch {
    // Offline logout — session will expire naturally
  }

  // Wipe local IndexedDB data
  if (userId) {
    try {
      await wipeLocalData(userId);
    } catch {
      // Ignore wipe errors — worst case stale data remains
    }
  }

  await clearKeyMaterial();
}

// ---------------------------------------------------------------------------
// Restore session on page load
// ---------------------------------------------------------------------------

/**
 * Try to restore the session from the httpOnly refresh cookie.
 * Called once in +layout.svelte on mount.
 *
 * Online path:
 *   The server issues a new access token from the refresh cookie. We load
 *   key material from IndexedDB but CAN'T re-derive the DEK without the
 *   password. The app redirects to /login which shows an "Unlock" prompt.
 *
 * Offline path:
 *   The refresh request fails due to no network. If key material exists in
 *   IndexedDB we know the user was previously logged in. We set a sentinel
 *   accessToken ('offline') so the login page shows the unlock prompt.
 *   After the user enters their password, the DEK is re-derived locally —
 *   the app then works fully offline from IndexedDB. When connectivity
 *   returns, the next API call will get a 401 and trigger a real token
 *   refresh via tryRefreshToken().
 */
export async function restoreSession(): Promise<void> {
  const refreshed = await tryRefreshToken();

  if (refreshed) {
    // Online: load saved identity from IndexedDB
    const km = await loadKeyMaterial();
    if (km) {
      _username = km.username;
      _serverUrl = km.serverUrl;
      // _dek remains null — user must unlock with password
    }

    // Get userId from the access token (decode without verify — browser already verified via HTTPS)
    if (_accessToken) {
      try {
        const payload = JSON.parse(atob(_accessToken.split('.')[1])) as { sub: string };
        _userId = payload.sub;
      } catch {
        // Malformed token — treat as logged out
        _accessToken = null;
      }
    }
  } else {
    // Offline or server unreachable — check for locally stored key material
    const km = await loadKeyMaterial();
    if (km && km.userId) {
      // User was previously logged in; let them unlock with password locally
      _username = km.username;
      _userId = km.userId;
      _serverUrl = km.serverUrl;
      // Sentinel value: signals "offline locked" to the login page unlock flow
      _accessToken = 'offline';
      // _dek remains null — user must unlock with password
    }
    // If no key material, user has never logged in on this device — show login form
  }
}

/**
 * Unlock the vault with the user's password.
 * Used when session is restored but DEK is not in memory.
 *
 * @throws if password is wrong (DEK decryption will fail)
 */
export async function unlockWithPassword(password: string): Promise<void> {
  _loading = true;
  _error = null;

  try {
    const km = await loadKeyMaterial();
    if (!km) throw new Error('No local key material — please log in again');

    const dekSaltBytes = fromHex(km.dekSaltHex);
    const masterKey = await deriveMasterKey(password, dekSaltBytes);
    // Throws DOMException if password is wrong (AES-GCM auth tag mismatch)
    const dek = await unwrapDek(km.encryptedDek, masterKey);

    _dek = dek;

    // Restore identity fields in case we unlocked offline (state only partially set)
    if (!_username) _username = km.username;
    if (!_userId && km.userId) _userId = km.userId;
    if (km.serverUrl) _serverUrl = km.serverUrl;

    // Keep 'offline' sentinel so isLoggedIn stays true; real token
    // will arrive after the first successful API call triggers a refresh.
  } finally {
    _loading = false;
  }
}

// ---------------------------------------------------------------------------
// Change password
// ---------------------------------------------------------------------------

/**
 * Change the user's password.
 *
 * 1. Verify the current password by unwrapping the DEK with it.
 * 2. Generate a new dekSalt and re-derive a new Master Key from the new password.
 * 3. Re-wrap the same DEK with the new Master Key → new encryptedDek.
 * 4. Re-compute the SRP salt + verifier from the new password.
 * 5. POST new material to /api/auth/change-password.
 * 6. Update IndexedDB key material for offline use.
 *
 * The DEK itself does not change — all notes stay encrypted and accessible.
 *
 * @throws if the current password is wrong or the server request fails.
 */
export async function changePassword(currentPassword: string, newPassword: string): Promise<void> {
  _loading = true;
  _error = null;

  try {
    // Step 1: Verify current password by unwrapping DEK
    const km = await loadKeyMaterial();
    if (!km) throw new Error('No local key material. Please log in again.');

    const oldSaltBytes = fromHex(km.dekSaltHex);
    const oldMasterKey = await deriveMasterKey(currentPassword, oldSaltBytes);
    // This throws if the password is wrong
    const dekRaw = await (async () => {
      const { fromBase64 } = await import('$lib/crypto/keys.js');
      const { iv, ct } = JSON.parse(km.encryptedDek) as { iv: string; ct: string };
      const raw = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: fromBase64(iv) },
        oldMasterKey,
        fromBase64(ct)
      );
      return new Uint8Array(raw);
    })();

    if (!_username) throw new Error('Not logged in.');

    // Step 2: New salt + new master key
    const newDekSaltBytes = randomBytes(32);
    const newDekSaltHex = toHex(newDekSaltBytes);
    const newMasterKey = await deriveMasterKey(newPassword, newDekSaltBytes);

    // Step 3: Re-wrap the same DEK bytes with new master key
    const newEncryptedDek = await wrapDek(dekRaw, newMasterKey);

    // Step 4: New SRP verifier for new password
    const { salt: newSrpSalt, verifier: newSrpVerifier } = await srpRegister(_username, newPassword);

    // Step 5: Send to server
    const res = await apiFetch('/api/auth/change-password', {
      method: 'POST',
      body: JSON.stringify({
        srpSalt:      newSrpSalt,
        srpVerifier:  newSrpVerifier,
        encryptedDek: newEncryptedDek,
        dekSalt:      newDekSaltHex,
      }),
    });

    if (!res.ok) {
      const body = await res.json().catch(() => ({})) as { error?: string };
      throw new Error(body.error ?? 'Failed to change password. Please try again.');
    }

    // Step 6: Update in-memory DEK + IndexedDB
    const { unwrapDek: unwrap } = await import('$lib/crypto/keys.js');
    _dek = await unwrap(newEncryptedDek, newMasterKey);

    await saveKeyMaterial({
      id: 'current',
      username: _username,
      userId: _userId ?? '',
      serverUrl: _serverUrl,
      encryptedDek: newEncryptedDek,
      dekSaltHex: newDekSaltHex,
    });

  } catch (err) {
    _error = (err as Error).message;
    throw err;
  } finally {
    _loading = false;
  }
}
