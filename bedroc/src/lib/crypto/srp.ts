/**
 * lib/crypto/srp.ts — SRP-6a client implementation.
 *
 * Secure Remote Password (RFC 2945 / SRP-6a) lets the client prove knowledge
 * of the password without ever sending it to the server. The server stores
 * only a verifier derived from the password, making server compromise useless
 * for recovering plaintext passwords.
 *
 * This implementation uses the same 3072-bit MODP group (RFC 3526) as the
 * server. All BigInt math is pure browser JS — no external libraries.
 *
 * Registration flow:
 *   1. Client generates salt (random 32 bytes)
 *   2. x  = H(salt | H(username | ':' | password))
 *   3. v  = g^x mod N  ← sent to server along with username and salt
 *   4. Server stores (username, salt, verifier=v)
 *
 * Login flow:
 *   1. Client → Server: username
 *   2. Server → Client: salt, B (server ephemeral public key)
 *   3. Client computes:
 *      a  = random 256-bit integer
 *      A  = g^a mod N
 *      u  = H(PAD(A) | PAD(B))
 *      x  = H(salt | H(username | ':' | password))
 *      S  = (B - k*g^x)^(a + u*x) mod N
 *      K  = H(S)               (session key)
 *      M1 = H(H(N) XOR H(g) | H(username) | salt | A | B | K)
 *   4. Client → Server: A, M1
 *   5. Server verifies M1; if valid, responds with M2 = H(A | M1 | K)
 *   6. Client verifies M2 (proves server also knows the password)
 */

import { toBase64, fromBase64, toHex, fromHex, randomBytes } from './keys.js';

// ---------------------------------------------------------------------------
// 3072-bit MODP group (RFC 3526, Section 2)
// Same prime used on the server — must match exactly.
// ---------------------------------------------------------------------------
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

const N = BigInt('0x' + N_HEX);
const g = 2n;
const PAD_LEN = N_HEX.length / 2; // byte length of N for left-padding

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** SHA-256 hash of arbitrary bytes. Returns raw Uint8Array. */
async function sha256(data: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', data));
}

/** Concat any number of Uint8Arrays into one. */
function concat(...arrays: Uint8Array[]): Uint8Array {
  const total = arrays.reduce((n, a) => n + a.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const a of arrays) {
    out.set(a, offset);
    offset += a.length;
  }
  return out;
}

/** Left-pad a BigInt's byte representation to PAD_LEN bytes. */
function pad(n: bigint): Uint8Array {
  const hex = n.toString(16).padStart(PAD_LEN * 2, '0');
  return fromHex(hex);
}

/** Fast modular exponentiation: base^exp mod mod. */
function modpow(base: bigint, exp: bigint, mod: bigint): bigint {
  let result = 1n;
  base = base % mod;
  while (exp > 0n) {
    if (exp % 2n === 1n) result = (result * base) % mod;
    exp = exp >> 1n;
    base = (base * base) % mod;
  }
  return result;
}

