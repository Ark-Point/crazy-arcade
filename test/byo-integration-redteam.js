'use strict';

// G008(S8) red-team: 마운트된 HTTP 인증 표면(keys-api/OAuth) + 폐기→소켓종료 통합을
// 적대적으로 깬다. byo-integration.js 의 happy-path 를 보완해, 위조/경합/혼재/방어
// 실패모드를 실 HTTP + 실 /agent 소켓으로 검증한다. 제품 코드는 수정하지 않는다.
//
// 케이스:
//  (1) 위조 세션 쿠키(잘못된 서명 / 만료 / id 없음) → keys-api 401.
//  (2) 폐기 경합 — 같은 키 다중 소켓 연결 후 HTTP DELETE → 전부 즉시 disconnect,
//      폐기와 동시 재접속은 거부(키 캡 또는 폐기 사유).
//  (3) 정적 경로와 /auth·/account 비충돌 — 정적 GET 정상, 미소유 /account 는 401,
//      알 수 없는 라우트 404.
//  (4) OAuth 콜백 state 불일치/재생(쿠키 부재) → 400(토큰 교환 이전 거부, 네트워크 불필요).
//  (5) keys-api express.json 방어 — 과도 페이로드 413, 비(非)JSON body 400.
//  (6) 토큰 초대 에이전트 + apiKey 에이전트 혼재 시 폐기는 apiKey 소켓만 끊고
//      토큰 소켓은 유지(disconnected=1).

const { test, before, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');

const {
  startServer,
  stopServer,
  closeAll,
  connectAgent,
  connectAgentWithKey,
  expectAgentKeyRejected,
  expectDisconnect,
  connectHuman,
  createRoomWithAgentInvite,
  signSessionCookie,
  httpJson,
  issueKeyViaHttp,
  revokeKeyViaHttp,
} = require('./helpers/agent-harness');
const { createStore } = require('../server/auth/store');
const {
  createSessionToken,
  createStateToken,
  SESSION_COOKIE,
  STATE_COOKIE,
} = require('../server/auth/session');

const SESSION_SECRET = 'redteam-integration-secret-0123456789';
const WRONG_SECRET = 'redteam-WRONG-secret-9876543210abcdef';

let url = null;
let tmpDir = null;
let storePath = null;
let account = null;
let sessionCookie = null;

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// 임의 메서드/헤더/본문 raw HTTP 요청(httpJson 은 항상 JSON 직렬화/파싱이라 부적합한 케이스용).
async function rawRequest(baseUrl, pathPart, { method = 'GET', headers = {}, body } = {}) {
  const res = await fetch(`${baseUrl}${pathPart}`, { method, headers, body });
  let textBody = '';
  try {
    textBody = await res.text();
  } catch {
    textBody = '';
  }
  return { status: res.status, text: textBody };
}

before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'byo-redteam-'));
  storePath = path.join(tmpDir, 'byo-store.json');
  const store = createStore(storePath);
  account = await store.upsertAccount({ provider: 'test', subject: 'redteam-user' });

  // 같은 store + 같은 SESSION_SECRET 으로 spawn. OAuth provider(github)를 env 로 활성화해
  // 마운트된 실 OAuth 라우터의 콜백 state 검증을 적대 테스트할 수 있게 한다.
  process.env.BYO_KEY_STORE_PATH = storePath;
  process.env.SESSION_SECRET = SESSION_SECRET;
  process.env.OAUTH_GITHUB_CLIENT_ID = 'redteam-client-id';
  process.env.OAUTH_GITHUB_CLIENT_SECRET = 'redteam-client-secret';
  url = (await startServer()).url;

  sessionCookie = signSessionCookie(
    { id: account.id, provider: account.provider, subject: account.subject },
    SESSION_SECRET
  );
});

after(async () => {
  closeAll();
  stopServer();
  delete process.env.BYO_KEY_STORE_PATH;
  delete process.env.SESSION_SECRET;
  delete process.env.OAUTH_GITHUB_CLIENT_ID;
  delete process.env.OAUTH_GITHUB_CLIENT_SECRET;
  if (tmpDir) {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* best-effort 정리 */
    }
  }
});

// 각 테스트가 만든 소켓을 정리하고 서버가 connGuard 슬롯을 release 하도록 잠깐 대기.
afterEach(async () => {
  closeAll();
  await delay(150);
});

