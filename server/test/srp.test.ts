/**
 * Unit tests: server SRP math (src/crypto/srp.ts) against the REAL client
 * implementation (bedroc/src/lib/crypto/srp.ts), plus client AES-GCM AAD.
 *
 * Run: npm test   (from server/, needs the bedroc/ sibling directory)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as server from '../src/crypto/srp.js';
import * as client from '../../bedroc/src/lib/crypto/srp.js';
import { encryptField, decryptField, encryptNote, decryptNote, noteFieldContext } from '../../bedroc/src/lib/crypto/encrypt.js';

const hexToBuf = (h: string) => Buffer.from(h.length % 2 ? '0' + h : h, 'hex');

/** Full login round-trip; returns whether server accepted and client verified M2. */
async function roundTrip(opts: {
  username: string; password: string; loginPassword?: string;
  kdf: client.SrpKdfVersion; ephemeral?: { a: bigint; A: string };
}): Promise<{ serverOk: boolean; clientOk: boolean }> {
  const reg = await client.srpRegister(opts.username, opts.password, opts.kdf);
  const verifier = hexToBuf(reg.verifier);
  const salt = hexToBuf(reg.salt);

  const { b, B } = server.serverEphemeral(verifier);
  const { a, A } = opts.ephemeral ?? client.srpClientEphemeral();
  const { M1, sessionKey } = await client.srpClientProof({
    username: opts.username, password: opts.loginPassword ?? opts.password,
    saltHex: reg.salt, AHex: A, BHex: server.encodeB(B), a, kdfVersion: opts.kdf,
  });

  const res = server.verifyProof({
    username: opts.username, salt, A: BigInt('0x' + A), b, verifier, clientM1: Buffer.from(M1, 'hex'),
  });
  if (!res.valid) return { serverOk: false, clientOk: false };
  try {
    await client.srpVerifyServer(A, M1, sessionKey, res.M2.toString('hex'));
    return { serverOk: true, clientOk: true };
  } catch {
    return { serverOk: true, clientOk: false };
  }
}

test('v2 (PBKDF2) login round-trip succeeds and M2 verifies', async () => {
  assert.deepEqual(await roundTrip({ username: 'alice', password: 'correct horse', kdf: 2 }), { serverOk: true, clientOk: true });
});

test('v1 (legacy) login round-trip still works', async () => {
  assert.deepEqual(await roundTrip({ username: 'bob', password: 'hunter22', kdf: 1 }), { serverOk: true, clientOk: true });
});

test('wrong password is rejected', async () => {
  const r = await roundTrip({ username: 'alice', password: 'right', loginPassword: 'wrong', kdf: 2 });
  assert.equal(r.serverOk, false);
});

test('v1 and v2 derive different verifiers (KDF actually changes x)', async () => {
  // Same salt is impossible via the public API (random), so compare by
  // cross-version login failure instead.
  const reg = await client.srpRegister('eve', 'pw', 1);
  const { b, B } = server.serverEphemeral(hexToBuf(reg.verifier));
  const { a, A } = client.srpClientEphemeral();
  const { M1 } = await client.srpClientProof({
    username: 'eve', password: 'pw', saltHex: reg.salt, AHex: A, BHex: server.encodeB(B), a, kdfVersion: 2,
  });
  const res = server.verifyProof({
    username: 'eve', salt: hexToBuf(reg.salt), A: BigInt('0x' + A), b,
    verifier: hexToBuf(reg.verifier), clientM1: Buffer.from(M1, 'hex'),
  });
  assert.equal(res.valid, false);
});

test('finding 9 regression: A with a leading zero byte still verifies M2', async () => {
  // Search for an ephemeral whose A has a zero high byte (~1 in 256).
  let eph: { a: bigint; A: string } | null = null;
  for (let i = 0; i < 5000 && !eph; i++) {
    const e = client.srpClientEphemeral();
    if (e.A.startsWith('00')) eph = e;
  }
  assert.ok(eph, 'could not find an A with a leading zero byte');
  const r = await roundTrip({ username: 'zed', password: 'pw-zero', kdf: 1, ephemeral: eph! });
  assert.deepEqual(r, { serverOk: true, clientOk: true });
});

