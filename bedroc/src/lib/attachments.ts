/**
 * lib/attachments.ts — Image/file attachment handling with cross-device sync.
 *
 * Architecture:
 *   - Attachments are content-addressed by SHA-256(plaintext data URI).
 *   - Before sync: extract data: URIs from HTML → encrypt → store in IndexedDB
 *     → upload encrypted blob to server (once per hash) → replace with placeholder.
 *   - After load: placeholder → check IndexedDB → if missing, fetch from server
 *     → decrypt → store in IndexedDB → substitute back.
 *   - Same content on any device → same hash → stored/uploaded once (idempotent).
 *   - Body sent to server contains only tiny `attachment:<hash>` placeholders,
 *     not the raw blob — so normal note syncs never carry attachment data.
 *
 * Encryption:
 *   - Stored as `enc:<JSON { iv: base64, ct: base64 }>` in both IndexedDB and server.
 *   - AES-256-GCM with the user's DEK.
 *   - Hash is over PLAINTEXT so same image → same key regardless of which DEK encrypted it.
 */

import {
  saveAttachment,
  getAttachment,
  type AttachmentRecord,
} from '$lib/db/indexeddb.js';
import { encryptField, decryptField } from '$lib/crypto/encrypt.js';
import { apiFetch } from '$lib/stores/auth.svelte.js';