test('(1) 위조 세션 쿠키(서명오류/만료/id없음)는 keys-api 에서 401', async () => {
  // 1a) 잘못된 서명: 올바른 페이로드를 WRONG_SECRET 으로 서명 → 검증 실패.
  const badSigCookie = signSessionCookie(
    { id: account.id, provider: account.provider, subject: account.subject },
    WRONG_SECRET
  );
  const badSig = await httpJson(url, '/account/keys', { method: 'GET', cookie: badSigCookie });
  assert.equal(badSig.status, 401, `잘못된 서명 쿠키는 401 이어야 함(got ${badSig.status})`);
  assert.equal(badSig.body && badSig.body.ok, false, '401 본문은 {ok:false}');

  // 1b) 서명 변조: 올바른 토큰의 시그니처 1바이트를 바꿔 timingSafeEqual 실패.
  const validToken = createSessionToken(
    { id: account.id, provider: account.provider, subject: account.subject },
    SESSION_SECRET,
    3600
  );
  const dot = validToken.indexOf('.');
  const seg = validToken.slice(0, dot);
  const sig = validToken.slice(dot + 1);
  const flipped = (sig[0] === 'A' ? 'B' : 'A') + sig.slice(1);
  const tamperedCookie = `${SESSION_COOKIE}=${seg}.${flipped}`;
  const tampered = await httpJson(url, '/account/keys', { method: 'GET', cookie: tamperedCookie });
  assert.equal(tampered.status, 401, `서명 변조 쿠키는 401 이어야 함(got ${tampered.status})`);

  // 1c) 만료: 음수 ttl 로 exp 를 과거로 → 서명은 유효하나 만료로 거부.
  const expiredCookie = signSessionCookie(
    { id: account.id, provider: account.provider, subject: account.subject },
    SESSION_SECRET,
    -10
  );
  const expired = await httpJson(url, '/account/keys', { method: 'GET', cookie: expiredCookie });
  assert.equal(expired.status, 401, `만료 쿠키는 401 이어야 함(got ${expired.status})`);

  // 1d) id 없음: 서명은 유효하나 payload.id 부재 → requireSession 의 !payload.id 거부.
  const noIdCookie = signSessionCookie(
    { provider: account.provider, subject: account.subject },
    SESSION_SECRET
  );
  const noId = await httpJson(url, '/account/keys', { method: 'GET', cookie: noIdCookie });
  assert.equal(noId.status, 401, `id 없는 쿠키는 401 이어야 함(got ${noId.status})`);

  // 위조 쿠키로는 폐기(DELETE)도 401(쓰기 경로 보호 확인).
  const writeAttempt = await httpJson(url, '/account/keys/whatever', {
    method: 'DELETE',
    cookie: badSigCookie,
  });
  assert.equal(writeAttempt.status, 401, `위조 쿠키 DELETE 도 401 이어야 함(got ${writeAttempt.status})`);
});

test('(2) 폐기 경합 — 다중 소켓 즉시 disconnect + 동시 재접속 거부', async () => {
  const issued = await issueKeyViaHttp(url, sessionCookie, 'race key');
  assert.equal(issued.status, 201, `키 발급 201(got ${issued.status})`);
  const apiKey = issued.body.key;
  const keyId = issued.body.record.id;

  // keyCap=2(BYO_MAX_CONNS_PER_KEY 기본) — 같은 키로 2 소켓 연결.
  const { agent: a1 } = await connectAgentWithKey(url, apiKey, 'race-a1');
  const { agent: a2 } = await connectAgentWithKey(url, apiKey, 'race-a2');
  assert.equal(a1.connected, true, 'a1 연결됨');
  assert.equal(a2.connected, true, 'a2 연결됨');

  // 폐기와 '동시에' 재접속을 시도한다. 두 라이브 소켓이 아직 keyCap 을 채우고 있고
  // store 가 곧 revoked 가 되므로, 경합 재접속은 어떤 타이밍이든 반드시 거부된다
  // (키 캡 초과 또는 폐기 사유). 즉, 폐기 창에서 새 소켓이 살아남을 수 없다.
  const disc1 = expectDisconnect(a1, 'a1 revoke disconnect');
  const disc2 = expectDisconnect(a2, 'a2 revoke disconnect');
  const revokePromise = revokeKeyViaHttp(url, sessionCookie, keyId);
  const racingReject = expectAgentKeyRejected(url, apiKey, 'concurrent reconnect during revoke');

  const [del, raceMsg] = await Promise.all([revokePromise, racingReject]);
  assert.equal(del.status, 200, `폐기 200(got ${del.status})`);
  assert.equal(del.body.revoked, true, '폐기 revoked=true');
  assert.equal(del.body.disconnected, 2, `라이브 소켓 2개 강제 종료(got ${del.body.disconnected})`);
  assert.ok(
    raceMsg === 'invalid or revoked api key' || raceMsg === 'too many connections for key',
    `경합 재접속은 거부되어야 함(got "${raceMsg}")`
  );

  await Promise.all([disc1, disc2]);
  assert.equal(a1.connected, false, 'a1 끊김');
  assert.equal(a2.connected, false, 'a2 끊김');

  // 폐기 완료 후의 재접속은 명확히 'invalid or revoked api key'.
  const postMsg = await expectAgentKeyRejected(url, apiKey, 'post-revoke reconnect');
  assert.equal(postMsg, 'invalid or revoked api key', `폐기 후 재접속 거부 사유(got "${postMsg}")`);
});

