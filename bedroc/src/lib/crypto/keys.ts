/**
 * lib/crypto/keys.ts — Key derivation and DEK management.
 *
 * Two-layer key architecture:
 *
 *   Password
 *     └─ PBKDF2(password, dekSalt, 600_000 iterations, SHA-256) ─→ Master Key (AES-256)
 *           └─ AES-256-GCM.decrypt(encryptedDek) ─→ DEK (Data Encryption Key)
 *                 └─ AES-256-GCM.encrypt(noteTitle | noteBody) ─→ ciphertext
 *
 * The server stores:
 *   - `encrypted_dek`  — { iv: base64, ct: base64 } JSON string
 *   - `dek_salt`       — hex string (32 bytes)
 *
 * The server NEVER sees the plaintext DEK or Master Key.
 * The DEK lives in memory only (never written to disk/localStorage).
 *
 * All crypto is via the browser-native WebCrypto API — no external libraries.
 */

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Encode a Uint8Array to a base64 string. */
export function toBase64(bytes: Uint8Array): string {
  // Chunked to avoid "Maximum call stack size exceeded" on large inputs
  // (spread-calling String.fromCharCode with a huge array overflows the stack).
  let binary = '';
  const CHUNK = 8192;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

/** Decode a base64 string to a Uint8Array. */
export function fromBase64(b64: string): Uint8Array {
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

/** Encode a Uint8Array to a lowercase hex string. */
export function toHex(bytes: Uint8Array): string {
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Decode a hex string to a Uint8Array. */
export function fromHex(hex: string): Uint8Array {
  const result = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    result[i / 2] = parseInt(hex.slice(i, i + 2), 16);
  }
  return result;
}

/** Encode a string as UTF-8 bytes. */
export function encode(str: string): Uint8Array {
  return new TextEncoder().encode(str);
}

/** Decode UTF-8 bytes to a string. */
export function decode(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

/** Cryptographically random bytes. */
export function randomBytes(n: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(n));
}

// ---------------------------------------------------------------------------
// Key import
// ---------------------------------------------------------------------------

/**
 * Import raw bytes as a CryptoKey for AES-256-GCM.
 * @param keyBytes  — 32 raw bytes
 * @param usage     — 'encrypt' | 'decrypt' | both
 */
async function importAesKey(
  keyBytes: Uint8Array,
  usage: KeyUsage[]
): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    keyBytes,
    { name: 'AES-GCM', length: 256 },
    false, // not extractable — key stays in secure memory
    usage
  );
}

// ---------------------------------------------------------------------------
// Master Key derivation via PBKDF2
// ---------------------------------------------------------------------------

/**
 * Derive a Master Key from the user's password and a salt using PBKDF2.
 *
 * @param password  — plaintext password (UTF-8 string)
 * @param dekSalt   — 32-byte random salt (stored on server as hex)
 * @returns         — AES-256-GCM CryptoKey for wrapping/unwrapping the DEK
 */
export async function deriveMasterKey(
  password: string,
  dekSalt: Uint8Array
): Promise<CryptoKey> {
  // Import password as raw key material for PBKDF2
  const passwordKey = await crypto.subtle.importKey(
    'raw',
    encode(password),
    'PBKDF2',
    false,
    ['deriveKey']
  );

  // Derive AES-256-GCM key via PBKDF2
  // 600,000 iterations is the OWASP 2023 minimum for PBKDF2-SHA-256.
  return crypto.subtle.deriveKey(
    {
      name: 'PBKDF2',
      salt: dekSalt,
      iterations: 600_000,
      hash: 'SHA-256',
    },
    passwordKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

// ---------------------------------------------------------------------------
// DEK (Data Encryption Key) generation, wrapping, unwrapping
// ---------------------------------------------------------------------------

/**
 * Generate a new random DEK (Data Encryption Key).
 * Called once during user registration. The DEK is wrapped with the Master Key
 * and stored on the server; it never leaves the client in plaintext.
 *
 * @returns { dek, dekRaw } — CryptoKey for use + raw bytes for wrapping
 */
export async function generateDek(): Promise<{ dek: CryptoKey; dekRaw: Uint8Array }> {
  const dekRaw = randomBytes(32); // 256-bit random key
  const dek = await importAesKey(dekRaw, ['encrypt', 'decrypt']);
  return { dek, dekRaw };
}

/**
 * Wrap (encrypt) the DEK with the Master Key.
 * The result is the `encrypted_dek` value stored on the server.
 *
 * @param dekRaw      — 32 raw DEK bytes
 * @param masterKey   — CryptoKey derived from password via deriveMasterKey()
 * @returns           — JSON string { iv: base64, ct: base64 }
 */
export async function wrapDek(dekRaw: Uint8Array, masterKey: CryptoKey): Promise<string> {
  const iv = randomBytes(12); // 96-bit IV for AES-GCM
  const ct = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    masterKey,
    dekRaw
  );
  return JSON.stringify({
    iv: toBase64(iv),
    ct: toBase64(new Uint8Array(ct)),
  });
}

/**
 * Unwrap (decrypt) the DEK using the Master Key.
 * Called after a successful login to load the DEK into memory.
 *
 * @param encryptedDek  — JSON string { iv: base64, ct: base64 } from server
 * @param masterKey     — CryptoKey derived from password via deriveMasterKey()
 * @returns             — CryptoKey for encrypting/decrypting notes
 * @throws              — if password is wrong (decryption will fail)
 */
export async function unwrapDek(encryptedDek: string, masterKey: CryptoKey): Promise<CryptoKey> {
  const { iv, ct } = JSON.parse(encryptedDek) as { iv: string; ct: string };
  const dekRaw = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: fromBase64(iv) },
    masterKey,
    fromBase64(ct)
  );
  return importAesKey(new Uint8Array(dekRaw), ['encrypt', 'decrypt']);
}

/**
 * Export the DEK as raw bytes. Used for SRP session key re-derivation.
 * The key is non-extractable in normal use; this is only for key migration.
 * (Not exposed in the main API — reserved for future use.)
 */
// We intentionally do NOT export dekRaw from CryptoKey — non-extractable is
// the correct setting. Raw bytes are only used at wrap time in generateDek().
