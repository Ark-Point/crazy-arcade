'use strict';

// G002(S2) 세션 + OAuth 위임 단위/통합 테스트(네트워크 없음).
// - session: 서명/검증 라운드트립, 변조/만료/잘못된 서명 거부.
// - secret: production 미설정 throw, 비프로덕션 랜덤 동작.
// - state nonce: 생성/검증, 불일치/만료 거부.
// - oauth: express 라우터를 임의 포트로 띄우고 builtin fetch(redirect:'manual')로 구동,
//          fetchImpl 로 stub provider 토큰/유저 응답을 모킹해 전체 흐름 검증.

const { test } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const express = require('express');

const session = require('../server/auth/session');
const { createOAuthRouter, buildDefaultProviders } = require('../server/auth/oauth');
const { createStore } = require('../server/auth/store');

const SECRET = 'test-secret-0123456789';

// ---------- session: 토큰 라운드트립 ----------

test('session: sign/verify 라운드트립', () => {
  const token = session.createSessionToken({ id: 'acc_1', provider: 'stub' }, SECRET, 60);
  const payload = session.verifySessionToken(token, SECRET);
  assert.ok(payload);
  assert.strictEqual(payload.id, 'acc_1');
  assert.strictEqual(payload.provider, 'stub');
  assert.strictEqual(typeof payload.exp, 'number');
});

test('session: 변조된 토큰은 null', () => {
  const token = session.createSessionToken({ id: 'acc_1' }, SECRET, 60);
  const [seg, sig] = token.split('.');
  const tampered = `${Buffer.from(JSON.stringify({ id: 'attacker', exp: 9999999999 })).toString('base64url')}.${sig}`;
  assert.strictEqual(session.verifySessionToken(tampered, SECRET), null);
  // 서명 세그먼트 변조도 거부.
  const flipped = `${seg}.${sig.slice(0, -1)}${sig.slice(-1) === 'A' ? 'B' : 'A'}`;
  assert.strictEqual(session.verifySessionToken(flipped, SECRET), null);
});

test('session: 만료된 토큰은 null', () => {
  const token = session.createSessionToken({ id: 'acc_1' }, SECRET, -1);
  assert.strictEqual(session.verifySessionToken(token, SECRET), null);
});

test('session: 잘못된 서명(다른 시크릿)은 null', () => {
  const token = session.createSessionToken({ id: 'acc_1' }, SECRET, 60);
  assert.strictEqual(session.verifySessionToken(token, 'other-secret'), null);
});

test('session: 형식이 깨진 토큰은 null', () => {
  assert.strictEqual(session.verifySessionToken('', SECRET), null);
  assert.strictEqual(session.verifySessionToken('nodot', SECRET), null);
  assert.strictEqual(session.verifySessionToken('.sig', SECRET), null);
  assert.strictEqual(session.verifySessionToken('seg.', SECRET), null);
});

// ---------- secret 해석 ----------

test('secret: production 미설정이면 throw', () => {
  const env = { NODE_ENV: 'production' };
  assert.throws(() => session.resolveSessionSecret(env), /SESSION_SECRET이 필요합니다/);
});

test('secret: production 이어도 env 설정 시 그대로 사용', () => {
  const env = { NODE_ENV: 'production', SESSION_SECRET: 'prod-secret' };
  assert.strictEqual(session.resolveSessionSecret(env), 'prod-secret');
});

test('secret: 비프로덕션 미설정이면 랜덤 시크릿 생성', () => {
  const env = { NODE_ENV: 'test' };
  const s1 = session.resolveSessionSecret(env);
  const s2 = session.resolveSessionSecret(env);
  assert.strictEqual(typeof s1, 'string');
  assert.ok(s1.length >= 32);
  assert.notStrictEqual(s1, s2); // 매 호출 랜덤
});

// ---------- state nonce ----------

test('state: 생성/검증 라운드트립', () => {
  const token = session.createStateToken('nonce-abc', SECRET, 60);
  const payload = session.verifyStateToken(token, SECRET);
  assert.ok(payload);
  assert.strictEqual(payload.nonce, 'nonce-abc');
});