test('(3) 정적 경로와 /auth·/account 비충돌', async () => {
  // 기존 정적 파일 GET 정상(라우터 마운트가 정적 서빙을 가리지 않음).
  const staticRes = await rawRequest(url, '/catalog.js', { method: 'GET' });
  assert.equal(staticRes.status, 200, `정적 /catalog.js 는 200 이어야 함(got ${staticRes.status})`);
  assert.ok(staticRes.text.length > 0, '정적 파일 본문이 비어있지 않아야 함');

  const indexRes = await rawRequest(url, '/index.html', { method: 'GET' });
  assert.equal(indexRes.status, 200, `정적 /index.html 는 200 이어야 함(got ${indexRes.status})`);

  // /account/* 는 정적이 아니라 라우터가 가로채 401(세션 없음) — 정적 404 가 아니다.
  const accountRes = await httpJson(url, '/account/keys', { method: 'GET' });
  assert.equal(accountRes.status, 401, `세션 없는 /account/keys 는 401(got ${accountRes.status})`);

  // 마운트된 keys 라우터의 requireSession 은 '/' 게이트라, 세션 없는 미지의 라우트는
  // 정적 404 가 아니라 401 로 가로채인다(인증 표면이 정적과 충돌하지 않음의 증거).
  const unknownNoSession = await rawRequest(url, '/totally-unknown-route-xyz', { method: 'GET' });
  assert.equal(unknownNoSession.status, 401, `세션 없는 미지의 라우트는 401 게이트(got ${unknownNoSession.status})`);

  // 유효 세션이면 게이트를 통과하지만 매칭 라우트가 없어 404 로 떨어진다.
  const unknown = await rawRequest(url, '/totally-unknown-route-xyz', {
    method: 'GET',
    headers: { Cookie: sessionCookie },
  });
  assert.equal(unknown.status, 404, `세션 있는 미지의 라우트는 404(got ${unknown.status})`);

  const unknownAccount = await httpJson(url, '/account/does-not-exist', {
    method: 'GET',
    cookie: sessionCookie,
  });
  assert.equal(unknownAccount.status, 404, `세션 있어도 미지의 /account 하위는 404(got ${unknownAccount.status})`);
});

test('(4) OAuth 콜백 state 불일치/재생은 400(토큰 교환 이전 거부)', async () => {
  // 4a) state 쿠키 부재 + 쿼리 state 존재 → 400. (마운트된 실 github 라우터)
  const noCookie = await rawRequest(url, '/auth/github/callback?state=abc&code=xyz', { method: 'GET' });
  assert.equal(noCookie.status, 400, `state 쿠키 부재 콜백은 400(got ${noCookie.status})`);

  // 4b) state 쿠키 nonce 와 쿼리 state 불일치(재생/위조) → 400. 네트워크 호출 없음.
  const stateToken = createStateToken('nonce-AAAA', SESSION_SECRET, 600);
  const mismatch = await rawRequest(url, '/auth/github/callback?state=nonce-BBBB&code=xyz', {
    method: 'GET',
    headers: { Cookie: `${STATE_COOKIE}=${stateToken}` },
  });
  assert.equal(mismatch.status, 400, `state 불일치 콜백은 400(got ${mismatch.status})`);

  // 4c) 잘못된 시크릿으로 서명한 state 쿠키(검증 실패) → 400.
  const forgedState = createStateToken('nonce-CCCC', WRONG_SECRET, 600);
  const forged = await rawRequest(url, '/auth/github/callback?state=nonce-CCCC&code=xyz', {
    method: 'GET',
    headers: { Cookie: `${STATE_COOKIE}=${forgedState}` },
  });
  assert.equal(forged.status, 400, `위조 서명 state 쿠키 콜백은 400(got ${forged.status})`);

  // 미설정 provider 콜백은 404(존재하지 않는 provider).
  const noProvider = await rawRequest(url, '/auth/nope/callback?state=x&code=y', { method: 'GET' });
  assert.equal(noProvider.status, 404, `미설정 provider 콜백은 404(got ${noProvider.status})`);
});

