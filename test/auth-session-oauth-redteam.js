'use strict';

// G002(S2) 세션 + OAuth 적대(red-team) 테스트 — failure-mode 검증, 네트워크 없음.
// 제품 코드(server/auth/*) 는 수정하지 않는다. 공격자 관점에서 인증 경로를 깨려 시도하고,
// 전부 거부(null/4xx/5xx)됨을 단언한다. fetchImpl/stub provider 주입으로 외부 IO 를 제거한다.
//
// 커버 케이스:
//   (1) 세션 토큰 위조 — payload 교체+서명유지 / 비트플립 / 빈 서명(alg-none 유사) /
//                        공격자 시크릿 서명 / 비-HMAC echo 서명 → 전부 null
//   (2) state nonce — 1회용(쿠키 무효화 후 재사용) / 만료 / 교차세션 nonce → 거부(400)
//   (3) callback code 누락·빈값 / 공격자 redirect_uri 주입(오픈리다이렉트 방어)
//   (4) 토큰교환 200+필수필드 누락 / 손상 JSON / parseUser subject 누락 → 502
//   (5) requireSession 쿠키없음 / 깨진쿠키 / 만료세션 / id없는 payload → 401
//   (6) 쿠키 파싱 엣지 — '=' 포함 값 / 중복 쿠키 / 공백·세미콜론 분리

const { test } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const express = require('express');

const session = require('../server/auth/session');
const { createOAuthRouter } = require('../server/auth/oauth');
const { createStore } = require('../server/auth/store');

const SECRET = 'redteam-secret-0123456789';

// ---------- 공통 헬퍼 ----------

function freshStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'byo-redteam-'));
  return { store: createStore(path.join(dir, 'store.json')), dir };
}

