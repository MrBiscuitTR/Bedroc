/**
 * crypto/srp.ts — Server-side SRP-6a math (RFC 5054 / RFC 2945, SHA-256, 3072-bit group).
 *
 * Pure functions only (no I/O) so they can be unit-tested against the client
 * implementation in bedroc/src/lib/crypto/srp.ts.
 *
 * PAD() rule: every group element that goes into a hash is left-padded to
 * len(N) = 384 bytes. This includes A in M2 — a mismatch there makes ~1/256
 * logins fail with a spurious "server proof" error on the client.
 */

import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

const N_HEX =
  'FFFFFFFFFFFFFFFFC90FDAA22168C234C4C6628B80DC1CD1' +
  '29024E088A67CC74020BBEA63B139B22514A08798E3404DD' +
  'EF9519B3CD3A431B302B0A6DF25F14374FE1356D6D51C245' +
  'E485B576625E7EC6F44C42E9A637ED6B0BFF5CB6F406B7ED' +
  'EE386BFB5A899FA5AE9F24117C4B1FE649286651ECE45B3D' +
  'C2007CB8A163BF0598DA48361C55D39A69163FA8FD24CF5F' +
  '83655D23DCA3AD961C62F356208552BB9ED529077096966D' +
  '670C354E4ABC9804F1746C08CA18217C32905E462E36CE3B' +
  'E39E772C180E86039B2783A2EC07A28FB5C55DF06F4C52C9' +
  'DE2BCBF6955817183995497CEA956AE515D2261898FA0510' +
  '15728E5A8AAAC42DAD33170D04507A33A85521ABDF1CBA64' +
  'ECFB850458DBEF0A8AEA71575D060C7DB3970F85A6E1E4C7' +
  'ABF5AE8CDB0933D71E8C94E04A25619DCEE3D2261AD2EE6B' +
  'F12FFA06D98A0864D87602733EC86A64521F2B18177B200C' +
  'BBE117577A615D6C770988C0BAD946E208E24FA074E5AB31' +
  '43DB5BFCE0FD108E4B82D120A93AD2CAFFFFFFFFFFFFFFFF';

export const N = BigInt('0x' + N_HEX);
export const g = 2n;
/** Byte length of N (384 for the 3072-bit group). */
export const N_LEN = N_HEX.length / 2;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function sha256(data: Buffer | string): Buffer {
  return createHash('sha256').update(data).digest();
}

export function bigintToBuffer(n: bigint, len?: number): Buffer {
  let hex = n.toString(16);
  if (hex.length % 2 !== 0) hex = '0' + hex;
  const buf = Buffer.from(hex, 'hex');
  if (len && buf.length < len) {
    const padded = Buffer.alloc(len);
    buf.copy(padded, len - buf.length);
    return padded;
  }
  return buf;
}

export function bufferToBigint(buf: Buffer): bigint {
  if (buf.length === 0) return 0n;
  return BigInt('0x' + buf.toString('hex'));
}

export function modpow(base: bigint, exp: bigint, mod: bigint): bigint {
  let result = 1n;
  base = base % mod;
  while (exp > 0n) {
    if (exp & 1n) result = (result * base) % mod;
    exp >>= 1n;
    base = (base * base) % mod;
  }
  return result;
}

/** Constant-time buffer equality (length mismatch returns false). */
export function safeEqual(a: Buffer, b: Buffer): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

const pad = (n: bigint): Buffer => bigintToBuffer(n, N_LEN);

/** k = H(N | PAD(g)) */
export const k = bufferToBigint(sha256(Buffer.concat([pad(N), pad(g)])));

// H(N) xor H(PAD(g)) — constant, precomputed
const HNxorHg = (() => {
  const HN = sha256(pad(N));
  const Hg = sha256(pad(g));
  const out = Buffer.alloc(32);
  for (let i = 0; i < 32; i++) out[i] = HN[i] ^ Hg[i];
  return out;
})();

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/** A verifier must be a group element in [2, N-1]. */
export function isValidVerifier(v: Buffer): boolean {
  if (v.length === 0 || v.length > N_LEN) return false;
  const n = bufferToBigint(v);
  return n > 1n && n < N;
}

// ---------------------------------------------------------------------------
// Protocol
// ---------------------------------------------------------------------------

/** Server ephemeral: b random (256-bit), B = (k*v + g^b) mod N. */
export function serverEphemeral(verifier: Buffer): { b: bigint; B: bigint } {
  const v = bufferToBigint(verifier);
  for (;;) {
    const b = bufferToBigint(randomBytes(32));
    const B = ((k * v) % N + modpow(g, b, N)) % N;
    if (B % N !== 0n) return { b, B };
  }
}

/** Recompute B from a stored b and the verifier. */
export function recomputeB(b: bigint, verifier: Buffer): bigint {
  const v = bufferToBigint(verifier);
  return ((k * v) % N + modpow(g, b, N)) % N;
}

/**
 * A fake-but-plausible B for unknown usernames. Computed with the same cost
 * (one modexp) as a real B so response timing does not reveal existence.
 */
export function fakeServerEphemeral(): { b: bigint; B: bigint } {
  const b = bufferToBigint(randomBytes(32));
  const B = modpow(g, b, N);
  return { b, B };
}

/** Deterministic fake salt per username, so repeated probes return the same value. */
export function fakeSalt(secret: string, usernameKey: string): Buffer {
  return createHmac('sha256', secret).update('bedroc-fake-salt:' + usernameKey).digest();
}

export function encodeB(B: bigint): string {
  return pad(B).toString('hex');
}

export type ProofResult =
  | { valid: true; M2: Buffer; K: Buffer }
  | { valid: false };

/**
 * Verify the client proof M1 and compute the server proof M2.
 *
 *   u  = H(PAD(A) | PAD(B))            — abort if u == 0
 *   S  = (A * v^u) ^ b mod N
 *   K  = H(PAD(S))
 *   M1 = H(H(N) xor H(g) | H(I) | s | PAD(A) | PAD(B) | K)
 *   M2 = H(PAD(A) | M1 | K)
 */
export function verifyProof(params: {
  username: string;
  salt: Buffer;
  A: bigint;
  b: bigint;
  verifier: Buffer;
  clientM1: Buffer;
}): ProofResult {
  const { username, salt, A, b, verifier, clientM1 } = params;
  if (A <= 0n || A % N === 0n || A >= N) return { valid: false };
  if (clientM1.length !== 32) return { valid: false };

  const v = bufferToBigint(verifier);
  const B = recomputeB(b, verifier);
  const APad = pad(A);
  const BPad = pad(B);

  const u = bufferToBigint(sha256(Buffer.concat([APad, BPad])));
  if (u === 0n) return { valid: false };

  const S = modpow((A * modpow(v, u, N)) % N, b, N);
  const K = sha256(pad(S));

  const Husername = sha256(Buffer.from(username, 'utf8'));
  const expectedM1 = sha256(Buffer.concat([HNxorHg, Husername, salt, APad, BPad, K]));

  if (!safeEqual(expectedM1, clientM1)) return { valid: false };

  const M2 = sha256(Buffer.concat([APad, clientM1, K]));
  return { valid: true, M2, K };
}

/** Burn roughly the same CPU as verifyProof (used for unknown-user challenges). */
export function dummyProofWork(b: bigint): void {
  modpow(g, b, N);
  modpow(g, b, N);
}