test('(5) keys-api express.json 방어 — 과도 페이로드 413, 비JSON body 400', async () => {
  // 5a) 과도 페이로드: 100kb 기본 한도를 넘는 JSON → 413(Payload Too Large).
  const huge = JSON.stringify({ label: 'x'.repeat(200000) });
  const oversized = await rawRequest(url, '/account/keys', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: sessionCookie },
    body: huge,
  });
  assert.equal(oversized.status, 413, `과도 페이로드는 413(got ${oversized.status})`);

  // 5b) 비(非)JSON body + application/json → 파싱 실패 400(SyntaxError, 키 발급 도달 전 거부).
  const badJson = await rawRequest(url, '/account/keys', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: sessionCookie },
    body: '{ this is : not json,,, }}}',
  });
  assert.equal(badJson.status, 400, `비JSON body 는 400(got ${badJson.status})`);

  // 방어가 정상 발급을 막지 않는지 음성대조: 올바른 JSON 은 201.
  const ok = await issueKeyViaHttp(url, sessionCookie, 'sanity key');
  assert.equal(ok.status, 201, `정상 JSON 발급은 201(got ${ok.status})`);
  // 정리: 방금 발급한 키 폐기(누수 방지).
  await revokeKeyViaHttp(url, sessionCookie, ok.body.record.id);
});

test('(6) 토큰 에이전트 + apiKey 에이전트 혼재 — 폐기는 apiKey 소켓만 끊는다', async () => {
  // 토큰 초대 에이전트: 휴먼 호스트가 방+초대 생성 → 토큰으로 /agent 접속.
  const host = await connectHuman(url);
  const { invite } = await createRoomWithAgentInvite(host, {
    nick: 'RTHost',
    roomName: 'mixed room',
    invite: { nick: 'TokenBot', char: 1 },
  });
  assert.equal(typeof invite.token, 'string', '초대 토큰이 발급되어야 함');
  const tokenAgent = await connectAgent(url, invite.token, 'token-agent');
  assert.equal(tokenAgent.connected, true, '토큰 에이전트 연결됨');

  // apiKey 에이전트.
  const issued = await issueKeyViaHttp(url, sessionCookie, 'mixed key');
  assert.equal(issued.status, 201, `키 발급 201(got ${issued.status})`);
  const apiKey = issued.body.key;
  const keyId = issued.body.record.id;
  const { agent: keyAgent } = await connectAgentWithKey(url, apiKey, 'key-agent');
  assert.equal(keyAgent.connected, true, 'apiKey 에이전트 연결됨');

  // apiKey 폐기 → apiKey 소켓만 끊긴다(disconnected=1). 토큰 소켓(keyId 없음)은 영향 없음.
  const keyDisc = expectDisconnect(keyAgent, 'apiKey agent revoke disconnect');
  const del = await revokeKeyViaHttp(url, sessionCookie, keyId);
  assert.equal(del.status, 200, `폐기 200(got ${del.status})`);
  assert.equal(del.body.disconnected, 1, `apiKey 소켓 1개만 끊겨야 함(got ${del.body.disconnected})`);

  await keyDisc;
  assert.equal(keyAgent.connected, false, 'apiKey 에이전트는 끊김');

  // 토큰 에이전트는 폐기와 무관하게 유지. 잠깐 대기 후에도 연결 상태.
  await delay(200);
  assert.equal(tokenAgent.connected, true, '토큰 에이전트는 폐기 영향 없이 유지되어야 함');
});