export const PLACEHOLDER_PREFIX = 'attachment:';

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Compute a hex SHA-256 hash of a string (over plaintext for content-addressing). */
async function sha256Hex(str: string): Promise<string> {
  const buf = new TextEncoder().encode(str);
  const hash = await crypto.subtle.digest('SHA-256', buf);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/** A data URI safe to substitute into an HTML attribute (no quote/markup chars). */
const SAFE_DATA_URI = /^data:[^"'<>`\s]*$/;

/**
 * Decrypt a stored `enc:` blob and verify it really is the attachment `hash`
 * refers to. The hash comes from the (authenticated) note body, so this stops
 * a malicious server from substituting a different attachment, and the
 * character check stops anything that could break out of an HTML attribute.
 */
async function decryptAndVerify(stored: string, hash: string, dek: CryptoKey): Promise<string | null> {
  if (!stored.startsWith('enc:')) return null;
  const field = JSON.parse(stored.slice(4));
  const dataUri = await decryptField(field, dek);
  if (!SAFE_DATA_URI.test(dataUri)) return null;
  if ((await sha256Hex(dataUri)) !== hash) return null;
  return dataUri;
}

/** Verify a locally stored plaintext data URI (legacy / vault-locked saves). */
async function verifyPlain(dataUri: string, hash: string): Promise<string | null> {
  if (!SAFE_DATA_URI.test(dataUri)) return null;
  if ((await sha256Hex(dataUri)) !== hash) return null;
  return dataUri;
}

/**
 * Upload a single attachment to the server if the server doesn't have it yet.
 * Only ever uploads ciphertext (`enc:` prefix) — plaintext is refused.
 * Silently swallows network errors — offline is fine, it will upload next time.
 */
async function uploadToServer(
  hash: string,
  encryptedData: string,
  mimeType: string,
  sizeBytes: number
): Promise<void> {
  if (!encryptedData.startsWith('enc:')) {
    console.warn(`[attachments] Refusing to upload unencrypted attachment ${hash.slice(0, 8)}`);
    return;
  }
  try {
    const res = await apiFetch(`/api/attachments/${hash}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ encryptedData, mimeType, sizeBytes }),
    });
    // 204 = success, 401 = not logged in (skip), anything else = log
    if (!res.ok && res.status !== 401) {
      console.warn(`[attachments] Upload failed for ${hash.slice(0, 8)}: ${res.status}`);
    }
  } catch {
    // Network error — offline. Will retry on next save.
  }
}

/**
 * Fetch an attachment from the server and store it in IndexedDB.
 * Returns the decrypted data URI, or null if unavailable.
 */
async function fetchFromServer(
  hash: string,
  userId: string,
  dek: CryptoKey
): Promise<string | null> {
  try {
    const res = await apiFetch(`/api/attachments/${hash}`);
    if (!res.ok) return null;

    const json = await res.json() as { encryptedData: string; mimeType: string; sizeBytes: number };
    const { encryptedData } = json;
    if (typeof encryptedData !== 'string') return null;

    // The server is untrusted: only accept ciphertext that decrypts under our
    // DEK AND hashes to the requested id. Anything else is discarded.
    const dataUri = await decryptAndVerify(encryptedData, hash, dek);
    if (!dataUri) {
      console.warn(`[attachments] Server returned invalid data for ${hash.slice(0, 8)} — ignored`);
      return null;
    }

    // Cache in IndexedDB for offline use (mime derived from the verified data URI)
    const mimeType = dataUri.slice(5, dataUri.search(/[;,]/)) || 'application/octet-stream';
    const record: AttachmentRecord = { hash, userId, dataUri: encryptedData, mimeType, createdAt: Date.now() };
    await saveAttachment(record);
    return dataUri;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Extract data: URIs from HTML body, encrypt each one, store in IndexedDB,
 * upload to server, and return the body with `attachment:<hash>` placeholders.
 *
 * Call this before encrypting/syncing a note body.
 *
 * @param body    raw HTML from TipTap (may contain data: URIs in src="...")
 * @param userId  current user id (for IndexedDB keying)
 * @param dek     AES-256-GCM CryptoKey — if null/undefined, attachments are
 *                stored plaintext (vault locked / offline without key).
 * @returns       HTML with `attachment:<hash>` in place of every data: URI
 */
export async function extractAttachments(
  body: string,
  userId: string,
  dek?: CryptoKey | null
): Promise<string> {
  if (!body.includes('data:')) return body;

  const pattern = /src=["'](data:[^"']+)["']/g;
  const replacements: Array<{ dataUri: string; placeholder: string }> = [];
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(body)) !== null) {
    const dataUri = match[1];
    const hash = await sha256Hex(dataUri);
    replacements.push({ dataUri, placeholder: `${PLACEHOLDER_PREFIX}${hash}` });

    const mimeType = dataUri.slice(5, dataUri.indexOf(';')) || 'application/octet-stream';
    // Approximate plaintext size: base64 is ~4/3 of binary; data URI has header
    const sizeBytes = Math.round((dataUri.length - dataUri.indexOf(',') - 1) * 0.75);

    let storedUri: string;
    if (dek) {
      const encrypted = await encryptField(dataUri, dek);
      storedUri = `enc:${JSON.stringify(encrypted)}`;
    } else {
      storedUri = dataUri;
    }

    const existing = await getAttachment(hash);

    if (!existing) {
      const record: AttachmentRecord = { hash, userId, dataUri: storedUri, mimeType, createdAt: Date.now() };
      await saveAttachment(record);
    } else if (dek && !existing.dataUri.startsWith('enc:')) {
      // Upgrade plaintext → encrypted
      await saveAttachment({ ...existing, dataUri: storedUri });
    }

    // Always attempt server upload — server uses ON CONFLICT DO NOTHING so
    // re-uploading an already-stored hash is a no-op. This ensures the server
    // gets the blob even if a previous fire-and-forget upload silently failed.
    if (dek) {
      uploadToServer(hash, storedUri, mimeType, sizeBytes); // fire-and-forget
    }
  }

  let result = body;
  for (const { dataUri, placeholder } of replacements) {
    result = result.replaceAll(dataUri, placeholder);
  }
  return result;
}

/**
 * Restore attachment placeholders back to data: URIs.
 *
 * If a hash is missing from IndexedDB, attempts to fetch it from the server
 * (for cross-device sync). Falls back gracefully if offline or vault locked.
 *
 * @param body    HTML that may contain `attachment:<hash>` placeholders
 * @param userId  current user id (for server fetch caching)
 * @param dek     AES-256-GCM CryptoKey for decrypting stored blobs.
 *                If null/undefined, encrypted attachments remain as placeholders.
 * @returns       HTML with placeholders replaced by their data: URIs
 */
export async function rehydrateAttachments(
  body: string,
  userId: string,
  dek?: CryptoKey | null
): Promise<string> {
  if (!body.includes(PLACEHOLDER_PREFIX)) return body;

  const hashPattern = /attachment:([0-9a-f]{64})/g;
  const hashes = new Set<string>();
  let m: RegExpExecArray | null;
  while ((m = hashPattern.exec(body)) !== null) {
    hashes.add(m[1]);
  }

  const entries = await Promise.all(
    [...hashes].map(async (hash) => {
      let record = await getAttachment(hash);

      // Not in IndexedDB — try fetching from server (cross-device sync)
      if (!record && dek) {
        const decrypted = await fetchFromServer(hash, userId, dek);
        return { hash, dataUri: decrypted };
      }

      if (!record) return { hash, dataUri: null };

      let dataUri: string | null;

      if (record.dataUri.startsWith('enc:')) {
        if (!dek) return { hash, dataUri: null }; // vault locked
        try {
          dataUri = await decryptAndVerify(record.dataUri, hash, dek);
        } catch {
          dataUri = null;
        }
        // Corrupted or wrong key — try server as fallback
        if (!dataUri) dataUri = await fetchFromServer(hash, userId, dek);
      } else {
        dataUri = await verifyPlain(record.dataUri, hash);
      }

      return { hash, dataUri };
    })
  );

  let result = body;
  for (const { hash, dataUri } of entries) {
    if (dataUri) {
      result = result.replaceAll(`${PLACEHOLDER_PREFIX}${hash}`, dataUri);
    }
    // Missing or undecryptable → placeholder stays, <img> renders nothing
  }
  return result;
}

/**
 * Upload a file attachment (non-image) to the server.
 * Called from the note editor when a file card is inserted.
 * Returns the hash used as the node's key.
 */
export async function uploadFileAttachment(
  dataUri: string,
  mimeType: string,
  userId: string,
  dek?: CryptoKey | null
): Promise<string> {
  const hash = await sha256Hex(dataUri);
  const sizeBytes = Math.round((dataUri.length - dataUri.indexOf(',') - 1) * 0.75);

  let storedUri: string;
  if (dek) {
    const encrypted = await encryptField(dataUri, dek);
    storedUri = `enc:${JSON.stringify(encrypted)}`;
  } else {
    storedUri = dataUri;
  }

  const existing = await getAttachment(hash);
  if (!existing) {
    await saveAttachment({ hash, userId, dataUri: storedUri, mimeType, createdAt: Date.now() });
  } else if (dek && !existing.dataUri.startsWith('enc:')) {
    await saveAttachment({ ...existing, dataUri: storedUri });
  }

  // Always attempt upload — server ignores duplicates (ON CONFLICT DO NOTHING).
  // This covers the case where a previous fire-and-forget upload silently failed.
  if (dek) uploadToServer(hash, storedUri, mimeType, sizeBytes);

  return hash;
}

/**
 * Re-attempt server upload for a known attachment hash (fire-and-forget).
 * Called on every save and on note load to ensure attachments reach the server
 * even if the original upload silently failed. Server ignores duplicates (ON CONFLICT DO NOTHING).
 */
export function retryAttachmentUpload(hash: string, _userId: string, dek: CryptoKey | null): void {
  getAttachment(hash).then(async (rec) => {
    if (!rec || !rec.dataUri) return;
    let stored = rec.dataUri;
    if (!stored.startsWith('enc:')) {
      // Saved while the vault was locked → plaintext in IndexedDB. Encrypt it
      // locally first; NEVER send plaintext to the server.
      if (!dek || !(await verifyPlain(stored, hash))) return;
      stored = `enc:${JSON.stringify(await encryptField(stored, dek))}`;
      await saveAttachment({ ...rec, dataUri: stored });
    }
    const approxBytes = Math.round(stored.length * 0.7);
    uploadToServer(hash, stored, rec.mimeType, approxBytes);
  }).catch(() => {});
}

/**
 * Load and decrypt a file attachment by hash.
 * Tries IndexedDB first, then server.
 */
export async function loadFileAttachment(
  hash: string,
  userId: string,
  dek?: CryptoKey | null
): Promise<string | null> {
  const record = await getAttachment(hash);

  if (record) {
    if (record.dataUri.startsWith('enc:')) {
      if (!dek) return null;
      try {
        const verified = await decryptAndVerify(record.dataUri, hash, dek);
        if (verified) return verified;
      } catch { /* fall through to server */ }
      return fetchFromServer(hash, userId, dek);
    }
    return verifyPlain(record.dataUri, hash);
  }

  // Not local — fetch from server
  if (!dek) return null;
  return fetchFromServer(hash, userId, dek);
}
