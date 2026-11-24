/**
 * Integration tests against a live server (see docker-compose.test.yml).
 * Uses the real client SRP implementation to log in.
 *
 * Every request carries a fresh X-Forwarded-For so the per-IP rate limits do
 * not interfere (the server trusts 1 proxy hop, as behind nginx/Caddy). Tests
 * that exercise the per-IP limit pin a single IP explicitly.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { srpRegister, srpClientEphemeral, srpClientProof, srpVerifyServer, type SrpKdfVersion } from '../../bedroc/src/lib/crypto/srp.js';

const BASE = process.env.BASE_URL ?? 'http://localhost:3000';
const ORIGIN = 'https://app.example.com';

let ipCounter = 0;
const freshIp = () => { ipCounter++; return `10.${(ipCounter >> 16) & 255}.${(ipCounter >> 8) & 255}.${ipCounter & 255}`; };

interface ApiOpts { method?: string; body?: unknown; token?: string; cookie?: string; origin?: string | null; ip?: string }
async function api(path: string, o: ApiOpts = {}) {
  const headers: Record<string, string> = { 'x-forwarded-for': o.ip ?? freshIp() };
  if (o.body !== undefined) headers['content-type'] = 'application/json';
  if (o.token) headers.authorization = `Bearer ${o.token}`;
  if (o.cookie) headers.cookie = `bedroc_refresh=${o.cookie}`;
  if (o.origin !== null) headers.origin = o.origin ?? ORIGIN;
  const res = await fetch(BASE + path, {
    method: o.method ?? 'GET', headers,
    body: o.body !== undefined ? JSON.stringify(o.body) : undefined,
  });
  const text = await res.text();
  let json: any; try { json = JSON.parse(text); } catch { json = text; }
  const refresh = res.headers.getSetCookie()
    .map((c) => /^bedroc_refresh=([^;]+)/.exec(c)?.[1]).find(Boolean);
  return { status: res.status, json, headers: res.headers, refresh };
}

const hex = (n: number) => randomBytes(n).toString('hex');
const fakeWrappedDek = () => JSON.stringify({ iv: randomBytes(12).toString('base64'), ct: randomBytes(48).toString('base64') });

async function register(username: string, password: string, kdf: SrpKdfVersion = 2) {
  const reg = await srpRegister(username, password, kdf);
  const res = await api('/api/auth/register', {
    method: 'POST',
    body: {
      username, srpSalt: reg.salt, srpVerifier: reg.verifier,
      encryptedDek: fakeWrappedDek(), dekSalt: hex(32),
      ...(kdf === 2 ? { srpKdfVersion: 2 } : {}),   // v1 = what an old client sends
    },
  });
  return res;
}

async function prove(username: string, password: string, ip?: string) {
  const init = await api('/api/auth/login/init', { method: 'POST', body: { username }, ip });
  if (init.status !== 200) return { init, proof: null as null };
  const { a, A } = srpClientEphemeral();
  const { M1, sessionKey } = await srpClientProof({
    username, password, saltHex: init.json.salt, AHex: A, BHex: init.json.B, a, kdfVersion: init.json.kdf,
  });
  return { init, proof: { challengeId: init.json.challengeId as string, A, M1 }, sessionKey };
}

async function login(username: string, password: string, extra: Record<string, unknown> = {}, ip?: string) {
  const p = await prove(username, password, ip);
  if (!p.proof) return p.init;
  const res = await api('/api/auth/login/verify', { method: 'POST', body: { ...p.proof, username, ...extra }, ip });
  if (res.status === 200) await srpVerifyServer(p.proof.A, p.proof.M1, p.sessionKey!, res.json.M2);
  return res;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const uname = (p: string) => `${p}_${randomBytes(3).toString('hex')}`;

// ---------------------------------------------------------------------------

test('register + login (v2) + M2 verified by client', async () => {
  const u = uname('alice');
  const r = await register(u, 'pw-alice-123');
  assert.equal(r.status, 201);
  assert.ok(r.refresh, 'refresh cookie set on register');
  const l = await login(u, 'pw-alice-123');
  assert.equal(l.status, 200);
  assert.ok(l.json.accessToken);
});

test('register rejects invalid verifier / non-hex material', async () => {
  const base = { username: uname('bad'), srpSalt: hex(32), encryptedDek: fakeWrappedDek(), dekSalt: hex(32) };
  assert.equal((await api('/api/auth/register', { method: 'POST', body: { ...base, srpVerifier: '00' } })).status, 400);
  assert.equal((await api('/api/auth/register', { method: 'POST', body: { ...base, srpVerifier: 'zz'.repeat(10) } })).status, 400);
  assert.equal((await api('/api/auth/register', { method: 'POST', body: { ...base, srpVerifier: 'ab', srpSalt: 'nothex!' } })).status, 400);
});

test('usernames are unique case-insensitively', async () => {
  const u = uname('Case');
  assert.equal((await register(u, 'pw-1234567')).status, 201);
  assert.equal((await register(u.toLowerCase(), 'pw-1234567')).status, 409);
});

test('finding 5: unknown usernames are indistinguishable', async () => {
  const ghost = uname('ghost');
  const a = await api('/api/auth/login/init', { method: 'POST', body: { username: ghost } });
  const b = await api('/api/auth/login/init', { method: 'POST', body: { username: ghost } });
  assert.equal(a.status, 200);
  assert.equal(a.json.salt, b.json.salt, 'fake salt is stable');
  assert.equal(a.json.B.length, 768);
  assert.equal(a.json.kdf, 2);

  // Wrong password for a real user vs any password for a ghost → same response.
  const real = uname('real');
  await register(real, 'right-password');
  const wrong = await login(real, 'wrong-password');
  const none = await login(ghost, 'whatever');
  assert.equal(wrong.status, 401);
  assert.equal(none.status, 401);
  assert.deepEqual(wrong.json, none.json);
});

test('finding 10: concurrent challenges do not clobber each other; challenges are one-time', async () => {
  const u = uname('multi');
  await register(u, 'pw-multi-123');
  const p1 = await prove(u, 'pw-multi-123');
  const p2 = await prove(u, 'pw-multi-123');           // a second device / an attacker spamming init
  const v1 = await api('/api/auth/login/verify', { method: 'POST', body: p1.proof });
  assert.equal(v1.status, 200, 'first challenge still valid');
  const v2 = await api('/api/auth/login/verify', { method: 'POST', body: p2.proof });
  assert.equal(v2.status, 200, 'second challenge also valid');
  const replay = await api('/api/auth/login/verify', { method: 'POST', body: p1.proof });
  assert.equal(replay.status, 401, 'challenge cannot be reused');
});

test('finding 1: foreign origins are refused (refresh cannot be stolen cross-site)', async () => {
  const u = uname('cors');
  const r = await register(u, 'pw-cors-1234');
  const evil = await api('/api/auth/refresh', { method: 'POST', cookie: r.refresh, origin: 'https://evil.example' });
  assert.equal(evil.status, 403);
  assert.equal(evil.json.error, 'origin_not_allowed');
  assert.equal(evil.headers.get('access-control-allow-credentials'), null, 'never grant credentials to a foreign origin');
  assert.equal(evil.refresh, undefined, 'no token rotated');

  const ok = await api('/api/auth/refresh', { method: 'POST', cookie: r.refresh });
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get('access-control-allow-origin'), ORIGIN);
  assert.equal(ok.headers.get('access-control-allow-credentials'), 'true');

  // Desktop app origin (port wildcard for localhost only)
  const desk = await api('/health', { origin: 'http://localhost:49152' });
  assert.equal(desk.status, 200);
  const lanTrick = await api('/health', { origin: 'http://localhost.evil.example:49152' });
  assert.equal(lanTrick.status, 403);
});

test('finding 2: logout really revokes; refresh never resurrects a dead session', async () => {
  const u = uname('logout');
  const r = await register(u, 'pw-logout-12');
  const ref1 = await api('/api/auth/refresh', { method: 'POST', cookie: r.refresh });
  assert.equal(ref1.status, 200);

  // Logout with ONLY the bearer token (what the old client failed to send) …
  assert.equal((await api('/api/auth/logout', { method: 'POST', token: ref1.json.accessToken })).status, 200);
  // … kills both the access token and the refresh token.
  assert.equal((await api('/api/notes', { token: ref1.json.accessToken })).status, 401);
  assert.equal((await api('/api/auth/refresh', { method: 'POST', cookie: ref1.refresh })).status, 401);

  // Logout via the refresh cookie alone also works.
  const l = await login(u, 'pw-logout-12');
  assert.equal((await api('/api/auth/logout', { method: 'POST', cookie: l.refresh })).status, 200);
  assert.equal((await api('/api/auth/refresh', { method: 'POST', cookie: l.refresh })).status, 401);
});

test('finding 2: revoke-all and per-session revoke are enforced on refresh', async () => {
  const u = uname('revoke');
  const r = await register(u, 'pw-revoke-12');
  const other = await login(u, 'pw-revoke-12', {}, undefined);
  assert.equal((await api('/api/auth/sessions/revoke-all', { method: 'POST', token: r.json.accessToken })).status, 200);
  assert.equal((await api('/api/auth/refresh', { method: 'POST', cookie: other.refresh })).status, 401);
  assert.equal((await api('/api/auth/refresh', { method: 'POST', cookie: r.refresh })).status, 401);
});

test('refresh rotation: concurrent replay → 409, late replay → session revoked', async () => {
  const u = uname('rotate');
  const r = await register(u, 'pw-rotate-12');
  const R0 = r.refresh!;
  const first = await api('/api/auth/refresh', { method: 'POST', cookie: R0 });
  assert.equal(first.status, 200);
  const R1 = first.refresh!;

  const race = await api('/api/auth/refresh', { method: 'POST', cookie: R0 });
  assert.equal(race.status, 409, 'replay inside grace window = benign race');

  await sleep(3000); // grace is 2 s in the test stack
  const theft = await api('/api/auth/refresh', { method: 'POST', cookie: R0 });
  assert.equal(theft.status, 401, 'late replay rejected');
  assert.equal((await api('/api/auth/refresh', { method: 'POST', cookie: R1 })).status, 401, 'whole session revoked on reuse');
});

test('access tokens are unique even when minted in the same second', async () => {
  const u = uname('jti');
  const r = await register(u, 'pw-jti-12345');
  const [a, b] = await Promise.all([
    api('/api/auth/refresh', { method: 'POST', cookie: r.refresh }),
    login(u, 'pw-jti-12345'),
  ]);
  assert.ok([200, 409].includes(a.status));
  assert.equal(b.status, 200);
});

test('NEW: cross-user note/topic/folder overwrite is impossible', async () => {
  const alice = await register(uname('owner'), 'pw-owner-123');
  const mallory = await register(uname('mallory'), 'pw-mallory-1');
  const noteId = randomUUID();
  const note = {
    topicId: null, encryptedTitle: '{"iv":"a","ct":"b"}', encryptedBody: '{"iv":"c","ct":"d"}',
    customOrder: 0, clientUpdatedAt: new Date().toISOString(), version: 1,
  };
  assert.equal((await api(`/api/notes/${noteId}`, { method: 'PUT', token: alice.json.accessToken, body: note })).status, 200);

  const attack = await api(`/api/notes/${noteId}`, {
    method: 'PUT', token: mallory.json.accessToken,
    body: { ...note, encryptedBody: '{"iv":"x","ct":"PWNED"}', clientUpdatedAt: '2999-01-01T00:00:00.000Z' },
  });
  assert.equal(attack.status, 409);
  const after = await api(`/api/notes/${noteId}`, { token: alice.json.accessToken });
  assert.equal(after.json.note.encrypted_body, note.encryptedBody, "victim's note untouched");

  const topicId = randomUUID();
  const topic = { name: 'Private plans', color: '#112233', folderId: null, sortOrder: 0 };
  assert.equal((await api(`/api/topics/${topicId}`, { method: 'PUT', token: alice.json.accessToken, body: topic })).status, 200);
  assert.equal((await api(`/api/topics/${topicId}`, { method: 'PUT', token: mallory.json.accessToken, body: { ...topic, name: 'pwned' } })).status, 409);
  const topics = await api('/api/topics', { token: alice.json.accessToken });
  assert.equal(topics.json.topics[0].name, 'Private plans');

  const folderId = randomUUID();
  const folder = { name: 'F', parentId: null, sortOrder: 0, collapsed: false };
  assert.equal((await api(`/api/folders/${folderId}`, { method: 'PUT', token: alice.json.accessToken, body: folder })).status, 200);
  assert.equal((await api(`/api/folders/${folderId}`, { method: 'PUT', token: mallory.json.accessToken, body: { ...folder, name: 'x' } })).status, 409);
});

test('finding 4: change-password requires a proof and evicts other sessions', async () => {
  const u = uname('chpw');
  const r = await register(u, 'old-password-1');
  const otherDevice = await login(u, 'old-password-1');
  const newReg = await srpRegister(u, 'new-password-1', 2);
  const material = { srpSalt: newReg.salt, srpVerifier: newReg.verifier, srpKdfVersion: 2, encryptedDek: fakeWrappedDek(), dekSalt: hex(32) };

  // Access token alone is not enough.
  assert.equal((await api('/api/auth/change-password', { method: 'POST', token: r.json.accessToken, body: material })).status, 400);
  // Wrong current password.
  const bad = await prove(u, 'not-the-password');
  assert.equal((await api('/api/auth/change-password', { method: 'POST', token: r.json.accessToken, body: { ...material, proof: bad.proof } })).status, 403);
  // Proof bound to a different account is refused.
  const v = uname('victim2');
  await register(v, 'victim-pass-1');
  const otherUser = await prove(v, 'victim-pass-1');
  assert.equal((await api('/api/auth/change-password', { method: 'POST', token: r.json.accessToken, body: { ...material, proof: otherUser.proof } })).status, 403);

  const good = await prove(u, 'old-password-1');
  assert.equal((await api('/api/auth/change-password', { method: 'POST', token: r.json.accessToken, body: { ...material, proof: good.proof } })).status, 200);

  assert.equal((await api('/api/notes', { token: otherDevice.json.accessToken })).status, 401, 'other session evicted');
  assert.equal((await api('/api/auth/refresh', { method: 'POST', cookie: otherDevice.refresh })).status, 401);
  assert.equal((await api('/api/notes', { token: r.json.accessToken })).status, 200, 'current session kept');
  assert.equal((await login(u, 'old-password-1')).status, 401);
  assert.equal((await login(u, 'new-password-1')).status, 200);
});

test('account deletion requires a password proof', async () => {
  const u = uname('del');
  const r = await register(u, 'pw-delete-12');
  assert.equal((await api('/api/auth/account', { method: 'DELETE', token: r.json.accessToken, body: {} })).status, 400);
  const good = await prove(u, 'pw-delete-12');
  assert.equal((await api('/api/auth/account', { method: 'DELETE', token: r.json.accessToken, body: { proof: good.proof } })).status, 200);
  assert.equal((await login(u, 'pw-delete-12')).status, 401);
});

test('finding 3: legacy v1 verifier is upgraded to v2 on login', async () => {
  const u = uname('legacy');
  assert.equal((await register(u, 'legacy-pass-1', 1)).status, 201);
  const init = await api('/api/auth/login/init', { method: 'POST', body: { username: u } });
  assert.equal(init.json.kdf, 1);

  const up = await srpRegister(u, 'legacy-pass-1', 2);
  const l = await login(u, 'legacy-pass-1', { upgrade: { srpSalt: up.salt, srpVerifier: up.verifier } });
  assert.equal(l.status, 200);
  assert.equal(l.json.kdfUpgraded, true);

  const init2 = await api('/api/auth/login/init', { method: 'POST', body: { username: u } });
  assert.equal(init2.json.kdf, 2);
  assert.equal((await login(u, 'legacy-pass-1')).status, 200, 'v2 login works after upgrade');

  // An upgrade attached to a FAILED proof must not be applied.
  const v = uname('legacy2');
  await register(v, 'legacy-pass-2', 1);
  const evil = await srpRegister(v, 'attacker-pass', 2);
  assert.equal((await login(v, 'wrong', { upgrade: { srpSalt: evil.salt, srpVerifier: evil.verifier } })).status, 401);
  assert.equal((await api('/api/auth/login/init', { method: 'POST', body: { username: v } })).json.kdf, 1);
});

test('finding 6: per-account lockout works across many IPs', async () => {
  const u = uname('locked');
  await register(u, 'pw-locked-12');
  for (let i = 0; i < 10; i++) {
    const res = await login(u, `guess-${i}`);       // each from a different IP
    assert.equal(res.status, 401);
  }
  const init = await api('/api/auth/login/init', { method: 'POST', body: { username: u } });
  assert.equal(init.status, 429);
  assert.ok(Number(init.headers.get('retry-after')) > 0);
  // Even the right password is refused while locked.
  assert.equal((await login(u, 'pw-locked-12')).status, 429);
});

test('per-IP rate limit still applies to login/verify', async () => {
  const ip = '203.0.113.77';
  let limited = false;
  for (let i = 0; i < 12; i++) {
    const res = await api('/api/auth/login/verify', { method: 'POST', ip, body: { challengeId: randomUUID(), A: 'ab', M1: 'ab'.repeat(32) } });
    if (res.status === 429) { limited = true; break; }
  }
  assert.ok(limited);
});

test('WebSocket: first-message auth, rejection, and legacy query token', async () => {
  const u = uname('ws');
  const r = await register(u, 'pw-ws-123456');
  const wsBase = BASE.replace(/^http/, 'ws') + '/ws';

  const ok = await new Promise<string>((resolve, reject) => {
    const ws = new WebSocket(wsBase);
    ws.onopen = () => ws.send(JSON.stringify({ type: 'auth', token: r.json.accessToken }));
    ws.onmessage = (e) => { resolve(String(e.data)); ws.close(); };
    ws.onerror = () => reject(new Error('ws error'));
    ws.onclose = (e) => reject(new Error(`closed ${e.code} ${e.reason}`));
  });
  assert.equal(JSON.parse(ok).type, 'auth:ok');

  const closeCode = await new Promise<number>((resolve) => {
    const ws = new WebSocket(wsBase);
    ws.onopen = () => ws.send(JSON.stringify({ type: 'auth', token: 'garbage' }));
    ws.onclose = (e) => resolve(e.code);
  });
  assert.equal(closeCode, 4001);

  const noAuth = await new Promise<number>((resolve) => {
    const ws = new WebSocket(wsBase);
    ws.onopen = () => ws.send(JSON.stringify({ type: 'ping' }));
    ws.onclose = (e) => resolve(e.code);
  });
  assert.equal(noAuth, 4001, 'nothing is accepted before auth');

  const legacy = await new Promise<string>((resolve, reject) => {
    const ws = new WebSocket(`${wsBase}?token=${encodeURIComponent(r.json.accessToken)}`);
    ws.onopen = () => ws.send(JSON.stringify({ type: 'ping' }));
    ws.onmessage = (e) => { resolve(String(e.data)); ws.close(); };
    ws.onerror = () => reject(new Error('ws error'));
    ws.onclose = (e) => reject(new Error(`closed ${e.code} ${e.reason}`));
  });
  assert.equal(JSON.parse(legacy).type, 'pong');
});

test('internal errors are not leaked', async () => {
  const r = await register(uname('err'), 'pw-errors-12');
  const res = await api('/api/notes/not-a-uuid', { token: r.json.accessToken });
  assert.equal(res.status, 400);
  assert.ok(!JSON.stringify(res.json).includes('syntax'), 'no SQL error text');
});