/** Compute the SRP multiplier k = H(N | PAD(g)). */
async function srpK(): Promise<bigint> {
  const h = await sha256(concat(pad(N), pad(g)));
  return BigInt('0x' + toHex(h));
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

/**
 * Generate SRP registration material for a new account.
 *
 * @param username  — plaintext username
 * @param password  — plaintext password (never sent to server)
 * @returns {
 *   salt       — hex-encoded 32-byte random salt (send to server)
 *   verifier   — hex-encoded SRP verifier v = g^x mod N (send to server)
 * }
 */
export async function srpRegister(
  username: string,
  password: string
): Promise<{ salt: string; verifier: string }> {
  const saltBytes = randomBytes(32);
  const salt = toHex(saltBytes);

  // x = H(salt | H(username:password))
  const identityHash = await sha256(new TextEncoder().encode(`${username}:${password}`));
  const x = BigInt(
    '0x' +
      toHex(await sha256(concat(saltBytes, identityHash)))
  );

  // v = g^x mod N
  const v = modpow(g, x, N);
  const verifier = toHex(pad(v));

  return { salt, verifier };
}

// ---------------------------------------------------------------------------
// Login
// ---------------------------------------------------------------------------

/**
 * Compute the client's ephemeral public key A = g^a mod N.
 * Called at the start of login; A is sent to the server.
 *
 * @returns { a (private, keep secret), A (public, send to server as hex) }
 */
export function srpClientEphemeral(): { a: bigint; A: string } {
  // 256 bits of entropy for the private ephemeral
  const aBytes = randomBytes(32);
  const a = BigInt('0x' + toHex(aBytes));
  const A = modpow(g, a, N);
  return { a, A: toHex(pad(A)) };
}

/**
 * Compute client proof M1 and the session key K.
 *
 * Called after receiving (salt, B) from the server.
 *
 * @param username  — plaintext username
 * @param password  — plaintext password
 * @param saltHex   — hex-encoded salt from server
 * @param AHex      — hex-encoded client public key (from srpClientEphemeral)
 * @param BHex      — hex-encoded server public key from server
 * @param a         — private client ephemeral BigInt (from srpClientEphemeral)
 * @returns {
 *   M1        — hex-encoded client proof (send to server)
 *   sessionKey — Uint8Array — shared session key K (for optional use)
 * }
 * @throws if B is zero mod N (abort: invalid server value)
 */
export async function srpClientProof(params: {
  username: string;
  password: string;
  saltHex: string;
  AHex: string;
  BHex: string;
  a: bigint;
}): Promise<{ M1: string; sessionKey: Uint8Array }> {
  const { username, password, saltHex, AHex, BHex, a } = params;

  const saltBytes = fromHex(saltHex);
  const A = BigInt('0x' + AHex);
  const B = BigInt('0x' + BHex);

  // Validate B != 0 mod N (SRP abort condition)
  if (B % N === 0n) throw new Error('SRP: invalid server public key B');

  const k = await srpK();

  // u = H(PAD(A) | PAD(B))
  const u = BigInt('0x' + toHex(await sha256(concat(pad(A), pad(B)))));
  if (u === 0n) throw new Error('SRP: u = 0, aborting');

  // x = H(salt | H(username:password))
  const identityHash = await sha256(new TextEncoder().encode(`${username}:${password}`));
  const xHash = await sha256(concat(saltBytes, identityHash));
  const x = BigInt('0x' + toHex(xHash));

  // Client session premaster: S = (B - k*g^x)^(a + u*x) mod N
  const kgx = (k * modpow(g, x, N)) % N;
  // Ensure positive: add N if negative
  const base = ((B - kgx) % N + N) % N;
  const exp = (a + u * x) % (N - 1n); // a + u*x mod (N-1) per SRP-6a
  const S = modpow(base, exp, N);

  // Session key K = H(S)
  const sessionKey = await sha256(pad(S));

  // M1 = H( H(N) XOR H(g) | H(username) | salt | A | B | K )
  const HN = await sha256(pad(N));
  const Hg = await sha256(pad(g));
  const HNxorHg = HN.map((b, i) => b ^ Hg[i]);
  const Husername = await sha256(new TextEncoder().encode(username));

  const M1 = await sha256(
    concat(HNxorHg, Husername, saltBytes, pad(A), pad(B), sessionKey)
  );

  return { M1: toHex(M1), sessionKey };
}

/**
 * Verify the server's proof M2.
 * If this fails, the server does not know the correct password.
 *
 * @param AHex        — hex client public key
 * @param M1Hex       — hex client proof (same M1 sent to server)
 * @param sessionKey  — Uint8Array session key K
 * @param serverM2    — hex M2 received from server
 * @throws if server M2 does not match expected
 */
export async function srpVerifyServer(
  AHex: string,
  M1Hex: string,
  sessionKey: Uint8Array,
  serverM2: string
): Promise<void> {
  const A = fromHex(AHex);
  const M1 = fromHex(M1Hex);

  // Expected M2 = H(A | M1 | K)
  const expectedM2 = await sha256(concat(A, M1, sessionKey));
  const expectedHex = toHex(expectedM2);

  if (expectedHex !== serverM2) {
    throw new Error('SRP: server proof verification failed — possible MITM or wrong password');
  }
}