test('state: 잘못된 서명/만료 거부', () => {
  assert.strictEqual(session.verifyStateToken(session.createStateToken('n', SECRET, 60), 'bad'), null);
  assert.strictEqual(session.verifyStateToken(session.createStateToken('n', SECRET, -1), SECRET), null);
});

// ---------- 쿠키 헬퍼 ----------

test('cookie: serialize/read 라운드트립', () => {
  const c = session.serializeCookie('byo_sess', 'v1', { httpOnly: true, sameSite: 'Lax', secure: true, maxAge: 100 });
  assert.match(c, /byo_sess=v1/);
  assert.match(c, /HttpOnly/);
  assert.match(c, /SameSite=Lax/);
  assert.match(c, /Secure/);
  assert.match(c, /Max-Age=100/);
  const req = { headers: { cookie: 'a=1; byo_sess=v1; b=2' } };
  assert.strictEqual(session.readCookie(req, 'byo_sess'), 'v1');
  assert.strictEqual(session.readCookie(req, 'missing'), null);
});

test('requireSession: 유효 세션 통과 / 무효 401', () => {
  const mw = session.requireSession(SECRET);
  const token = session.createSessionToken({ id: 'acc_9' }, SECRET, 60);
  // 통과
  let nexted = false;
  const reqOk = { headers: { cookie: `byo_sess=${token}` } };
  mw(reqOk, fakeRes(), () => { nexted = true; });
  assert.strictEqual(nexted, true);
  assert.strictEqual(reqOk.account.id, 'acc_9');
  // 401
  const res = fakeRes();
  let nexted2 = false;
  mw({ headers: {} }, res, () => { nexted2 = true; });
  assert.strictEqual(nexted2, false);
  assert.strictEqual(res._status, 401);
  assert.deepStrictEqual(res._json, { ok: false, error: '인증이 필요합니다' });
});

function fakeRes() {
  return {
    _status: 200,
    _json: null,
    status(code) { this._status = code; return this; },
    json(obj) { this._json = obj; return this; },
  };
}

// ---------- oauth 통합 ----------

// stub provider — 토큰/유저 엔드포인트와 fetchImpl 모킹.
function makeStubProvider() {
  return {
    stub: {
      authorizeUrl: 'https://stub.example/authorize',
      tokenUrl: 'https://stub.example/token',
      userUrl: 'https://stub.example/user',
      clientId: 'stub-client',
      clientSecret: 'stub-secret',
      scope: 'identify',
      parseUser: (json) => ({ subject: String(json.id) }),
    },
  };
}

// 토큰/유저 응답을 흉내내는 fetchImpl. 호출 인자를 기록한다.
function makeStubFetch(calls) {
  return async function fetchImpl(url, opts) {
    calls.push({ url: String(url), opts });
    if (String(url) === 'https://stub.example/token') {
      return jsonResponse(200, { access_token: 'tok_123', token_type: 'bearer' });
    }
    if (String(url) === 'https://stub.example/user') {
      return jsonResponse(200, { id: 4242, login: 'stubby' });
    }
    return jsonResponse(404, { error: 'not found' });
  };
}

function jsonResponse(status, obj) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() { return obj; },
  };
}

async function startApp(router) {
  const app = express();
  app.use(router);
  // 콜백 리다이렉트 목적지 '/' 가 200 을 주도록 핸들러 추가.
  app.get('/', (req, res) => res.status(200).send('home'));
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return { server, base: `http://127.0.0.1:${port}` };
}

function parseSetCookies(res) {
  const raw = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
  const map = {};
  for (const line of raw) {
    const first = line.split(';')[0];
    const idx = first.indexOf('=');
    map[first.slice(0, idx)] = { value: first.slice(idx + 1), raw: line };
  }
  return map;
}