test('server rejects degenerate A values (0, N, 2N-ish, >= N)', () => {
  const v = server.bigintToBuffer(server.modpow(server.g, 12345n, server.N));
  const { b } = server.serverEphemeral(v);
  const M1 = Buffer.alloc(32);
  for (const A of [0n, server.N, server.N + 1n, server.N * 2n]) {
    assert.equal(server.verifyProof({ username: 'x', salt: Buffer.alloc(32), A, b, verifier: v, clientM1: M1 }).valid, false);
  }
});

test('verifier validation rejects 0, 1, N and oversize', () => {
  assert.equal(server.isValidVerifier(Buffer.from([0])), false);
  assert.equal(server.isValidVerifier(Buffer.from([1])), false);
  assert.equal(server.isValidVerifier(server.bigintToBuffer(server.N)), false);
  assert.equal(server.isValidVerifier(Buffer.alloc(385, 1)), false);
  assert.equal(server.isValidVerifier(Buffer.from([2])), true);
});

test('fake salt is deterministic per username and differs across usernames', () => {
  const s1 = server.fakeSalt('secret', 'nobody');
  assert.deepEqual(server.fakeSalt('secret', 'nobody'), s1);
  assert.notDeepEqual(server.fakeSalt('secret', 'somebody'), s1);
  assert.equal(s1.length, 32);
});

test('B is always encoded padded to 384 bytes', () => {
  for (let i = 0; i < 20; i++) {
    assert.equal(server.encodeB(server.fakeServerEphemeral().B).length, 768);
  }
});

test('client rejects a tampered M2', async () => {
  const { a, A } = client.srpClientEphemeral();
  void a;
  await assert.rejects(client.srpVerifyServer(A, '00'.repeat(32), new Uint8Array(32), 'ff'.repeat(32)));
  await assert.rejects(client.srpVerifyServer(A, '00'.repeat(32), new Uint8Array(32), 'not-hex'));
});

// ---------------------------------------------------------------------------
// AES-GCM context binding (AAD)
// ---------------------------------------------------------------------------

async function newDek(): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', crypto.getRandomValues(new Uint8Array(32)), { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

test('note fields round-trip with AAD', async () => {
  const dek = await newDek();
  const enc = await encryptNote('note-1', 'Title', '<p>Body</p>', dek);
  assert.deepEqual(await decryptNote('note-1', enc.encryptedTitle, enc.encryptedBody, dek), { title: 'Title', body: '<p>Body</p>' });
  assert.equal(JSON.parse(enc.encryptedTitle).v, 2);
});

test('swapping ciphertexts between notes or fields fails', async () => {
  const dek = await newDek();
  const a = await encryptNote('note-a', 'A title', 'A body', dek);
  const b = await encryptNote('note-b', 'B title', 'B body', dek);
  // body of B served as body of A
  await assert.rejects(decryptNote('note-a', a.encryptedTitle, b.encryptedBody, dek));
  // title served as body
  await assert.rejects(decryptNote('note-a', a.encryptedTitle, a.encryptedTitle, dek));
});

test('legacy (no-AAD) ciphertext still decrypts', async () => {
  const dek = await newDek();
  const legacy = await encryptField('old note', dek);
  assert.equal(legacy.v, undefined);
  assert.equal(await decryptField(legacy, dek, noteFieldContext('x', 'body')), 'old note');
});

test('stripping the version marker from a v2 field does not bypass AAD', async () => {
  const dek = await newDek();
  const f = await encryptField('secret', dek, noteFieldContext('n', 'body'));
  const stripped = { iv: f.iv, ct: f.ct };
  await assert.rejects(decryptField(stripped, dek, noteFieldContext('n', 'body')));
});