// 토큰/유저 응답을 흉내내는 fetchImpl. behavior 로 응답을 커스터마이즈한다.
function makeFetch(calls, behavior = {}) {
  return async function fetchImpl(url, opts) {
    calls.push({ url: String(url), opts });
    if (String(url) === 'https://stub.example/token') {
      return (behavior.token || (() => jsonResponse(200, { access_token: 'tok_123', token_type: 'bearer' })))();
    }
    if (String(url) === 'https://stub.example/user') {
      return (behavior.user || (() => jsonResponse(200, { id: 4242, login: 'stubby' })))();
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

// json() 이 throw 하는 손상 응답.
function corruptJsonResponse(status) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() { throw new SyntaxError('Unexpected end of JSON input'); },
  };
}

function makeProvider(parseUser) {
  return {
    stub: {
      authorizeUrl: 'https://stub.example/authorize',
      tokenUrl: 'https://stub.example/token',
      userUrl: 'https://stub.example/user',
      clientId: 'stub-client',
      clientSecret: 'stub-secret',
      scope: 'identify',
      parseUser: parseUser || ((json) => ({ subject: json.id != null ? String(json.id) : undefined })),
    },
  };
}

async function startApp(router) {
  const app = express();
  app.use(router);
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

function fakeRes() {
  return {
    _status: 200,
    _json: null,
    status(code) { this._status = code; return this; },
    json(obj) { this._json = obj; return this; },
  };
}

// 인가요청으로 유효한 (stateCookie, nonce) 한 쌍을 확보한다.
async function getState(base) {
  const authRes = await fetch(`${base}/auth/stub`, { redirect: 'manual' });
  const nonce = new URL(authRes.headers.get('location')).searchParams.get('state');
  const stateCookie = parseSetCookies(authRes).byo_state.value;
  return { nonce, stateCookie };
}

function makeRouter(store, extra = {}) {
  return createOAuthRouter({
    store,
    secret: SECRET,
    providers: makeProvider(extra.parseUser),
    fetchImpl: extra.fetchImpl || makeFetch([]),
    callbackBaseUrl: 'http://127.0.0.1:9999',
    ...(extra.stateTtlSec != null ? { stateTtlSec: extra.stateTtlSec } : {}),
  });
}

// ====================================================================
// (1) 세션 토큰 위조 — 전부 null
// ====================================================================

test('redteam(1): payload 교체 후 서명 유지 → null', () => {
  const token = session.createSessionToken({ id: 'victim', provider: 'stub' }, SECRET, 60);
  const sig = token.slice(token.indexOf('.') + 1);
  // 공격자가 payload 를 권한상승용으로 갈아끼우고 원본 서명을 재사용.
  const forgedSeg = Buffer.from(
    JSON.stringify({ id: 'attacker', provider: 'stub', exp: 9999999999 })
  ).toString('base64url');
  const forged = `${forgedSeg}.${sig}`;
  assert.strictEqual(session.verifySessionToken(forged, SECRET), null);
});

test('redteam(1): 서명 비트플립 → null', () => {
  const token = session.createSessionToken({ id: 'acc_1' }, SECRET, 60);
  const dot = token.indexOf('.');
  const seg = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const last = sig.slice(-1);
  const flipped = `${seg}.${sig.slice(0, -1)}${last === 'A' ? 'B' : 'A'}`;
  assert.notStrictEqual(flipped, token);
  assert.strictEqual(session.verifySessionToken(flipped, SECRET), null);
});

test('redteam(1): 빈 서명(alg-none 유사) → null', () => {
  // HMAC 전용 스킴이라 JWT 식 alg 헤더가 없다. 공격자가 서명 없는 토큰을 위조해도 거부됨을 확인.
  const seg = Buffer.from(JSON.stringify({ id: 'attacker', exp: 9999999999 })).toString('base64url');
  // 빈 서명 세그먼트는 형식 검증(끝이 '.')에서 차단.
  assert.strictEqual(session.verifySessionToken(`${seg}.`, SECRET), null);
  // base64url('') 도 길이 불일치로 차단.
  const emptySig = Buffer.from('').toString('base64url');
  assert.strictEqual(session.verifySessionToken(`${seg}.${emptySig}`, SECRET), null);
});

test('redteam(1): 공격자 시크릿으로 서명 → null', () => {
  // 공격자가 자기 시크릿으로 유효 형식 토큰을 발급해도 서버 시크릿 검증을 통과 못한다.
  const forged = session.createSessionToken({ id: 'attacker' }, 'attacker-secret', 60);
  assert.strictEqual(session.verifySessionToken(forged, SECRET), null);
});

test('redteam(1): 비-HMAC echo 서명 → null', () => {
  // 서명 자리에 payload 세그먼트를 그대로 복사(naive 검증 우회 시도) → null.
  const seg = Buffer.from(JSON.stringify({ id: 'attacker', exp: 9999999999 })).toString('base64url');
  assert.strictEqual(session.verifySessionToken(`${seg}.${seg}`, SECRET), null);
});

// ====================================================================
// (2) state nonce — replay / 만료 / 교차세션
// ====================================================================

test('redteam(2): state 1회용 — 콜백 후 무효화, 동일 흐름 재사용 거부', async () => {
  const { store } = freshStore();
  const calls = [];
  const router = makeRouter(store, { fetchImpl: makeFetch(calls) });
  const { server, base } = await startApp(router);
  try {
    const { nonce, stateCookie } = await getState(base);
    // 1회차 콜백 — 성공(302) + state 쿠키 무효화(Max-Age=0).
    const first = await fetch(`${base}/auth/stub/callback?code=abc&state=${nonce}`, {
      redirect: 'manual',
      headers: { cookie: `byo_state=${stateCookie}` },
    });
    assert.strictEqual(first.status, 302);
    const cleared = parseSetCookies(first).byo_state;
    assert.ok(cleared, 'state 쿠키 무효화 헤더가 있어야 함');
    assert.match(cleared.raw, /Max-Age=0/);
    assert.strictEqual(cleared.value, '');
    // 2회차(브라우저는 무효화된 빈 쿠키를 보냄) → state payload 없음 → 400.
    const replay = await fetch(`${base}/auth/stub/callback?code=abc&state=${nonce}`, {
      redirect: 'manual',
      headers: { cookie: `byo_state=${cleared.value}` },
    });
    assert.strictEqual(replay.status, 400);
    // 쿠키 자체를 아예 누락한 재시도도 거부.
    const noCookie = await fetch(`${base}/auth/stub/callback?code=abc&state=${nonce}`, {
      redirect: 'manual',
    });
    assert.strictEqual(noCookie.status, 400);
  } finally {
    server.close();
  }
});

test('redteam(2): 만료된 state 거부(400)', async () => {
  const { store } = freshStore();
  // stateTtlSec=0 → 발급 즉시 exp 가 현재 시각, verify 시 만료.
  const router = makeRouter(store, { stateTtlSec: 0 });
  const { server, base } = await startApp(router);
  try {
    const { nonce, stateCookie } = await getState(base);
    const res = await fetch(`${base}/auth/stub/callback?code=abc&state=${nonce}`, {
      redirect: 'manual',
      headers: { cookie: `byo_state=${stateCookie}` },
    });
    assert.strictEqual(res.status, 400);
  } finally {
    server.close();
  }
});

test('redteam(2): 교차세션 state(쿠키A + nonceB) 거부(400)', async () => {
  const { store } = freshStore();
  const router = makeRouter(store);
  const { server, base } = await startApp(router);
  try {
    const a = await getState(base);
    const b = await getState(base);
    assert.notStrictEqual(a.nonce, b.nonce);
    // 세션 A 의 쿠키에 세션 B 의 nonce 를 끼워넣어 콜백 → nonce 불일치로 거부.
    const res = await fetch(`${base}/auth/stub/callback?code=abc&state=${b.nonce}`, {
      redirect: 'manual',
      headers: { cookie: `byo_state=${a.stateCookie}` },
    });
    assert.strictEqual(res.status, 400);
  } finally {
    server.close();
  }
});

// ====================================================================
// (3) callback code 누락/빈값 + redirect_uri 주입(오픈리다이렉트 방어)
// ====================================================================

test('redteam(3): code 누락/빈값 → 400', async () => {
  const { store } = freshStore();
  const router = makeRouter(store);
  const { server, base } = await startApp(router);
  try {
    // code 파라미터 자체가 없는 콜백.
    const s1 = await getState(base);
    const missing = await fetch(`${base}/auth/stub/callback?state=${s1.nonce}`, {
      redirect: 'manual',
      headers: { cookie: `byo_state=${s1.stateCookie}` },
    });
    assert.strictEqual(missing.status, 400);
    // code 가 빈 문자열인 콜백.
    const s2 = await getState(base);
    const empty = await fetch(`${base}/auth/stub/callback?code=&state=${s2.nonce}`, {
      redirect: 'manual',
      headers: { cookie: `byo_state=${s2.stateCookie}` },
    });
    assert.strictEqual(empty.status, 400);
  } finally {
    server.close();
  }
});

test('redteam(3): 공격자 redirect_uri 주입 무시 — 오픈리다이렉트 방어', async () => {
  const { store } = freshStore();
  const calls = [];
  const router = makeRouter(store, { fetchImpl: makeFetch(calls) });
  const { server, base } = await startApp(router);
  try {
    const { nonce, stateCookie } = await getState(base);
    const evil = 'https://evil.example/steal';
    const res = await fetch(
      `${base}/auth/stub/callback?code=abc&state=${nonce}&redirect_uri=${encodeURIComponent(evil)}`,
      { redirect: 'manual', headers: { cookie: `byo_state=${stateCookie}` } }
    );
    // 최종 리다이렉트는 항상 서버 제어 '/' — 공격자 URL 로 가지 않는다.
    assert.strictEqual(res.status, 302);
    assert.strictEqual(res.headers.get('location'), '/');
    // 토큰교환 body 의 redirect_uri 도 서버가 구성한 콜백 URL 이어야 한다.
    const tokenCall = calls.find((c) => c.url === 'https://stub.example/token');
    assert.ok(tokenCall, '토큰교환 호출이 있어야 함');
    assert.match(tokenCall.opts.body, /redirect_uri=http/);
    assert.ok(!tokenCall.opts.body.includes('evil.example'), '공격자 redirect_uri 가 토큰교환에 반영되면 안 됨');
    assert.match(decodeURIComponent(tokenCall.opts.body), /\/auth\/stub\/callback/);
  } finally {
    server.close();
  }
});

// ====================================================================
// (4) 토큰교환 200+필드 누락 / 손상 JSON / parseUser subject 누락 → 502
// ====================================================================

test('redteam(4): 토큰교환 200 이나 access_token 누락 → 502', async () => {
  const { store } = freshStore();
  const router = makeRouter(store, {
    fetchImpl: makeFetch([], { token: () => jsonResponse(200, { token_type: 'bearer' }) }),
  });
  const { server, base } = await startApp(router);
  try {
    const { nonce, stateCookie } = await getState(base);
    const res = await fetch(`${base}/auth/stub/callback?code=abc&state=${nonce}`, {
      redirect: 'manual',
      headers: { cookie: `byo_state=${stateCookie}` },
    });
    assert.strictEqual(res.status, 502);
  } finally {
    server.close();
  }
});

test('redteam(4): 토큰교환 손상 JSON(파싱 throw) → 502', async () => {
  const { store } = freshStore();
  const router = makeRouter(store, {
    fetchImpl: makeFetch([], { token: () => corruptJsonResponse(200) }),
  });
  const { server, base } = await startApp(router);
  try {
    const { nonce, stateCookie } = await getState(base);
    const res = await fetch(`${base}/auth/stub/callback?code=abc&state=${nonce}`, {
      redirect: 'manual',
      headers: { cookie: `byo_state=${stateCookie}` },
    });
    assert.strictEqual(res.status, 502);
  } finally {
    server.close();
  }
});

test('redteam(4): 유저 응답 손상 JSON → 502', async () => {
  const { store } = freshStore();
  const router = makeRouter(store, {
    fetchImpl: makeFetch([], { user: () => corruptJsonResponse(200) }),
  });
  const { server, base } = await startApp(router);
  try {
    const { nonce, stateCookie } = await getState(base);
    const res = await fetch(`${base}/auth/stub/callback?code=abc&state=${nonce}`, {
      redirect: 'manual',
      headers: { cookie: `byo_state=${stateCookie}` },
    });
    assert.strictEqual(res.status, 502);
  } finally {
    server.close();
  }
});

test('redteam(4): parseUser subject 누락 → 502', async () => {
  const { store } = freshStore();
  // 유저 응답에 id 가 없어 parseUser 가 falsy subject 를 반환.
  const router = makeRouter(store, {
    fetchImpl: makeFetch([], { user: () => jsonResponse(200, { login: 'no-id-here' }) }),
  });
  const { server, base } = await startApp(router);
  try {
    const { nonce, stateCookie } = await getState(base);
    const res = await fetch(`${base}/auth/stub/callback?code=abc&state=${nonce}`, {
      redirect: 'manual',
      headers: { cookie: `byo_state=${stateCookie}` },
    });
    assert.strictEqual(res.status, 502);
    // 계정이 생성되면 안 된다(부분 인증 금지).
    const cookies = parseSetCookies(res);
    assert.ok(!cookies.byo_sess, '세션 쿠키가 발급되면 안 됨');
  } finally {
    server.close();
  }
});

// ====================================================================
// (5) requireSession — 401 경로
// ====================================================================

test('redteam(5): requireSession 쿠키 없음 → 401', () => {
  const mw = session.requireSession(SECRET);
  const res = fakeRes();
  let nexted = false;
  mw({ headers: {} }, res, () => { nexted = true; });
  assert.strictEqual(nexted, false);
  assert.strictEqual(res._status, 401);
});

test('redteam(5): requireSession 깨진 쿠키 → 401', () => {
  const mw = session.requireSession(SECRET);
  for (const bad of ['garbage', 'no.dot.here', 'a.b', 'A.B.C']) {
    const res = fakeRes();
    let nexted = false;
    mw({ headers: { cookie: `byo_sess=${bad}` } }, res, () => { nexted = true; });
    assert.strictEqual(nexted, false, `깨진 쿠키 통과: ${bad}`);
    assert.strictEqual(res._status, 401);
  }
});

test('redteam(5): requireSession 만료 세션 → 401', () => {
  const mw = session.requireSession(SECRET);
  const expired = session.createSessionToken({ id: 'acc_1' }, SECRET, -1);
  const res = fakeRes();
  let nexted = false;
  mw({ headers: { cookie: `byo_sess=${expired}` } }, res, () => { nexted = true; });
  assert.strictEqual(nexted, false);
  assert.strictEqual(res._status, 401);
});

test('redteam(5): requireSession id 없는 유효서명 payload → 401', () => {
  // 서명은 유효하지만 id 가 없는 payload(예: state 토큰 재사용) 는 세션으로 인정 안 함.
  const mw = session.requireSession(SECRET);
  const noId = session.createSessionToken({ provider: 'stub' }, SECRET, 60);
  const res = fakeRes();
  let nexted = false;
  mw({ headers: { cookie: `byo_sess=${noId}` } }, res, () => { nexted = true; });
  assert.strictEqual(nexted, false);
  assert.strictEqual(res._status, 401);
  // state 토큰(nonce 만 있음)도 세션으로 통과 못함.
  const stateTok = session.createStateToken('n', SECRET, 60);
  const res2 = fakeRes();
  let nexted2 = false;
  mw({ headers: { cookie: `byo_sess=${stateTok}` } }, res2, () => { nexted2 = true; });
  assert.strictEqual(nexted2, false);
  assert.strictEqual(res2._status, 401);
});

// ====================================================================
// (6) 쿠키 파싱 엣지
// ====================================================================

test('redteam(6): readCookie — 값에 = 포함 시 첫 = 만 분리', () => {
  // base64url 토큰에는 = 가 없지만, 방어적으로 값 내부 = 보존을 확인.
  const req = { headers: { cookie: 'byo_sess=a=b=c; other=1' } };
  assert.strictEqual(session.readCookie(req, 'byo_sess'), 'a=b=c');
});

test('redteam(6): readCookie — 중복 쿠키는 첫 값 반환', () => {
  const req = { headers: { cookie: 'byo_sess=first; byo_sess=second' } };
  assert.strictEqual(session.readCookie(req, 'byo_sess'), 'first');
});

test('redteam(6): readCookie — 공백/세미콜론 분리 및 미존재 처리', () => {
  const req = { headers: { cookie: '  a=1 ;  byo_sess=v9  ; b=2' } };
  assert.strictEqual(session.readCookie(req, 'byo_sess'), 'v9');
  assert.strictEqual(session.readCookie(req, 'missing'), null);
  // 헤더 자체가 없거나 비정상 타입.
  assert.strictEqual(session.readCookie({ headers: {} }, 'byo_sess'), null);
  assert.strictEqual(session.readCookie({}, 'byo_sess'), null);
  assert.strictEqual(session.readCookie({ headers: { cookie: 123 } }, 'byo_sess'), null);
});
