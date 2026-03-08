/**
 * lib/crypto/encrypt.ts — AES-256-GCM note encryption/decryption.
 *
 * Each note field (title, body) is encrypted independently with its own
 * random 96-bit IV. Ciphertexts are stored as JSON:
 *   { iv: "<base64>", ct: "<base64>" }
 *
 * The same DEK (Data Encryption Key) encrypts all notes for a user.
 * The DEK lives in memory only — see keys.ts for derivation details.
 *
 * Why per-field IVs?
 *   - Prevents the same (key, IV) pair from ever being reused.
 *   - AES-GCM is catastrophically broken if (key, IV) is reused.
 *   - Generating a fresh random IV on every encrypt call is the
 *     standard mitigation — 96 bits gives a negligible collision
 *     probability even with billions of notes.
 *
 * Why separate encryption of title vs body?
 *   - Allows the server to return note metadata (title only) in list
 *     views without sending the full body — but since the server is
 *     a dumb blob store, this is mainly for future optionality.
 *   - Also means a title edit doesn't change the body ciphertext,
 *     reducing sync diff size.
 */

import { toBase64, fromBase64, randomBytes } from './keys.js';

/** Wire format stored in the database (and IndexedDB). */
export interface EncryptedField {
  iv: string;  // base64-encoded 12-byte IV
  ct: string;  // base64-encoded AES-GCM ciphertext + 16-byte auth tag
}

/**
 * Encrypt a plaintext string with the given DEK.
 *
 * @param plaintext  — UTF-8 string (note title or body)
 * @param dek        — CryptoKey (AES-256-GCM, from keys.ts)
 * @returns          — EncryptedField JSON-serialisable object
 */
export async function encryptField(
  plaintext: string,
  dek: CryptoKey
): Promise<EncryptedField> {
  const iv = randomBytes(12); // 96-bit IV
  const encoded = new TextEncoder().encode(plaintext);

  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    dek,
    encoded
  );

  return {
    iv: toBase64(iv),
    ct: toBase64(new Uint8Array(ciphertext)),
  };
}

/**
 * Decrypt an EncryptedField with the given DEK.
 *
 * @param field  — { iv, ct } object from database / IndexedDB
 * @param dek    — CryptoKey (AES-256-GCM)
 * @returns      — plaintext UTF-8 string
 * @throws       — if DEK is wrong or ciphertext is tampered (GCM auth fails)
 */
export async function decryptField(
  field: EncryptedField,
  dek: CryptoKey
): Promise<string> {
  const iv = fromBase64(field.iv);
  const ct = fromBase64(field.ct);

  const plaintext = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv },
    dek,
    ct
  );

  return new TextDecoder().decode(plaintext);
}

/**
 * Serialise an EncryptedField to a JSON string for storage.
 * The server stores this string in `encrypted_title` / `encrypted_body`.
 */
export function serialiseField(field: EncryptedField): string {
  return JSON.stringify(field);
}

/**
 * Parse a JSON string back into an EncryptedField.
 * Returns null if the string is empty or malformed (e.g. new note with no content).
 */
export function parseField(json: string): EncryptedField | null {
  if (!json || json === '{}') return null;
  try {
    return JSON.parse(json) as EncryptedField;
  } catch {
    return null;
  }
}

/**
 * Convenience: encrypt title and body together.
 * Returns serialised JSON strings ready to send to the server.
 */
export async function encryptNote(
  title: string,
  body: string,
  dek: CryptoKey
): Promise<{ encryptedTitle: string; encryptedBody: string }> {
  const [titleField, bodyField] = await Promise.all([
    encryptField(title, dek),
    encryptField(body, dek),
  ]);
  return {
    encryptedTitle: serialiseField(titleField),
    encryptedBody: serialiseField(bodyField),
  };
}

/**
 * Convenience: decrypt title and body together.
 * Accepts the raw JSON strings stored on the server.
 * Returns empty strings for fields that are missing or not yet written.
 */
export async function decryptNote(
  encryptedTitle: string,
  encryptedBody: string,
  dek: CryptoKey
): Promise<{ title: string; body: string }> {
  const titleField = parseField(encryptedTitle);
  const bodyField = parseField(encryptedBody);

  const [title, body] = await Promise.all([
    titleField ? decryptField(titleField, dek) : Promise.resolve(''),
    bodyField ? decryptField(bodyField, dek) : Promise.resolve(''),
  ]);

  return { title, body };
}