test('oauth: /auth/stub 은 302 + state 쿠키', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'byo-oauth-'));
  const store = createStore(path.join(dir, 'store.json'));
  const router = createOAuthRouter({
    store,
    secret: SECRET,
    providers: makeStubProvider(),
    fetchImpl: makeStubFetch([]),
    callbackBaseUrl: 'http://127.0.0.1:9999',
  });
  const { server, base } = await startApp(router);
  try {
    const res = await fetch(`${base}/auth/stub`, { redirect: 'manual' });
    assert.strictEqual(res.status, 302);
    const loc = res.headers.get('location');
    assert.ok(loc.startsWith('https://stub.example/authorize'));
    const u = new URL(loc);
    assert.strictEqual(u.searchParams.get('client_id'), 'stub-client');
    assert.strictEqual(u.searchParams.get('redirect_uri'), 'http://127.0.0.1:9999/auth/stub/callback');
    assert.strictEqual(u.searchParams.get('scope'), 'identify');
    assert.ok(u.searchParams.get('state'));
    const cookies = parseSetCookies(res);
    assert.ok(cookies.byo_state, 'state 쿠키가 set 되어야 함');
    assert.match(cookies.byo_state.raw, /HttpOnly/);
  } finally {
    server.close();
  }
});

test('oauth: 미지원 provider 는 404', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'byo-oauth-'));
  const store = createStore(path.join(dir, 'store.json'));
  const router = createOAuthRouter({
    store,
    secret: SECRET,
    providers: makeStubProvider(),
    fetchImpl: makeStubFetch([]),
    callbackBaseUrl: 'http://127.0.0.1:9999',
  });
  const { server, base } = await startApp(router);
  try {
    const res = await fetch(`${base}/auth/unknown`, { redirect: 'manual' });
    assert.strictEqual(res.status, 404);
  } finally {
    server.close();
  }
});

test('oauth: 콜백 전체 흐름 — 계정 upsert + 세션 쿠키 + 302', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'byo-oauth-'));
  const storePath = path.join(dir, 'store.json');
  const store = createStore(storePath);
  const calls = [];
  const router = createOAuthRouter({
    store,
    secret: SECRET,
    providers: makeStubProvider(),
    fetchImpl: makeStubFetch(calls),
    callbackBaseUrl: 'http://127.0.0.1:9999',
  });
  const { server, base } = await startApp(router);
  try {
    // 1) 인가요청으로 유효 state 쿠키/nonce 확보.
    const authRes = await fetch(`${base}/auth/stub`, { redirect: 'manual' });
    const nonce = new URL(authRes.headers.get('location')).searchParams.get('state');
    const stateCookie = parseSetCookies(authRes).byo_state.value;

    // 2) 콜백 — 유효 state + code.
    const cbRes = await fetch(`${base}/auth/stub/callback?code=abc&state=${nonce}`, {
      redirect: 'manual',
      headers: { cookie: `byo_state=${stateCookie}` },
    });
    assert.strictEqual(cbRes.status, 302);
    assert.strictEqual(cbRes.headers.get('location'), '/');
    const cookies = parseSetCookies(cbRes);
    assert.ok(cookies.byo_sess, '세션 쿠키 set');
    // 세션 토큰 검증.
    const payload = session.verifySessionToken(cookies.byo_sess.value, SECRET);
    assert.ok(payload);
    assert.strictEqual(payload.provider, 'stub');
    assert.strictEqual(payload.subject, '4242');

    // fetchImpl 호출 확인(토큰 → 유저).
    assert.strictEqual(calls[0].url, 'https://stub.example/token');
    assert.strictEqual(calls[1].url, 'https://stub.example/user');

    // 실제 저장소에 계정 생성 확인.
    const persisted = JSON.parse(fs.readFileSync(storePath, 'utf8'));
    assert.strictEqual(persisted.accounts.length, 1);
    assert.strictEqual(persisted.accounts[0].provider, 'stub');
    assert.strictEqual(persisted.accounts[0].subject, '4242');
  } finally {
    server.close();
  }
});

test('oauth: state 불일치 콜백은 400', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'byo-oauth-'));
  const store = createStore(path.join(dir, 'store.json'));
  const router = createOAuthRouter({
    store,
    secret: SECRET,
    providers: makeStubProvider(),
    fetchImpl: makeStubFetch([]),
    callbackBaseUrl: 'http://127.0.0.1:9999',
  });
  const { server, base } = await startApp(router);
  try {
    const authRes = await fetch(`${base}/auth/stub`, { redirect: 'manual' });
    const stateCookie = parseSetCookies(authRes).byo_state.value;
    // 쿼리 state 가 쿠키 nonce 와 불일치.
    const res = await fetch(`${base}/auth/stub/callback?code=abc&state=WRONG`, {
      redirect: 'manual',
      headers: { cookie: `byo_state=${stateCookie}` },
    });
    assert.strictEqual(res.status, 400);
    // state 쿠키 누락도 400.
    const res2 = await fetch(`${base}/auth/stub/callback?code=abc&state=whatever`, { redirect: 'manual' });
    assert.strictEqual(res2.status, 400);
  } finally {
    server.close();
  }
});

test('oauth: 토큰 교환 실패는 502', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'byo-oauth-'));
  const store = createStore(path.join(dir, 'store.json'));
  const router = createOAuthRouter({
    store,
    secret: SECRET,
    providers: makeStubProvider(),
    fetchImpl: async () => jsonResponse(401, { error: 'bad code' }),
    callbackBaseUrl: 'http://127.0.0.1:9999',
  });
  const { server, base } = await startApp(router);
  try {
    const authRes = await fetch(`${base}/auth/stub`, { redirect: 'manual' });
    const nonce = new URL(authRes.headers.get('location')).searchParams.get('state');
    const stateCookie = parseSetCookies(authRes).byo_state.value;
    const res = await fetch(`${base}/auth/stub/callback?code=abc&state=${nonce}`, {
      redirect: 'manual',
      headers: { cookie: `byo_state=${stateCookie}` },
    });
    assert.strictEqual(res.status, 502);
  } finally {
    server.close();
  }
});

test('oauth: logout 은 세션 쿠키 만료', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'byo-oauth-'));
  const store = createStore(path.join(dir, 'store.json'));
  const router = createOAuthRouter({
    store,
    secret: SECRET,
    providers: makeStubProvider(),
    fetchImpl: makeStubFetch([]),
    callbackBaseUrl: 'http://127.0.0.1:9999',
  });
  const { server, base } = await startApp(router);
  try {
    const res = await fetch(`${base}/auth/logout`, { method: 'POST', redirect: 'manual' });
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.deepStrictEqual(body, { ok: true });
    const cookies = parseSetCookies(res);
    assert.ok(cookies.byo_sess);
    assert.match(cookies.byo_sess.raw, /Max-Age=0/);
  } finally {
    server.close();
  }
});

test('buildDefaultProviders: env 기반 구성', () => {
  const empty = buildDefaultProviders({});
  assert.deepStrictEqual(Object.keys(empty), []);
  const full = buildDefaultProviders({
    OAUTH_GITHUB_CLIENT_ID: 'gh-id',
    OAUTH_GITHUB_CLIENT_SECRET: 'gh-secret',
    OAUTH_GOOGLE_CLIENT_ID: 'g-id',
    OAUTH_GOOGLE_CLIENT_SECRET: 'g-secret',
  });
  assert.ok(full.github);
  assert.ok(full.google);
  assert.strictEqual(full.github.clientId, 'gh-id');
  assert.strictEqual(full.github.parseUser({ id: 7 }).subject, '7');
  assert.strictEqual(full.google.parseUser({ sub: 'abc' }).subject, 'abc');
});

test('buildDefaultProviders: parseUser 는 누락 식별자를 null 로(문자열화 가드 통과 방지)', () => {
  const p = buildDefaultProviders({
    OAUTH_GITHUB_CLIENT_ID: 'gh-id',
    OAUTH_GITHUB_CLIENT_SECRET: 'gh-secret',
    OAUTH_GOOGLE_CLIENT_ID: 'g-id',
    OAUTH_GOOGLE_CLIENT_SECRET: 'g-secret',
  });
  assert.strictEqual(p.github.parseUser({}).subject, null, 'id 누락 → null');
  assert.strictEqual(p.github.parseUser({ id: null }).subject, null, 'id null → null');
  assert.strictEqual(p.google.parseUser({}).subject, null, 'sub 누락 → null');
  assert.strictEqual(p.google.parseUser({ sub: undefined }).subject, null, 'sub undefined → null');
  // 정상 케이스는 여전히 동작
  assert.strictEqual(p.github.parseUser({ id: 0 }).subject, '0', 'id 0 은 유효(0 != null)');
});
